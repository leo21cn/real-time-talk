"""
DashScope TTS 语音合成引擎
"""
import asyncio
import logging
import os
from pathlib import Path
from typing import Tuple

import httpx

from server.config import get_config

logger = logging.getLogger(__name__)

# 全局 TTS 并发限制（避免 DashScope 429 限流）
_TTS_SEMAPHORE = asyncio.Semaphore(3)


class TtsError(Exception):
    """TTS 合成错误"""
    pass


# DashScope TTS API 端点（多模态生成接口，兼容 Qwen-TTS / CosyVoice）
DASHSCOPE_TTS_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
DASHSCOPE_TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"

# voice → model 映射（不同音色绑定不同模型）
VOICE_MODEL_MAP = {
    "Cherry": "qwen3-tts-flash",
    "Stella": "qwen3-tts-flash",
    "longanyang": "cosyvoice-v3-flash",
    "longxiaoxia": "cosyvoice-v3-flash",
}


class TtsEngine:
    """DashScope TTS 语音合成引擎"""

    def __init__(self):
        cfg = get_config()
        self.api_key = cfg["tts"]["api_key"]
        self.voice = cfg["tts"]["voice"]
        self.speed = cfg["tts"]["speed"]
        self.model = VOICE_MODEL_MAP.get(self.voice, "qwen3-tts-flash")
        self.timeout = httpx.Timeout(120.0, connect=10.0)

    async def synthesize(self, text: str, session_id: str, segment_index: int) -> Tuple[str, int]:
        """
        合成语音，返回 (mp3_file_path, duration_ms)。
        使用全局信号量限制并发，避免 API 限流。

        Args:
            text: 待合成的文本
            session_id: 会话 ID（用于文件路径）
            segment_index: 段落序号

        Returns:
            (音频文件路径, 时长毫秒)

        Raises:
            TtsError: 合成失败
        """
        work_dir = Path(f"_work/{session_id}")
        work_dir.mkdir(parents=True, exist_ok=True)

        output_path = work_dir / f"segment_{segment_index}.mp3"

        # 获取信号量，限制并发 TTS 请求
        async with _TTS_SEMAPHORE:
            # 如果文本超过 450 字，需要拆分后分段合成再拼接
            if len(text) > 450:
                return await self._synthesize_long(text, output_path)

            return await self._synthesize_single(text, str(output_path))

    async def _synthesize_single(self, text: str, output_path: str) -> Tuple[str, int]:
        """合成单段文本（≤450 字），使用多模态生成接口"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "disable",
        }

        # Qwen-TTS / CosyVoice 统一使用多模态生成接口
        payload = {
            "model": self.model,
            "input": {
                "text": text,
                "voice": self.voice,
            },
            "parameters": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": self.speed,
            },
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            # Step 1: 提交合成任务
            submit_resp = await client.post(DASHSCOPE_TTS_URL, json=payload, headers=headers)
            if submit_resp.status_code != 200:
                error = self._parse_error(submit_resp)
                raise TtsError(f"TTS 任务提交失败: {error}")

            submit_data = submit_resp.json()
            # 多模态生成接口返回 task_id 在 output.task_id
            task_id = submit_data.get("output", {}).get("task_id", "")
            if not task_id:
                # 也可能直接返回结果（非异步模式），尝试直接取 audio url
                audio_url = submit_data.get("output", {}).get("audio", {}).get("url", "")
                if audio_url:
                    # 下载音频文件（强制 HTTPS，避免 HTTP 被 OSS 拒绝）
                    if audio_url.startswith('http://'):
                        audio_url = 'https://' + audio_url[7:]
                    audio_resp = await client.get(audio_url)
                    if audio_resp.status_code != 200:
                        raise TtsError(f"TTS 音频下载失败: HTTP {audio_resp.status_code}")
                    with open(output_path, "wb") as f:
                        f.write(audio_resp.content)
                    file_size = len(audio_resp.content)
                    duration_ms = int(file_size * 8 / 128000 * 1000)
                    logger.info(f"TTS 合成完成(同步): {output_path}, 时长 ~{duration_ms}ms")
                    return output_path, max(duration_ms, 1000)
                raise TtsError(f"TTS 未返回 task_id: {submit_data}")

            # Step 2: 轮询获取结果
            result_url = DASHSCOPE_TASK_URL.format(task_id=task_id)
            for _ in range(60):  # 最多等 60 次（每次 1s）
                await asyncio.sleep(1)
                result_resp = await client.get(result_url, headers=headers)
                if result_resp.status_code != 200:
                    continue

                result_data = result_resp.json()
                task_status = result_data.get("output", {}).get("task_status", "")
                if task_status == "SUCCEEDED":
                    audio_url = result_data.get("output", {}).get("results", {}).get("audio", {}).get("url", "") or \
                                result_data.get("output", {}).get("audio", {}).get("url", "")
                    if not audio_url:
                        raise TtsError("TTS 完成但未返回音频 URL")

                    # 下载音频文件（强制 HTTPS，避免 HTTP 被 OSS 拒绝）
                    if audio_url.startswith('http://'):
                        audio_url = 'https://' + audio_url[7:]
                    audio_resp = await client.get(audio_url)
                    if audio_resp.status_code != 200:
                        raise TtsError(f"TTS 音频下载失败: HTTP {audio_resp.status_code}")

                    with open(output_path, "wb") as f:
                        f.write(audio_resp.content)

                    # 估算时长（MP3 码率约 128kbps → 粗略估算）
                    file_size = len(audio_resp.content)
                    duration_ms = int(file_size * 8 / 128000 * 1000)

                    logger.info(f"TTS 合成完成: {output_path}, 时长 ~{duration_ms}ms")
                    return output_path, max(duration_ms, 1000)

                elif task_status == "FAILED":
                    error_msg = result_data.get("output", {}).get("message", "未知错误")
                    raise TtsError(f"TTS 合成失败: {error_msg}")

                # PENDING / RUNNING → 继续等待

            raise TtsError("TTS 合成超时（等待 60s）")

    async def _synthesize_long(self, text: str, output_path: Path) -> Tuple[str, int]:
        """
        长文本处理：按句子边界拆分为 ≤450 字的段落，
        分别合成后拼接为一个 MP3 文件。
        """
        # 简单按句子拆分
        sentences = []
        current = ""
        for char in text:
            current += char
            if char in "。！？；" and len(current) >= 100:
                sentences.append(current)
                current = ""
        if current:
            sentences.append(current)

        # 合并短句
        chunks = []
        chunk = ""
        for s in sentences:
            if len(chunk) + len(s) > 450:
                if chunk:
                    chunks.append(chunk)
                chunk = s
            else:
                chunk += s
        if chunk:
            chunks.append(chunk)

        if len(chunks) == 1:
            return await self._synthesize_single(chunks[0], str(output_path))

        # 分段合成
        temp_files = []
        total_duration = 0
        for i, chunk in enumerate(chunks):
            temp_path = output_path.parent / f"temp_{output_path.stem}_{i}.mp3"
            path, dur = await self._synthesize_single(chunk, str(temp_path))
            temp_files.append(path)
            total_duration += dur

        # FFmpeg 拼接
        concat_list = output_path.parent / f"concat_{output_path.stem}.txt"
        concat_list.write_text("\n".join(f"file '{p}'" for p in temp_files))

        # V50: 改用异步 subprocess，避免阻塞 asyncio 事件循环
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy", "-y", str(output_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        if proc.returncode != 0:
            err = stderr.decode()[:200] if stderr else "未知错误"
            raise TtsError(f"TTS 音频拼接失败: {err}")

        # 清理临时文件
        for tf in temp_files:
            Path(tf).unlink(missing_ok=True)
        concat_list.unlink(missing_ok=True)

        return str(output_path), total_duration

    def _parse_error(self, response: httpx.Response) -> str:
        try:
            data = response.json()
            return data.get("message", str(data))
        except Exception:
            return response.text[:200]
