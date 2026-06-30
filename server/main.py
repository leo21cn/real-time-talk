"""
RealTimeTalk - FastAPI 入口
"""
import logging
from contextlib import asynccontextmanager
from typing import Dict

from fastapi import FastAPI, WebSocket, Query
from fastapi.middleware.cors import CORSMiddleware

from server.config import get_config, reload_config
from server.models.session import SessionContext
from server.services.redis_client import RedisClient, RedisClientError
from server.services.minio_client import MinioClient
from server.services.llm_client import LlmClient
from server.agent.agent_engine import AgentEngine
from server.api.routes_session import router as session_router, init_session_routes
from server.api.routes_clips import router as clips_router
from server.api.routes_media import router as media_router
from server.api.ws_handler import WsHandler

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("main")

# 全局状态
sessions: Dict[str, SessionContext] = {}
redis_client: RedisClient | None = None
minio_client: MinioClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global redis_client, minio_client

    logger.info("RealTimeTalk 服务启动中...")

    # 加载配置
    cfg = get_config()
    logger.info(f"配置已加载: model={cfg['llm']['model']}, voice={cfg['tts']['voice']}")

    # Redis 连接检查
    redis_client = RedisClient()
    try:
        await redis_client.connect()
        logger.info("Redis 连接成功")
    except RedisClientError as e:
        logger.critical(f"Redis 不可用，服务拒绝启动: {e}")
        raise SystemExit(f"Redis 不可用: {e}")

    # MinIO 初始化
    minio_client = MinioClient()
    minio_client.connect()
    await minio_client.ensure_bucket()

    # 初始化 Session 路由
    init_session_routes(sessions, redis_client)

    logger.info("RealTimeTalk 服务已启动")
    yield

    # 关闭资源
    logger.info("RealTimeTalk 服务关闭中...")

    # 取消所有活跃 Pipeline
    for token, ctx in list(sessions.items()):
        if ctx.pipeline:
            ctx.pipeline.cancel()
        if ctx.ws:
            try:
                await ctx.ws.close()
            except Exception:
                pass
    sessions.clear()

    # 关闭 Redis
    if redis_client:
        await redis_client.disconnect()

    logger.info("RealTimeTalk 服务已关闭")


# FastAPI 应用
app = FastAPI(
    title="RealTimeTalk",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS（同源访问，开发阶段允许本地跨域）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册 REST API 路由
app.include_router(session_router)
app.include_router(clips_router)
app.include_router(media_router)


@app.get("/api/health")
async def health_check():
    """健康检查端点"""
    return {
        "status": "ok",
        "redis": redis_client is not None,
        "sessions": len(sessions),
    }


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    """
    WebSocket 实时通信端点。

    URL: ws://host/ws?token={session_token}
    """
    if not redis_client or not minio_client:
        await ws.close(code=4000, reason="服务未就绪")
        return

    # 创建处理器
    llm = LlmClient()
    agent = AgentEngine(llm, redis_client)

    handler = WsHandler(
        sessions=sessions,
        agent=agent,
        redis=redis_client,
        minio=minio_client,
        llm=llm,
    )

    await ws.accept()
    await handler.handle(ws, token)


if __name__ == "__main__":
    import uvicorn
    cfg = get_config()
    uvicorn.run(
        "server.main:app",
        host=cfg["server"]["host"],
        port=cfg["server"]["port"],
        reload=False,
    )
