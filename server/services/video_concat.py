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

        # 2. 生成 concat 文件列表（含时长对齐的重复填充）
        concat_list_path = work_dir / f"concat_list_{segment_index}.txt"
        total_natural_duration = self._build_concat_list(clip_files, target_duration_ms, concat_list_path)

        # 3. FFmpeg concat demuxer + 混音
        output_path = str(work_dir / f"output_{segment_index}.webm")

        await self._run_ffmpeg_concat(str(concat_list_path), audio_path, output_path)

        # 清理 concat 列表
        concat_list_path.unlink(missing_ok=True)

        logger.info(f"视频拼接完成: {output_path}")
        return output_path

    def _select_clips(self, labels: List[str]) -> List[Path]:
        """根据标签选择切片文件路径"""
        clips = []
        for label in labels:
            clip_path = self.webm_dir / f"{label}.webm"
            if clip_path.exists():
                clips.append(clip_path)
            else:
                logger.warning(f"切片文件不存在（跳过）: {clip_path}")
        return clips

    def _build_concat_list(
        self, clip_files: List[Path], target_duration_ms: int, output_path: Path
    ) -> int:
        """
        构建 FFmpeg concat 文件列表。
        每个切片 5 秒（5000ms），不足的时长通过循环最后一个切片填充。

        Returns:
            自然总时长（ms）
        """
        CLIP_DURATION_MS = 5000  # 每个切片 5 秒
        natural_duration = len(clip_files) * CLIP_DURATION_MS

        lines = []
        for cf in clip_files:
            # FFmpeg concat 需要绝对路径（以避免相对路径解析错误）
            escaped = str(cf.resolve()).replace("\\", "/").replace("'", "\\'")
            lines.append(f"file '{escaped}'")

        # 如果自然时长不足，循环填充最后一个切片
        if natural_duration < target_duration_ms and clip_files:
            last_clip = clip_files[-1]
            deficit = target_duration_ms - natural_duration
            extra_loops = (deficit + CLIP_DURATION_MS - 1) // CLIP_DURATION_MS
            escaped = str(last_clip.resolve()).replace("\\", "/").replace("'", "\\'")
            for _ in range(extra_loops):
                lines.append(f"file '{escaped}'")

        output_path.write_text("\n".join(lines), encoding="utf-8")
        return natural_duration

    async def _run_ffmpeg_concat(self, concat_list_path: str, audio_path: str, output_path: str):
        """运行 FFmpeg concat 命令"""
        cmd = [
            self.ffmpeg_path,
            "-f", "concat",
            "-safe", "0",
            "-i", concat_list_path,
            "-i", audio_path,
            "-c:v", "copy",          # 视频流拷贝（无重编码）
            "-c:a", "libopus",       # 音频编码为 Opus
            "-shortest",             # 以较短的流为准
            "-y",
            output_path,
        ]

        logger.info(f"FFmpeg 命令: {' '.join(cmd)}")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)

            if proc.returncode != 0:
                err_msg = stderr.decode()[:500] if stderr else "未知错误"
                raise VideoConcatError(f"FFmpeg 执行失败 (code={proc.returncode}): {err_msg}")

        except asyncio.TimeoutError:
            raise VideoConcatError("FFmpeg 执行超时（120s）")
        except FileNotFoundError:
            raise VideoConcatError(f"找不到 FFmpeg 可执行文件: {self.ffmpeg_path}")


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
