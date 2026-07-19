"""
单段生成器：TTS → 语义分析 → FFmpeg 拼接 → MinIO 上传
"""
import logging
from dataclasses import dataclass
from typing import List, Optional

from server.services.tts_engine import TtsEngine, TtsError
from server.services.semantic_analyzer import SemanticAnalyzer
from server.services.video_concat import VideoConcat, VideoConcatError
from server.services.minio_client import MinioClient, MinioClientError

logger = logging.getLogger(__name__)


@dataclass
class SegmentResult:
    """段落生成结果"""
    index: int
    text: str
    video_path: str         # 默认路径（V46: 优先 mp4，无 mp4 时退回 webm）
    duration_ms: int
    labels: List[str]
    # V46: 同时提供 webm/mp4 两个路径，客户端按 prefersMp4 选优
    video_path_webm: str = ""
    video_path_mp4: Optional[str] = None
    error: Optional[str] = None


class SegmentGenerator:
    """单段生成器"""

    def __init__(
        self,
        tts: TtsEngine,
        semantic: SemanticAnalyzer,
        concat: VideoConcat,
        minio: MinioClient,
    ):
        self.tts = tts
        self.semantic = semantic
        self.concat = concat
        self.minio = minio

    async def generate(
        self,
        text: str,
        segment_index: int,
        session_id: str,
        skip_llm_semantic: bool = False,
    ) -> SegmentResult:
        """
        生成单个段落的完整视频。

        流程:
        1. TTS 语音合成
        2. 语义分析 → 标签序列
        3. FFmpeg 切片拼接 + 混音
        4. MinIO 上传（失败回退本地）

        Args:
            skip_llm_semantic: 首段优化，跳过 LLM 语义分析，用关键词回退

        Returns:
            SegmentResult
        """
        try:
            # Step 1: TTS
            logger.info(f"[段{segment_index}] 开始 TTS: {text[:50]}...")
            audio_path, duration_ms = await self.tts.synthesize(text, session_id, segment_index)
            logger.info(f"[段{segment_index}] TTS 完成: duration={duration_ms}ms")

            # Step 2: 语义分析
            logger.info(f"[段{segment_index}] 开始语义分析 (skip_llm={skip_llm_semantic})")
            labels = await self.semantic.analyze(text, skip_llm=skip_llm_semantic)
            logger.info(f"[段{segment_index}] 语义分析完成: labels={labels}")

            # Step 3: FFmpeg 拼接
            logger.info(f"[段{segment_index}] 开始视频拼接")
            video_path = await self.concat.concat(
                labels=labels,
                audio_path=audio_path,
                target_duration_ms=duration_ms,
                session_id=session_id,
                segment_index=segment_index,
            )
            logger.info(f"[段{segment_index}] 视频拼接完成: {video_path}")

            # Step 4: 上传到 MinIO（V55: 只输出 .mp4）
            # V55: video_concat 直接输出 H.264/AAC MP4，不再有 webm。
            # 保留 video_path_webm 字段以兼容旧的 SegmentResult dataclass，但不再使用。
            mp4_key = f"sessions/{session_id}/segment_{segment_index}.mp4"
            try:
                await self.minio.upload(video_path, mp4_key)
                logger.info(f"[段{segment_index}] MinIO 上传成功 mp4: {mp4_key}")
                return SegmentResult(
                    index=segment_index,
                    text=text,
                    video_path=mp4_key,
                    video_path_webm="",  # V55: 不再输出 webm
                    video_path_mp4=mp4_key,
                    duration_ms=duration_ms,
                    labels=labels,
                )
            except MinioClientError as e:
                logger.warning(f"[段{segment_index}] MinIO 上传失败，回退本地: {e}")
                return SegmentResult(
                    index=segment_index,
                    text=text,
                    video_path=video_path,
                    video_path_webm="",  # V55: 不再输出 webm
                    video_path_mp4=video_path,
                    duration_ms=duration_ms,
                    labels=labels,
                )

        except TtsError as e:
            logger.error(f"[段{segment_index}] TTS 失败: {e}")
            return SegmentResult(
                index=segment_index,
                text=text,
                video_path="",
                duration_ms=0,
                labels=[],
                error=f"TTS 失败: {e}",
            )
        except VideoConcatError as e:
            logger.error(f"[段{segment_index}] 视频拼接失败: {e}")
            return SegmentResult(
                index=segment_index,
                text=text,
                video_path="",
                duration_ms=0,
                labels=[],
                error=f"视频拼接失败: {e}",
            )
        except Exception as e:
            logger.error(f"[段{segment_index}] 生成异常: {e}")
            return SegmentResult(
                index=segment_index,
                text=text,
                video_path="",
                duration_ms=0,
                labels=[],
                error=str(e),
            )
