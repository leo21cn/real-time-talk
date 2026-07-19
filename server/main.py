"""
RealTimeTalk - FastAPI 入口
"""
import logging
from contextlib import asynccontextmanager
from typing import Dict

from fastapi import FastAPI, WebSocket, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from server.config import get_config, reload_config
from server.models.session import SessionContext
from server.services.redis_client import RedisClient, RedisClientError
from server.services.minio_client import MinioClient
from server.services.llm_client import LlmClient
from server.services.qdrant_client import QdrantClient, QdrantClientError
from server.services.embedding_client import EmbeddingClient
from server.agent.agent_engine import AgentEngine, set_rag_clients
from server.api.routes_session import router as session_router, init_session_routes
from server.api.routes_clips import router as clips_router
from server.api.routes_media import router as media_router
from server.api.routes_knowledge import router as knowledge_router, init_knowledge_routes
from server.api.routes_asr import router as asr_router
from server.api.routes_diag import router as diag_router
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
qdrant_client: QdrantClient | None = None
embedding_client: EmbeddingClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global redis_client, minio_client, qdrant_client, embedding_client

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

    # Qdrant 初始化
    qdrant_client = QdrantClient()
    try:
        collections = await qdrant_client.list_collections()
        logger.info(f"Qdrant 连接成功，现有 {len(collections)} 个集合: {collections}")
    except QdrantClientError as e:
        logger.warning(f"Qdrant 连接失败（服务仍可启动，RAG 功能暂不可用）: {e}")
        collections = []

    # Embedding 初始化
    embedding_client = EmbeddingClient()
    logger.info(f"Embedding 客户端已初始化: model={embedding_client.model}")

    # 知识库路由初始化
    init_knowledge_routes(qdrant_client, embedding_client)

    # 注入 RAG 依赖到 AgentEngine
    set_rag_clients(qdrant_client, embedding_client)

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

# V56: HEAD 转 GET 中间件 — 浏览器对 <video preload="auto"> / 资源预取会发 HEAD
# 探测元数据（Content-Length / Content-Type）。FastAPI 不会自动给 GET 路由生成
# HEAD handler，导致 HEAD 全部 404，可能造成视频加载失败。
# 实现：HEAD 请求内部走 GET 路由，拿到响应后清空 body（HTTP/1.1 规范要求 HEAD 无 body）。
from starlette.requests import Request as StarletteRequest
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.responses import Response as StarletteResponse


@app.middleware("http")
async def head_to_get_middleware(request: StarletteRequest, call_next):
    if request.method != "HEAD":
        return await call_next(request)

    # 把 HEAD 改成 GET，触发 GET 路由处理
    request.scope["method"] = "GET"
    response = await call_next(request)

    # HEAD 响应必须没有 body（HTTP/1.1 规范）。如果响应是 StreamingResponse/FileResponse
    # 之类的可迭代 body，需要清空；普通 Response 通常 body 为空或可直接覆盖。
    if hasattr(response, "body_iterator") and response.body_iterator is not None:
        # 构造一个只发送 headers 不带 body 的空响应
        async def empty_body():
            if False:
                yield b""

        response.body_iterator = empty_body()
    if hasattr(response, "body"):
        # Starlette Response 的 body 是 bytes/str，正常情况 HEAD 路由返回 JSON 错误时
        # body 是 JSON 字符串，必须清空否则违反 HTTP 规范
        if response.body and len(response.body) > 0:
            # 记录原始 Content-Length 但清空 body
            original_content_length = response.headers.get("content-length")
            response.body = b""
            if original_content_length:
                response.headers["content-length"] = "0"
    return response

# 注册 REST API 路由
app.include_router(session_router)
app.include_router(clips_router)
app.include_router(media_router)
app.include_router(knowledge_router)
app.include_router(asr_router)
app.include_router(diag_router)


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
    agent = AgentEngine(llm, redis_client, qdrant_client, embedding_client)

    handler = WsHandler(
        sessions=sessions,
        agent=agent,
        redis=redis_client,
        minio=minio_client,
        llm=llm,
    )

    await ws.accept()
    await handler.handle(ws, token)


# ── 前端静态文件（SPA 模式，404 回退到 index.html）──
# 必须放在所有 API 路由和 WebSocket 端点之后，否则会拦截 API 请求
static_dir = Path(__file__).resolve().parent.parent / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
else:
    logger.warning(f"静态文件目录不存在: {static_dir}，跳过挂载")


if __name__ == "__main__":
    import uvicorn
    cfg = get_config()
    uvicorn.run(
        "server.main:app",
        host=cfg["server"]["host"],
        port=cfg["server"]["port"],
        reload=False,
    )
