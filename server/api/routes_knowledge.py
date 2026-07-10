"""
知识库管理 REST API

端点：
- Collection 管理: GET/POST/DELETE /api/knowledge/collections
- 知识摄入: POST /api/knowledge/ingest
- 统计查询: GET /api/knowledge/stats
- 清空: DELETE /api/knowledge/clear
- 调试搜索: GET /api/knowledge/search

所有端点受 X-Knowledge-Admin-Token 请求头保护。
"""
import json as _json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from server.config import get_config
from server.services.qdrant_client import QdrantClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


# ────────────── 全局依赖（由 main.py 注入） ──────────────

_qdrant = None
_embedding = None


def init_knowledge_routes(qdrant_client, embedding_client):
    """初始化知识库路由（在 lifespan 中调用）"""
    global _qdrant, _embedding
    _qdrant = qdrant_client
    _embedding = embedding_client


# ────────────── Admin Token 鉴权 ──────────────


def verify_admin_token(x_knowledge_admin_token: str = Header(default="", alias="X-Knowledge-Admin-Token")):
    """验证知识管理 Admin Token，token 为空配置时放行所有请求"""
    cfg = get_config()
    expected = cfg.get("knowledge_admin_token", "")
    if not expected:
        return  # 未配置 token，放行
    if not x_knowledge_admin_token or x_knowledge_admin_token != expected:
        raise HTTPException(status_code=401, detail="无效或缺失的知识管理 Token")


# ────────────── Pydantic Models ──────────────


class DocumentItem(BaseModel):
    text: str
    source: str = ""


class IngestRequest(BaseModel):
    collection: str
    documents: list[DocumentItem]


class CreateCollectionRequest(BaseModel):
    name: str
    vector_size: int = 1024


class CollectionInfo(BaseModel):
    name: str
    points_count: int
    vector_size: int
    distance: str


# ────────────── Collection 管理 ──────────────


@router.get("/collections")
async def list_collections(_auth: None = Depends(verify_admin_token)):
    """列出所有集合及各自文档数"""
    try:
        names = await _qdrant.list_collections()
        result = []
        for name in names:
            try:
                info = await _qdrant.collection_info(name)
                result.append({
                    "name": info["name"],
                    "points_count": info["points_count"],
                    "vector_size": info["vector_size"],
                    "distance": info["distance"],
                })
            except Exception as e:
                logger.warning(f"获取集合 '{name}' 信息失败: {e}")
                result.append({"name": name, "points_count": 0, "vector_size": 0, "distance": "unknown"})
        return {"collections": result, "total_count": len(result)}
    except Exception as e:
        logger.error(f"列出集合失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collections")
async def create_collection(req: CreateCollectionRequest, _auth: None = Depends(verify_admin_token)):
    """创建新集合"""
    if not req.name or not req.name.strip():
        raise HTTPException(status_code=400, detail="集合名称不能为空")
    # 集合名规范化：小写+下划线（与 RAG 检索共用同一条规范，避免漂移）
    name = QdrantClient.normalize_collection_name(req.name)
    try:
        result = await _qdrant.create_collection(name, vector_size=req.vector_size)
        return result
    except Exception as e:
        logger.error(f"创建集合失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/collections/{name}")
async def delete_collection(name: str, _auth: None = Depends(verify_admin_token)):
    """删除集合及其中全部文档"""
    try:
        await _qdrant.delete_collection(name)
        return {"status": "deleted", "name": name}
    except Exception as e:
        logger.error(f"删除集合失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ────────────── 知识摄入 ──────────────


@router.post("/ingest")
async def ingest_knowledge(req: IngestRequest, _auth: None = Depends(verify_admin_token)):
    """
    将知识文档摄入指定集合。

    自动分块：超过 500 字的文本按段落或窗口切分。
    """
    if not req.collection:
        raise HTTPException(status_code=400, detail="collection 不能为空")
    if not req.documents:
        raise HTTPException(status_code=400, detail="documents 不能为空")
    # 集合名规范化，与创建/检索保持一致，避免“创建 pulan_default、摄入 pulan-default”
    collection = QdrantClient.normalize_collection_name(req.collection)

    try:
        from server.rag import chunk_text

        # 1. 分块
        all_texts = []
        all_sources = []
        for doc in req.documents:
            chunks = chunk_text(doc.text, max_chars=500, overlap=100)
            for chunk in chunks:
                all_texts.append(chunk)
                all_sources.append(doc.source or "")

        # 2. 嵌入（批量）
        logger.info(f"开始嵌入 {len(all_texts)} 个文本块到集合 '{collection}'...")
        embeddings = await _embedding.embed(all_texts)

        # 3. 写入 Qdrant
        points = []
        for i, (text, source, vector) in enumerate(zip(all_texts, all_sources, embeddings)):
            points.append({
                "id": _qdrant.generate_id(),
                "vector": vector,
                "payload": {
                    "text": text,
                    "source": source,
                },
            })

        await _qdrant.upsert(collection, points)

        # 4. 统计
        total = await _qdrant.count(collection)

        return {
            "ingested": len(points),
            "total_points": total,
            "collection": collection,
            "requested_collection": req.collection,
        }
    except Exception as e:
        logger.error(f"知识摄入失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ────────────── 统计与查询 ──────────────


@router.get("/stats")
async def get_stats(collection: Optional[str] = Query(None), _auth: None = Depends(verify_admin_token)):
    """获取知识库统计信息"""
    try:
        if collection:
            collection = QdrantClient.normalize_collection_name(collection)
            info = await _qdrant.collection_info(collection)
            return {"collection": info["name"], "points_count": info["points_count"]}
        else:
            names = await _qdrant.list_collections()
            total = 0
            items = []
            for name in names:
                try:
                    cnt = await _qdrant.count(name)
                    total += cnt
                    items.append({"name": name, "points_count": cnt})
                except Exception:
                    items.append({"name": name, "points_count": 0})
            return {
                "total_collections": len(names),
                "total_points": total,
                "collections": items,
            }
    except Exception as e:
        logger.error(f"获取统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/clear")
async def clear_knowledge(collection: str = Query(...), _auth: None = Depends(verify_admin_token)):
    """清空指定集合（保留集合定义）"""
    if not collection:
        raise HTTPException(status_code=400, detail="collection 不能为空")
    try:
        collection = QdrantClient.normalize_collection_name(collection)
        await _qdrant.clear_collection(collection)
        return {"status": "cleared", "collection": collection}
    except Exception as e:
        logger.error(f"清空集合失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search")
async def search_knowledge(
    q: str = Query(..., description="搜索查询文本"),
    collection: Optional[str] = Query(None, description="指定集合，不指定则搜索全部"),
    k: int = Query(5, ge=1, le=20, description="返回条数"),
    _auth: None = Depends(verify_admin_token),
):
    """调试用：语义搜索知识库"""
    try:
        # 嵌入查询
        embeddings = await _embedding.embed([q])
        query_vector = embeddings[0]

        if collection:
            collection = QdrantClient.normalize_collection_name(collection)
            results = await _qdrant.search(collection, query_vector, limit=k)
        else:
            names = await _qdrant.list_collections()
            if not names:
                return {"results": [], "query": q}
            results = await _qdrant.search_multi(names, query_vector, limit=k)

        # 格式化
        formatted = []
        for item in results:
            formatted.append({
                "score": round(item["score"], 4),
                "text": item["payload"].get("text", "")[:200],
                "source": item["payload"].get("source", ""),
                "collection": item.get("collection", collection or ""),
            })

        return {"results": formatted, "query": q, "total": len(formatted)}
    except Exception as e:
        logger.error(f"搜索失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
