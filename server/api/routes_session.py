"""
Session REST API 路由
"""
import logging
import uuid

from fastapi import APIRouter, HTTPException

from server.config import get_config
from server.services.redis_client import RedisClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/session", tags=["session"])

# 全局 Session 引用（在 main.py 中设置）
_sessions: dict = {}
_redis: RedisClient | None = None


def init_session_routes(sessions: dict, redis_client: RedisClient):
    """初始化路由所需的全局引用"""
    global _sessions, _redis
    _sessions = sessions
    _redis = redis_client


@router.post("/create")
async def create_session():
    """
    创建新会话，返回 session_token。

    Returns:
        {"session_token": "uuid-string"}
    """
    token = str(uuid.uuid4())

    # 在 Redis 中初始化会话状态
    if _redis:
        try:
            await _redis.set_session_state(token, "idle")
        except Exception as e:
            logger.error(f"Redis 写入会话状态失败: {e}")
            raise HTTPException(status_code=503, detail="服务暂时不可用（Redis 连接异常）")

    logger.info(f"会话已创建: {token}")
    return {"session_token": token}


@router.get("/{token}/history")
async def get_session_history(token: str):
    """
    获取会话对话历史。

    Args:
        token: session_token

    Returns:
        {"messages": [...]}
    """
    if not _redis:
        raise HTTPException(status_code=503, detail="服务不可用")

    exists = await _redis.session_exists(token)
    if not exists and token not in _sessions:
        raise HTTPException(status_code=404, detail="会话不存在")

    messages = await _redis.get_history(token)
    return {
        "messages": [m.to_redis_dict() for m in messages],
        "count": len(messages),
    }


@router.delete("/{token}")
async def destroy_session(token: str):
    """
    销毁会话，清理 Redis + MinIO + 内存上下文。

    Args:
        token: session_token
    """
    if not _redis:
        raise HTTPException(status_code=503, detail="服务不可用")

    # 检查会话是否存在
    exists = await _redis.session_exists(token)
    if not exists and token not in _sessions:
        raise HTTPException(status_code=404, detail="会话不存在")

    # 1. 取消活跃的 Pipeline
    session_ctx = _sessions.get(token)
    if session_ctx and session_ctx.pipeline:
        session_ctx.pipeline.cancel()
        logger.info(f"已取消会话 Pipeline: {token}")

    # 2. 关闭关联的 WebSocket
    if session_ctx and session_ctx.ws:
        try:
            await session_ctx.ws.close()
        except Exception:
            pass

    # 3. 清理 Redis
    await _redis.delete_session(token)
    logger.info(f"已清理 Redis 数据: {token}")

    # 4. 清理内存上下文
    _sessions.pop(token, None)

    # 5. MinIO 清理（异步）
    try:
        from server.services.minio_client import MinioClient
        minio = MinioClient()
        minio.connect()
        if minio.available:
            await minio.delete_prefix(f"sessions/{token}/")
    except Exception as e:
        logger.warning(f"MinIO 清理失败: {e}")

    logger.info(f"会话已销毁: {token}")
    return {"status": "deleted", "session_token": token}
