"""
Qdrant 集合解析器

统一处理 ROLE_COLLECTIONS 中角色值到实际检索集合列表的转换。

支持 4 种角色值语义：
- "*"          → list_collections() 返回的全部集合
- "pulan_*"    → list_collections() 后按 "pulan_" 前缀过滤
- "pulan_xxx"  → ["pulan_xxx"]（精确匹配单一集合，自动 normalize）
- ["a", "b"]   → [normalize(a), normalize(b)]（精确匹配多集合）

调用方：
- server/agent/agent_engine.py: AgentEngine._retrieve_rag_context
- server/api/ws_handler.py: WsHandler._retrieve_rag_context
"""
import logging
from typing import List

from server.services.qdrant_client import QdrantClient

logger = logging.getLogger(__name__)


async def resolve_search_collections(qdrant, role_cols) -> List[str]:
    """
    根据 role_cols 解析出实际要检索的 Qdrant 集合列表。

    参数:
        qdrant: QdrantClient 实例（需有 list_collections 方法）
        role_cols: ROLE_COLLECTIONS 中某个角色的值（str 或 list[str]）

    返回:
        规范化后的集合名列表（已 normalize 名称）

    行为:
        - None / 空字符串 / 空列表 → 返回空列表（调用方应跳过 RAG）
        - "*"          → 全部 qdrant 集合
        - "pulan_*"    → qdrant 集合中以 pulan_ 开头的
        - "pulan_xxx"  → ["pulan_xxx"]（normalize）
        - ["a", "b"]   → [normalize(a), normalize(b)]
    """
    # 列表形式：精确匹配多集合
    if isinstance(role_cols, list):
        collections = [QdrantClient.normalize_collection_name(c) for c in role_cols]
        logger.info(f"resolve_search_collections: list → {collections}")
        return collections

    # 非字符串：视为空
    if not isinstance(role_cols, str):
        logger.warning(f"resolve_search_collections: 非字符串 role_cols={role_cols!r}, 返回空列表")
        return []

    # 空字符串
    if not role_cols.strip():
        logger.warning("resolve_search_collections: 空字符串, 返回空列表")
        return []

    # 通配符
    if QdrantClient.is_wildcard(role_cols):
        prefix = QdrantClient.extract_prefix(role_cols)
        all_collections = await qdrant.list_collections()
        if prefix:
            collections = [c for c in all_collections if c.startswith(prefix)]
            logger.info(
                f"resolve_search_collections: wildcard '{role_cols}' "
                f"→ prefix='{prefix}', 命中 {len(collections)}/{len(all_collections)} 个集合: {collections}"
            )
        else:
            # "*"：返回全部
            collections = all_collections
            logger.info(
                f"resolve_search_collections: '*' → 全部 {len(collections)} 个集合: {collections}"
            )
        return collections

    # 精确匹配单一集合（自动 normalize）
    collection = QdrantClient.normalize_collection_name(role_cols)
    logger.info(f"resolve_search_collections: scalar '{role_cols}' → [{collection}]")
    return [collection]