"""
切片文件代理路由
"""
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from server.config import get_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clips", tags=["clips"])


def _get_clips_dir() -> Path:
    """获取切片资源目录"""
    cfg = get_config()
    return Path(cfg["avatar"]["clips_dir"])


@router.get("/{name:path}")
async def get_clip(name: str):
    """
    获取切片文件或待机动画。

    支持路径:
    - /api/clips/analysis.webm       → clips/.webm/analysis.webm
    - /api/clips/idle/idle_breathing.webm → clips/idle/idle_breathing.webm

    Args:
        name: 文件名或子路径
    """
    clips_dir = _get_clips_dir()

    # 尝试多个可能的路径
    candidates = [
        clips_dir / ".webm" / name,           # 转换后的 .webm 切片
        clips_dir / name,                      # 直接路径（idle 等）
    ]

    # 额外检查：是否匹配配置中的待机动画路径
    idle_path = Path(get_config()["avatar"]["idle_animation"])
    if name == str(idle_path.relative_to(clips_dir)).replace("\\", "/"):
        candidates.append(idle_path)

    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if resolved.exists() and resolved.is_file():
                # 安全检查：确保文件在 clips 目录下
                try:
                    resolved.relative_to(clips_dir.resolve())
                except ValueError:
                    # 尝试相对路径
                    try:
                        resolved.relative_to(Path.cwd())
                    except ValueError:
                        continue

                return FileResponse(
                    str(resolved),
                    media_type="video/webm",
                    headers={
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                        "Pragma": "no-cache",
                        "Expires": "0",
                    },
                )
        except (OSError, ValueError):
            continue

    raise HTTPException(status_code=404, detail=f"切片文件不存在: {name}")
