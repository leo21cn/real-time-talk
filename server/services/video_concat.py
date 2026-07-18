"""
FFmpeg 视频切片拼接模块
"""
import asyncio
import logging
import subprocess
from pathlib import Path
from typing import List, Optional

from server.config import get_config

logger = logging.getLogger(__name__)


class VideoConcatError(Exception):
    """视频拼接错误"""
    pass


class VideoConcat:
    """FFmpeg 切片拼接器"""

    def __init__(self):
        cfg = get_config()
        self.clips_dir = Path(cfg["avatar"]["clips_dir"])
        self.webm_dir = self.clips_dir / ".webm"
        self.ffmpeg_path = cfg["ffmpeg"]["path"]
        self.gpu_encoder = cfg["ffmpeg"].get("gpu_encoder", "auto")

    async def concat(
        self,
        labels: List[str],
        audio_path: str,
        target_duration_ms: int,
        session_id: str,
        segment_index: int,
    ) -> str:
        """
        拼接视频切片并混入音频。

        Args:
            labels: 语义标签序列
            audio_path: TTS 生成的 MP3 音频路径
            target_duration_ms: 目标时长（毫秒）
            session_id: 会话 ID
            segment_index: 段落序号

        Returns:
            输出视频文件路径 (.webm)
        """
        work_dir = Path(f"_work/{session_id}")
        work_dir.mkdir(parents=True, exist_ok=True)

        # 1. 根据 labels 选择切片文件
        clip_files = self._select_clips(labels)
        if not clip_files:
            raise VideoConcatError(f"没有找到匹配的切片文件: labels={labels}")

        # V50: 用 ffprobe 获取 TTS MP3 的真实时长（毫秒），替代估算值
        real_duration_ms = await self._get_audio_duration_ms(audio_path)
        if real_duration_ms and abs(real_duration_ms - target_duration_ms) > 500:
            logger.info(f"TTS 时长修正: 估算={target_duration_ms}ms → ffprobe实测={real_duration_ms}ms")
            target_duration_ms = real_duration_ms

        # 2. 生成 concat 文件列表（含时长对齐的重复填充）
        concat_list_path = work_dir / f"concat_list_{segment_index}.txt"
        total_natural_duration = self._build_concat_list(clip_files, target_duration_ms, concat_list_path)
        # V53: 诊断—记录实际拼接的 clip 序列
        try:
            clip_sequence = concat_list_path.read_text(encoding='utf-8').strip()
            logger.info(f"[V53-concat-clips] seg={segment_index} sequence:\n{clip_sequence}")
        except Exception as e:
            logger.warning(f"V53: 读 concat_list 失败: {e}")

        # 3. FFmpeg concat demuxer + 混音
        output_path = str(work_dir / f"output_{segment_index}.webm")

        await self._run_ffmpeg_concat(str(concat_list_path), audio_path, output_path)

        # V52: 输出后校验 — 用 ffprobe 检查实际音频时长，偏差 > 500ms 则用 -t 精确截断
        await self._validate_output_duration(output_path, audio_path, target_duration_ms)

        # 清理 concat 列表
        concat_list_path.unlink(missing_ok=True)
        # V53: 保留诊断副本到 /tmp/concat_logs 供事后分析
        try:
            diag_dir = Path("/tmp/concat_logs")
            diag_dir.mkdir(parents=True, exist_ok=True)
            (diag_dir / f"seg_{segment_index}_{session_id[:8]}.txt").write_text(clip_sequence, encoding='utf-8')
        except Exception:
            pass

        logger.info(f"视频拼接完成: {output_path}")
        logger.info(f"[V51 concat详情] labels={labels} clips={len(clip_files)} "
                    f"target_duration={target_duration_ms}ms real_duration={real_duration_ms}ms "
                    f"session={session_id} seg={segment_index}")
        return output_path

    def _select_clips(self, labels: List[str]) -> List[Path]:
        """根据标签选择切片文件路径"""
        seen = set()  # V48.5: 去重 set，避免同一 clip 多次出现造成视觉重复
        clips = []
        for label in labels:
            clip_path = self.webm_dir / f"{label}.webm"
            if clip_path.exists():
                resolved = clip_path.resolve()
                # V48.5: 只保留首次出现的 clip（去重避免相邻重复）
                if resolved not in seen:
                    seen.add(resolved)
                    clips.append(clip_path)
                else:
                    logger.info(f"标签 {label} 与前面重复，跳过: {clip_path.name}")
            else:
                logger.warning(f"切片文件不存在（跳过）: {clip_path}")
        # V48 fix: 避免单 clip 重复造成“语音死循环”视觉错觉
        # 背景：当 LLM 回答只有 1 个 label（如 'greeting'/'explaining'）且 TTS 时长 > 5s 时，
        # _build_concat_list 会追加 同一个 clip 填充时长，ffmpeg -shortest 截断后
        # 用户看到同一个动作从 0 重复到 7+s，无变化 → “重复说同一句话”。
        # 修复：单 clip 场景下补一个不同的 clip，避免同一 clip 重复拼接。
        if len(clips) == 1:
            # 选择一个与现有 clip 不同的补充 clip（优先选：transition -> introduction）
            for fallback_label in ("transition", "introduction", "emphasis", "listing"):
                fallback_path = self.webm_dir / f"{fallback_label}.webm"
                if fallback_path.exists() and fallback_path.resolve() != clips[0].resolve():
                    clips.append(fallback_path)
                    logger.info(f"单 clip 补充 {fallback_label} 避免重复: {clips[0].name} + {fallback_path.name}")
                    break
        # V48.5: 如果去重后只有 1 个 clip（例如 LLM 返回 3 个相同 label），仍触发补充
        elif len(clips) == 1:
            pass  # 上面已处理
        return clips

    def _build_concat_list(
        self, clip_files: List[Path], target_duration_ms: int, output_path: Path
    ) -> int:
        """
        构建 FFmpeg concat 文件列表。
        每个切片 4.833s（实际测量值），不足的时长通过填充补足。

        V48.5 fix: 拼接结果必须保证 avatar 视觉不重复：
        - 原逻辑按 clip_files[i % len(clip_files)] 轮询填充 → 拼接末段含多个完整 cycle 的不同 clip，
          例如 [A,B,C,D,E,A,B,C]，被 -shortest 截断后未段含 [A,B,C]，
          与开头的 [A,B,C] 完全一致 → 用户看到“重复读同一段文字”。
        - V48.5 fix 逻辑：
          1. 填充时优先使用「不在原 clip_files 中」的独特 clip（从 transition/conclusion/thanks/analysis/greeting/... 中选），
             保证拼接结果只含“原始 N 个 clip + 填充时从未出现过的 clip”，绝不会与开头重复。
          2. 如果所有 clip 都在原 labels 中（极少见），才走相邻不重复的轮询填充。
        """
        # V48.5: clip 实际时长约 4.833s（不是 5s）—— 之前用 5s 会造成计算偏差
        CLIP_DURATION_MS = 4833
        natural_duration = len(clip_files) * CLIP_DURATION_MS

        lines = []
        for cf in clip_files:
            # FFmpeg concat 需要绝对路径（以避免相对路径解析错误）
            escaped = str(cf.resolve()).replace("\\", "/").replace("'", "\\'")
            lines.append(f"file '{escaped}'")

        # 如果自然时长不足，填充切片
        if natural_duration < target_duration_ms and clip_files:
            deficit = target_duration_ms - natural_duration
            extra_loops = (deficit + CLIP_DURATION_MS - 1) // CLIP_DURATION_MS
            # V48.5 fix: 优先从「不在 clip_files 中」的 clip 里选填充 clip，
            # 保证拼接顺序为 [原始 N 个 clip + 独特填充]，避免与开头重复。
            existing_resolved = set(cf.resolve() for cf in clip_files)
            existing_stems = set(cf.stem for cf in clip_files)
            unique_fill_clips: List[Path] = []
            # V49: 动态扫描 .webm 目录下所有可用 clip，替代硬编码候选列表
            for webm_file in sorted(self.webm_dir.glob("*.webm")):
                stem = webm_file.stem
                if stem in existing_stems:
                    continue  # 已在原始 labels 中，跳过
                resolved = webm_file.resolve()
                if resolved not in existing_resolved:
                    unique_fill_clips.append(webm_file)
            # V49: 如果所有 .webm clip 都在原 labels 中，回退到逆序 clip_files
            # 逆序排列确保填充 clip 与开头视觉差异最大化（而非轮询导致与开头一致）
            if not unique_fill_clips:
                reversed_clips = list(reversed(clip_files))
                for cf in reversed_clips:
                    if cf.resolve() != clip_files[-1].resolve():
                        unique_fill_clips.append(cf)
                if not unique_fill_clips:
                    unique_fill_clips = reversed_clips
            last_clip_path = clip_files[-1].resolve()
            for i in range(extra_loops):
                # V49: unique_fill_clips 保证非空，直接用 index 轮询
                fill_clip = unique_fill_clips[i % len(unique_fill_clips)]
                escaped = str(fill_clip.resolve()).replace("\\", "/").replace("'", "\\'")
                lines.append(f"file '{escaped}'")
                last_clip_path = fill_clip.resolve()

        output_path.write_text("\n".join(lines), encoding="utf-8")
        return natural_duration

    async def _run_ffmpeg_concat(self, concat_list_path: str, audio_path: str, output_path: str):
        """
        运行 FFmpeg concat 命令 — V46 同时输出 webm + mp4。

        - webm: 保留 -c:v copy 快路径，VP9 流原样复制（适合 VP9 硬解良好的平台 / 微信浏览器）
        - mp4: 重编码为 H.264 (libx264 ultrafast) — 所有现代 PC 浏览器都有 H.264 硬件解码器。
               避免 PC Chrome / Edge 在 VP9 软解上消耗 30-50% CPU 导致讲话时主线程繁忙、
               视频帧率压到 5-10 fps、用户感知为“动画像截图” (V45 后仍出现)。

        两份输出并存，客户端按 prefersMp4 选 mp4 (PC/微信) 或 webm (ChromeOS)。
        """
        # webm 输出 — 保持原性能 (VP9 copy)
        # V49.1: 添加 -map 显式流映射，确保只使用 concat 输入的视频流 + TTS 输入的音频流，
        # 防止 clip 文件中的音频轨（如有）混入输出导致语音重复。
        await self._exec_ffmpeg(
            [
                self.ffmpeg_path,
                "-f", "concat",
                "-safe", "0",
                "-i", concat_list_path,
                "-i", audio_path,
                "-map", "0:v:0",          # 只取 concat 输入的视频流
                "-map", "1:a:0",          # 只取 TTS 输入的音频流
                "-c:v", "copy",          # VP9 视频流原样复制（无重编码）
                "-c:a", "libopus",       # 音频编码为 Opus
                "-shortest",             # 以较短的流为准
                "-y",
                output_path,
            ],
            timeout=120,
        )

        # mp4 输出 — 重编码为 H.264（所有 PC 浏览器硬解）— V46
        # 使用 ultrafast + crf 28 + 缩小到 540×720 控制重编码耗时在 1-2 秒内
        # V47: mp4 生成失败不阻断 webm — 客户端 routes_media.py 会 fallback 到 webm
        # V48 P2: 分辨率从 720:960 降至 540:720（更小的解码开销 = 更低的帧率波动）；
        #         超时从 120s 缩短到 30s（mp4 是可选项，不应长时间阻塞主流程）
        mp4_path = output_path.replace(".webm", ".mp4")
        try:
            await self._exec_ffmpeg(
                [
                    self.ffmpeg_path,
                    "-f", "concat",
                    "-safe", "0",
                    "-i", concat_list_path,
                    "-i", audio_path,
                    "-map", "0:v:0",              # 只取 concat 输入的视频流
                    "-map", "1:a:0",              # 只取 TTS 输入的音频流
                    "-vf", "scale=540:720",          # V48 P2: 降至 540×720（硬解 ~1-2% CPU）
                    "-c:v", "libx264",
                    "-preset", "ultrafast",          # 速度优先（避免被视频卡顿影响）
                    "-crf", "28",                    # 平衡质量与体积
                    "-pix_fmt", "yuv420p",           # 兼容性
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-shortest",
                    "-movflags", "+faststart",       # MP4 流式首帧快速
                    "-y",
                    mp4_path,
                ],
                timeout=120,  # V48 P2: 保持 120s（ARM64 QEMU 下编码较慢，30s 会导致频繁超时丢失 mp4）
            )
            logger.info(f"mp4 生成成功: {mp4_path}")
        except Exception as mp4_err:
            logger.warning(f"mp4 生成失败（不影响 webm）: {mp4_err}")

    async def _exec_ffmpeg(self, cmd: list, timeout: int = 120):
        """执行 FFmpeg 命令并处理超时/异常 — V46 抽出复用"""
        logger.info(f"FFmpeg 命令: {' '.join(cmd)}")
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            if proc.returncode != 0:
                err_msg = stderr.decode()[:500] if stderr else "未知错误"
                raise VideoConcatError(f"FFmpeg 执行失败 (code={proc.returncode}): {err_msg}")
        except asyncio.TimeoutError:
            raise VideoConcatError("FFmpeg 执行超时")
        except FileNotFoundError:
            raise VideoConcatError(f"找不到 FFmpeg 可执行文件: {self.ffmpeg_path}")

    async def _get_audio_duration_ms(self, audio_path: str) -> int:
        """
        V50: 用 ffprobe 获取音频文件真实时长（毫秒）。
        替代 TTS 引擎基于文件大小/码率的估算值，消除偏差。
        """
        try:
            ffprobe_path = str(Path(self.ffmpeg_path).parent / "ffprobe")
            proc = await asyncio.create_subprocess_exec(
                ffprobe_path,
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                audio_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            duration_str = stdout.decode().strip()
            if duration_str:
                return int(float(duration_str) * 1000)
        except Exception as e:
            logger.warning(f"ffprobe 获取时长失败，使用估算值: {e}")
        return 0

    async def _validate_output_duration(
        self, output_path: str, audio_path: str, target_duration_ms: int
    ):
        """
        V52: 用 ffprobe 校验输出视频的音频流时长。
        若偏差 > 500ms，用 -t 精确截断重新编码，消除 -shortest 可能的不精确截断。
        """
        try:
            actual_ms = await self._get_audio_duration_ms(output_path)
            if actual_ms <= 0:
                return
            diff = abs(actual_ms - target_duration_ms)
            if diff > 500:
                logger.warning(
                    f"V52: 输出视频音频时长偏差 {diff}ms (实际={actual_ms}ms, 目标={target_duration_ms}ms)，"
                    f"用 -t 精确截断"
                )
                temp_path = output_path + ".fixed.webm"
                await self._exec_ffmpeg(
                    [
                        self.ffmpeg_path,
                        "-i", output_path,
                        "-c:v", "copy",
                        "-c:a", "copy",
                        "-t", f"{target_duration_ms / 1000:.3f}",
                        "-y",
                        temp_path,
                    ],
                    timeout=60,
                )
                Path(temp_path).replace(output_path)
                logger.info(f"V52: 输出视频已精确截断至 {target_duration_ms}ms")
        except Exception as e:
            logger.warning(f"V52: 输出校验失败（不影响主流程）: {e}")


def detect_gpu_encoder() -> Optional[str]:
    """
    检测可用的 GPU 编码器。
    返回 "qsv" (Intel), "nvenc" (NVIDIA), 或 None (CPU)。

    注：当前 stream copy 方式无需 GPU 编码器，
    此函数预留用于需要重编码的场景。
    """
    # 尝试检测 Intel QSV
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10,
        )
        output = result.stdout + result.stderr
        if "h264_qsv" in output or "hevc_qsv" in output:
            return "qsv"
        if "h264_nvenc" in output or "hevc_nvenc" in output:
            return "nvenc"
    except Exception:
        pass

    return None  # CPU fallback
