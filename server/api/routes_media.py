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

    # V18: 段视频 URL 现在包含 seq 参数（每轮对话唯一），浏览器缓存在同轮内有效。
    # 使用 ETag/Last-Modified 替代 immutable，避免旧轮视频被错误复用。
    cache_headers = {
        "Cache-Control": "public, max-age=3600",
        "Accept-Ranges": "bytes",
    }

    # 优先尝试本地文件（避免 MinIO presigned URL 在浏览器不可达）
    # 视频拼接输出为 output_X.webm / output_X.mp4，直接匹配请求的 segment_X.*
    work_dir = Path(f"_work/{session_token}")
    output_name = filename.replace("segment_", "output_")
    local_path = work_dir / output_name

    # V47: mp4 不存在时立即 fallback 到 webm（V46 的 fallback 是死代码 — 在 if exists 内部检查 not exists）
    # 根因：mp4 重编码可能失败（libx264 性能 / 超时），只有 webm 文件存在。
    # 客户端 USE_MP4=true 时请求 .mp4，若 404 则视频加载失败 → 卡通形象消失。
    if filename.lower().endswith(".mp4") and not local_path.exists():
        webm_path = local_path.with_suffix(".webm")
        if webm_path.exists():
            logger.info(f"[V47] mp4 不存在，fallback 到 webm: {filename}")
            local_path = webm_path
            output_name = output_name.replace(".mp4", ".webm")

    if local_path.exists() and local_path.is_file():
        # V46: MIME 映射
        if filename.lower().endswith(".mp4") or str(local_path).endswith(".mp4"):
            media_type = "video/mp4" if str(local_path).endswith(".mp4") else "video/webm"
        elif filename.lower().endswith(".webm") or str(local_path).endswith(".webm"):
            media_type = "video/webm"
        elif filename.lower().endswith(".mp3"):
            media_type = "audio/mpeg"
        else:
            media_type = "application/octet-stream"
        return FileResponse(
            str(local_path),
            media_type=media_type,
            headers=cache_headers,
        )

    # V46: MIME 映射（MinIO / alt_path 分支）
    if filename.lower().endswith(".mp4"):
        media_type = "video/mp4"
    elif filename.lower().endswith(".webm"):
        media_type = "video/webm"
    elif filename.lower().endswith(".mp3"):
        media_type = "audio/mpeg"
    else:
        media_type = "application/octet-stream"

    # 也尝试原始文件名
    alt_path = work_dir / filename
    if alt_path.exists() and alt_path.is_file():
        return FileResponse(
            str(alt_path),
            media_type=media_type,
            headers=cache_headers,
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
