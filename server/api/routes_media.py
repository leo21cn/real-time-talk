"""
媒体文件代理路由（MinIO presigned URL 代理）
"""
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

from server.config import get_config
from server.services.minio_client import MinioClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/media", tags=["media"])


@router.get("/{session_token}/{filename:path}")
async def get_media(session_token: str, filename: str):
    """
    获取生成的视频/音频文件。

    优先使用 MinIO presigned URL 重定向，
    回退到本地文件代理。

    Args:
        session_token: 会话 token
        filename: 文件名（如 segment_0.webm）
    """
    object_name = f"sessions/{session_token}/{filename}"

    # 优先尝试本地文件（避免 MinIO presigned URL 在浏览器不可达）
    # 视频拼接输出为 output_X.webm，直接匹配请求的 segment_X.webm
    work_dir = Path(f"_work/{session_token}")
    output_name = filename.replace("segment_", "output_")
    local_path = work_dir / output_name
    if local_path.exists() and local_path.is_file():
        media_type = "video/webm" if filename.endswith(".webm") else "audio/mpeg"
        return FileResponse(
            str(local_path),
            media_type=media_type,
        )

    # 也尝试原始文件名
    alt_path = work_dir / filename
    if alt_path.exists() and alt_path.is_file():
        media_type = "video/webm" if filename.endswith(".webm") else "audio/mpeg"
        return FileResponse(
            str(alt_path),
            media_type=media_type,
        )

    # 回退：尝试 MinIO presigned URL
    try:
        minio = MinioClient()
        minio.connect()
        if minio.available:
            presigned_url = await minio.get_presigned_url(object_name)
            if presigned_url:
                return RedirectResponse(url=presigned_url, status_code=302)
    except Exception as e:
        logger.warning(f"MinIO presigned URL 生成失败: {e}")

    raise HTTPException(status_code=404, detail=f"媒体文件不存在: {filename}")
