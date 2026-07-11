"""
Qdrant HTTP API 客户端（异步）

Qdrant REST API 参考：https://qdrant.tech/documentation/interfaces/#rest-api
"""
import asyncio
import json as _json
import logging
import uuid
from typing import Optional

import httpx

from server.config import get_config

logger = logging.getLogger(__name__)


class QdrantClientError(Exception):
    """Qdrant 操作错误"""
    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class QdrantClient:
    """Qdrant 向量数据库 HTTP 客户端"""

    def __init__(self):
        cfg = get_config()
        self.base_url = cfg["qdrant"]["url"].rstrip("/")
        self.api_key = cfg["qdrant"].get("api_key", "")
        self.timeout = httpx.Timeout(30.0, connect=5.0)

    # ────────────── Collection 管理 ──────────────

    async def create_collection(self, name: str, vector_size: int = 1024, distance: str = "Cosine"):
        """创建集合（若已存在则忽略）"""
        url = f"{self.base_url}/collections/{name}"
        payload = {
            "vectors": {
                "size": vector_size,
                "distance": distance,
            }
        }
        async with self._client() as client:
            # 先检查是否存在
            exists = await self._collection_exists(client, name)
            if exists:
                logger.info(f"Qdrant collection '{name}' 已存在，跳过创建")
                return {"status": "exists", "name": name}

            r = await client.put(url, json=payload)
            if r.status_code not in (200, 201):
                raise QdrantClientError(
                    f"创建集合失败 ({r.status_code}): {r.text[:300]}", r.status_code
                )
            logger.info(f"Qdrant collection '{name}' 创建成功 (dim={vector_size}, dist={distance})")
            return {"status": "created", "name": name}

    async def delete_collection(self, name: str):
        """删除集合及其全部数据"""
        url = f"{self.base_url}/collections/{name}"
        async with self._client() as client:
            r = await client.delete(url)
            if r.status_code == 404:
                raise QdrantClientError(f"集合 '{name}' 不存在", 404)
            if r.status_code != 200:
                raise QdrantClientError(
                    f"删除集合失败 ({r.status_code}): {r.text[:300]}", r.status_code
                )
            logger.info(f"Qdrant collection '{name}' 已删除")

    async def list_collections(self) -> list[str]:
        """列出所有集合名称"""
        url = f"{self.base_url}/collections"
        async with self._client() as client:
            r = await client.get(url)
            if r.status_code != 200:
                raise QdrantClientError(f"获取集合列表失败 ({r.status_code})", r.status_code)
            data = r.json()
            collections = data.get("result", {}).get("collections", [])
            return [c["name"] for c in collections]

    async def collection_info(self, name: str) -> dict:
        """获取集合详情（向量数等）"""
        url = f"{self.base_url}/collections/{name}"
        async with self._client() as client:
            r = await client.get(url)
            if r.status_code == 404:
                raise QdrantClientError(f"集合 '{name}' 不存在", 404)
            if r.status_code != 200:
                raise QdrantClientError(f"获取集合信息失败 ({r.status_code})", r.status_code)
            data = r.json()
            result = data.get("result", {})
            config = result.get("config", {}).get("params", {}).get("vectors", {})
            return {
                "name": name,
                "points_count": result.get("points_count", 0),
                "vector_size": config.get("size", 0),
                "distance": config.get("distance", ""),
            }

    async def count(self, name: str) -> int:
        """统计集合中向量数量"""
        url = f"{self.base_url}/collections/{name}/points/count"
        async with self._client() as client:
            r = await client.post(url, json={"exact": True})
            if r.status_code != 200:
                raise QdrantClientError(f"统计失败 ({r.status_code})", r.status_code)
            return r.json().get("result", {}).get("count", 0)

    # ────────────── 数据操作 ──────────────

    async def upsert(self, collection: str, points: list[dict]):
        """
        批量写入向量点。

        points: [{"id": str, "vector": list[float], "payload": dict}, ...]
        """
        url = f"{self.base_url}/collections/{collection}/points"
        # 确保 collection 存在
        async with self._client() as client:
            exists = await self._collection_exists(client, collection)
            if not exists:
                raise QdrantClientError(f"集合 '{collection}' 不存在，请先创建", 404)

            payload = {"points": points}
            r = await client.put(url, json=payload)
            if r.status_code != 200:
                raise QdrantClientError(
                    f"upsert 失败 ({r.status_code}): {r.text[:300]}", r.status_code
                )
            logger.info(f"Qdrant upsert: {len(points)} 个点到 '{collection}'")

    async def search(self, collection: str, vector: list[float], limit: int = 5) -> list[dict]:
        """
        在指定集合中语义检索。

        返回: [{"id": str, "score": float, "payload": dict}, ...]
        """
        url = f"{self.base_url}/collections/{collection}/points/search"
        payload = {
            "vector": vector,
            "limit": limit,
            "with_payload": True,
        }
        async with self._client() as client:
            r = await client.post(url, json=payload)
            if r.status_code != 200:
                raise QdrantClientError(
                    f"搜索失败 ({r.status_code}): {r.text[:300]}", r.status_code
                )
            results = r.json().get("result", [])
            return [
                {
                    "id": item["id"],
                    "score": item["score"],
                    "payload": item.get("payload", {}),
                }
                for item in results
            ]

    async def search_multi(
        self, collections: list[str], vector: list[float], limit: int = 5
    ) -> list[dict]:
        """
        并发搜索多个集合，合并结果后按分数排序取 top_k。
        """
        if not collections:
            return []

        tasks = [self.search(c, vector, limit) for c in collections]
        results_per_collection = await asyncio.gather(*tasks, return_exceptions=True)

        merged = []
        for col_name, result in zip(collections, results_per_collection):
            if isinstance(result, Exception):
                logger.warning(f"搜索集合 '{col_name}' 失败: {result}")
                continue
            for item in result:
                item["collection"] = col_name  # 标注来源集合
                merged.append(item)

        merged.sort(key=lambda x: x["score"], reverse=True)
        return merged[:limit]

    async def delete_points(self, collection: str, doc_ids: list[str]):
        """按文档 ID 删除向量点"""
        url = f"{self.base_url}/collections/{collection}/points/delete"
        payload = {
            "filter": {
                "must": [
                    {"has_id": doc_ids}
                ]
            }
        }
        async with self._client() as client:
            r = await client.post(url, json=payload)
            if r.status_code != 200:
                raise QdrantClientError(
                    f"删除点失败 ({r.status_code}): {r.text[:300]}", r.status_code
                )
            logger.info(f"Qdrant 从 '{collection}' 删除 {len(doc_ids)} 个点")

    async def clear_collection(self, collection: str):
        """清空集合中所有数据（保留集合定义）"""
        # 删除并重建
        info = await self.collection_info(collection)
        await self.delete_collection(collection)
        await self.create_collection(collection, vector_size=info["vector_size"])
        logger.info(f"Qdrant collection '{collection}' 已清空重建")

    # ────────────── 内部辅助 ──────────────

    def _headers(self) -> dict:
        """构建请求头（含 api-key 鉴权）"""
        headers = {}
        if self.api_key:
            headers["api-key"] = self.api_key
        return headers

    def _client(self) -> httpx.AsyncClient:
        """创建带鉴权的 httpx 客户端"""
        return httpx.AsyncClient(timeout=self.timeout, headers=self._headers())

    async def _collection_exists(self, client: httpx.AsyncClient, name: str) -> bool:
        r = await client.get(f"{self.base_url}/collections/{name}")
        return r.status_code == 200

    @staticmethod
    def normalize_collection_name(name: str) -> str:
        """
        统一集合名规范化：小写 + 空格/连字符转下划线。

        所有涉及 Qdrant 集合名的入口（摄入、检索、创建）必须调用此函数，
        保证写入端与读取端看到的名称一致，避免“存进 pulan_default、查 pulan-default”的 404。
        """
        if name is None:
            return ""
        return name.strip().lower().replace(" ", "_").replace("-", "_")

    @staticmethod
    def is_wildcard(name: str) -> bool:
        """角色值是否含通配符：以 '*' 结尾的字符串"""
        return isinstance(name, str) and name.endswith("*")

    @staticmethod
    def extract_prefix(wildcard: str) -> str:
        """从通配符提取前缀：'pulan_*' → 'pulan_'，'*' → ''"""
        return wildcard[:-1] if wildcard.endswith("*") else ""

    @staticmethod
    def generate_id() -> str:
        """生成唯一文档 ID"""
        return str(uuid.uuid4())
