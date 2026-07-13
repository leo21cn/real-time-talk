"""
切片文件代理路由
"""
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from server.config import get_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clips", tags=["clips"])

# 预取目标：12 个语义切片 + 待机动画，mp4 与 webm 各一份
# 同步 clips.toml（clips/short-hair-teacher-girl/clips.toml）中的 [clips.*]
PRELOAD_CLIP_NAMES = [
    "greeting",
    "introduction",
    "explaining",
    "listing",
    "emphasis",
    "example",
    "analysis",
    "comparison",
    "transition",
    "conclusion",
    "thanks",
    "idle/idle_breathing",
]
PRELOAD_FORMATS = (".mp4", ".webm")


def _get_clips_dir() -> Path:
    """获取切片资源目录"""
    cfg = get_config()
    return Path(cfg["avatar"]["clips_dir"])


@router.get("/manifest")
async def clips_manifest():
    """
    返回所有预取目标 URL 列表（带版本号）。

    客户端在首次解锁后调用本端点，按返回的 URL 列表并行下载到 IndexedDB。
    URL 携带的 ?v=N 版本号与服务端 config.json 中 avatar.clip_version 联动，
    发布新切片时 bump 版本号即可使客户端自动失效旧缓存并重新预取。
    """
    cfg = get_config()
    base_version = int(cfg["avatar"].get("clip_version", 1))
    items: list[str] = []
    for name in PRELOAD_CLIP_NAMES:
        for ext in PRELOAD_FORMATS:
            items.append(f"/api/clips/{name}{ext}?v={base_version}")
    return JSONResponse(
        {
            "items": items,
            "version": base_version,
        },
        headers={
            # manifest 本身不缓存：必须实时返回最新版本号
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    )


@router.get("/{name:path}")
async def get_clip(name: str):
    """
    获取切片文件或待机动画。

    支持路径:
    - /api/clips/analysis.mp4       → clips/.mp4/analysis.mp4
    - /api/clips/analysis.webm       → clips/.webm/analysis.webm
    - /api/clips/idle/idle_breathing.mp4 → clips/idle/idle_breathing.mp4
    - /api/clips/idle/idle_breathing.webm → clips/idle/idle_breathing.webm

    移动端兼容：优先返回 mp4（H.264），未找到则回退 webm。

    Args:
        name: 文件名或子路径
    """
    clips_dir = _get_clips_dir()

    # 根据扩展名推导 media_type
    media_type = "video/mp4" if name.lower().endswith(".mp4") else "video/webm"

    # 尝试多个可能的路径（mp4 优先，移动端友好）
    candidates = [
        clips_dir / ".mp4" / name,            # 转换后的 .mp4 切片
        clips_dir / name,                      # 直接路径（idle 等）
        clips_dir / ".webm" / name,            # 转换后的 .webm 切片（回退）
    ]

    # 额外检查：是否匹配配置中的待机动画路径
    idle_path = Path(get_config()["avatar"]["idle_animation"])
    if name == str(idle_path.relative_to(clips_dir)).replace("\\", "/"):
        candidates.append(idle_path)
    # 兼容 idle 的 mp4 副本
    idle_mp4 = idle_path.with_suffix(".mp4")
    if name == str(idle_mp4.relative_to(clips_dir)).replace("\\", "/"):
        candidates.append(idle_mp4)

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
                    media_type=media_type,
                    headers={
                        # 长缓存：客户端预缓存机制依赖此头
                        # URL 已携带 ?v=N 版本号，发布新切片时由 config.json 中
                        # avatar.clip_version 字段统一 bump，浏览器自动失效旧缓存
                        "Cache-Control": "public, max-age=31536000, immutable",
                    },
                )
        except (OSError, ValueError):
            continue

    raise HTTPException(status_code=404, detail=f"切片文件不存在: {name}")
