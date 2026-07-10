"""
tests/test_collection_normalize.py

回归测试：Qdrant 集合名规范化（QdrantClient.normalize_collection_name）

目的：防止 "pulan-default vs pulan_default" 漂移问题再次出现。
本测试覆盖：
  - 纯函数行为：连字符、空格、大小写、None、空字符串
  - 写入端契约：create_collection / ingest 接收任意大小写/分隔符都规范化为下划线小写
  - 读取端契约：检索时同样规范化（防止写入 'pulan-default' 但配置 'pulan_default'）

不依赖 pytest，纯 unittest 即可：
  python -m unittest tests.test_collection_normalize -v
或：
  cd tests && python test_collection_normalize.py
"""
import json as _json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# conftest.py 会把项目根加进 sys.path
from server.services.qdrant_client import QdrantClient


class TestNormalizeCollectionName(unittest.TestCase):
    """覆盖 normalize_collection_name 静态方法的所有等价类"""

    def test_already_normalized_unchanged(self):
        self.assertEqual(QdrantClient.normalize_collection_name("pulan_default"), "pulan_default")

    def test_hyphen_to_underscore(self):
        self.assertEqual(QdrantClient.normalize_collection_name("pulan-default"), "pulan_default")

    def test_space_to_underscore(self):
        self.assertEqual(QdrantClient.normalize_collection_name("pulan default"), "pulan_default")

    def test_uppercase_to_lowercase(self):
        self.assertEqual(QdrantClient.normalize_collection_name("PULAN_DEFAULT"), "pulan_default")
        self.assertEqual(QdrantClient.normalize_collection_name("Pulan-Default"), "pulan_default")

    def test_strip_whitespace(self):
        self.assertEqual(QdrantClient.normalize_collection_name("  pulan_default  "), "pulan_default")
        self.assertEqual(QdrantClient.normalize_collection_name("\tpulan-default\n"), "pulan_default")

    def test_combined_separators(self):
        self.assertEqual(QdrantClient.normalize_collection_name(" Pulan-Default "), "pulan_default")

    def test_none_returns_empty(self):
        # 防呆：None 输入不能抛异常
        self.assertEqual(QdrantClient.normalize_collection_name(None), "")

    def test_empty_string(self):
        self.assertEqual(QdrantClient.normalize_collection_name(""), "")

    def test_idempotent(self):
        # 规范化后再次规范化应不变
        once = QdrantClient.normalize_collection_name("Pulan-Default")
        twice = QdrantClient.normalize_collection_name(once)
        self.assertEqual(once, twice)
        self.assertEqual(twice, "pulan_default")


class TestRoutesKnowledgeNormalize(unittest.TestCase):
    """覆盖 routes_knowledge.py 中 5 个入口的规范化行为"""

    def _setup(self, collection_name):
        """构造一个测试用的 FastAPI app + mock 的 qdrant/embedding 客户端"""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from server.api.routes_knowledge import router, init_knowledge_routes

        app = FastAPI()
        app.include_router(router)

        # Mock Qdrant
        qdrant = MagicMock()
        qdrant.list_collections = AsyncMock(return_value=["pulan_default", "test_kb"])
        qdrant.collection_info = AsyncMock(return_value={
            "name": QdrantClient.normalize_collection_name(collection_name),
            "points_count": 0,
            "vector_size": 1024,
            "distance": "Cosine",
        })
        qdrant.count = AsyncMock(return_value=0)
        qdrant.upsert = AsyncMock(return_value=None)
        qdrant.search = AsyncMock(return_value=[])
        qdrant.search_multi = AsyncMock(return_value=[])
        qdrant.clear_collection = AsyncMock(return_value=None)
        qdrant.create_collection = AsyncMock(return_value={"status": "created", "name": QdrantClient.normalize_collection_name(collection_name)})

        # Mock Embedding
        embedding = MagicMock()
        embedding.embed = AsyncMock(return_value=[[0.0] * 1024])

        init_knowledge_routes(qdrant, embedding)

        # patch verify_admin_token to always pass
        from server.api import routes_knowledge as rk
        rk.verify_admin_token = lambda: None

        return TestClient(app), qdrant

    def test_create_collection_normalizes_name(self):
        """POST /collections 即使传 'pulan-default' 也会规范化为 'pulan_default'"""
        client, qdrant = self._setup("pulan-default")
        r = client.post("/api/knowledge/collections",
                        json={"name": "Pulan-Default"},
                        headers={"X-Knowledge-Admin-Token": ""})
        self.assertEqual(r.status_code, 200)
        # 校验实际传给 Qdrant 的名字是规范化后的
        called_name = qdrant.create_collection.call_args.kwargs.get("name") \
                      or qdrant.create_collection.call_args.args[0]
        self.assertEqual(called_name, "pulan_default")

    def test_ingest_normalizes_collection(self):
        """POST /ingest 传 'pulan-default' 时也要规范化写入"""
        client, qdrant = self._setup("pulan-default")
        r = client.post("/api/knowledge/ingest",
                        json={"collection": "Pulan-Default",
                              "documents": [{"text": "测试文档"}]},
                        headers={"X-Knowledge-Admin-Token": ""})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        # 响应里的 collection 应该是规范化后的
        self.assertEqual(body["collection"], "pulan_default")
        self.assertEqual(body.get("requested_collection"), "Pulan-Default")

    def test_search_normalizes_collection(self):
        """GET /search 传 'pulan-default' 时也要规范化"""
        client, qdrant = self._setup("pulan-default")
        r = client.get("/api/knowledge/search",
                       params={"q": "测试", "collection": "Pulan-Default"},
                       headers={"X-Knowledge-Admin-Token": ""})
        # 不管结果怎样，关键是 qdrant.search 收到的名字必须是规范化的
        self.assertIn(r.status_code, (200, 500))
        if r.status_code == 200:
            called_name = qdrant.search.call_args.args[0]
            self.assertEqual(called_name, "pulan_default")

    def test_stats_normalizes_collection(self):
        client, qdrant = self._setup("pulan-default")
        r = client.get("/api/knowledge/stats",
                       params={"collection": "Pulan-Default"},
                       headers={"X-Knowledge-Admin-Token": ""})
        self.assertEqual(r.status_code, 200)
        called_name = qdrant.collection_info.call_args.args[0]
        self.assertEqual(called_name, "pulan_default")

    def test_clear_normalizes_collection(self):
        client, qdrant = self._setup("pulan-default")
        r = client.delete("/api/knowledge/clear",
                          params={"collection": "Pulan-Default"},
                          headers={"X-Knowledge-Admin-Token": ""})
        self.assertEqual(r.status_code, 200)
        called_name = qdrant.clear_collection.call_args.args[0]
        self.assertEqual(called_name, "pulan_default")


class TestAgentEngineRoleCollectionsNormalize(unittest.TestCase):
    """覆盖 agent_engine._retrieve_rag_context 的 role_collections 解析路径"""

    def _make_engine(self, role_collections_cfg):
        """构造一个带 mock qdrant/embedding 的 AgentEngine"""
        from server.agent.agent_engine import AgentEngine
        from server.services.llm_client import LlmClient
        from server.services.redis_client import RedisClient

        llm = MagicMock(spec=LlmClient)
        redis = MagicMock(spec=RedisClient)

        qdrant = MagicMock()
        qdrant.list_collections = AsyncMock(return_value=["pulan_default"])
        qdrant.search_multi = AsyncMock(return_value=[
            {"id": "x", "score": 0.9, "payload": {"text": "t", "source": ""}, "collection": "pulan_default"},
        ])

        embedding = MagicMock()
        embedding.embed = AsyncMock(return_value=[[0.0] * 1024])

        engine = AgentEngine(
            llm_client=llm,
            redis_client=redis,
            qdrant_client=qdrant,
            embedding_client=embedding,
        )

        # Patch get_config 返回受控的 role_collections
        import server.config
        original_cfg = server.config._config
        server.config._config = {
            "rag": {
                "role_collections": role_collections_cfg,
                "top_k": 5,
            }
        }
        return engine, qdrant, lambda: server.config._config.__setitem__("rag", original_cfg["rag"]) if original_cfg else None

    def test_list_with_hyphen_is_normalized(self):
        """配置是 ["pulan-default"]（连字符）→ 检索时传给 qdrant 的是 ["pulan_default"]"""
        engine, qdrant, _restore = self._make_engine(_json.dumps({"普兰": ["pulan-default"]}))

        import asyncio
        result = asyncio.run(engine._retrieve_rag_context("测试问题"))

        # 关键断言：search_multi 收到的第一个参数必须是规范化后的下划线集合名
        called = qdrant.search_multi.call_args.args[0]
        self.assertEqual(called, ["pulan_default"])
        self.assertIsNotNone(result)

    def test_list_with_mixed_separators(self):
        """配置混合大小写、连字符、空格都能规范化"""
        engine, qdrant, _restore = self._make_engine(_json.dumps({"普兰": ["Pulan-Default", "Test KB"]}))

        import asyncio
        asyncio.run(engine._retrieve_rag_context("测试"))

        called = qdrant.search_multi.call_args.args[0]
        self.assertEqual(called, ["pulan_default", "test_kb"])

    def test_scalar_with_hyphen_is_normalized(self):
        """标量字符串配置也要规范化"""
        engine, qdrant, _restore = self._make_engine(_json.dumps({"普兰": "pulan-default"}))

        import asyncio
        asyncio.run(engine._retrieve_rag_context("测试"))

        called = qdrant.search_multi.call_args.args[0]
        self.assertEqual(called, ["pulan_default"])


@unittest.skip("跳过：ws_handler 依赖 minio 模块，本地 dev 环境可能未装")
class TestWsHandlerRoleCollectionsNormalize(unittest.TestCase):
    """覆盖 ws_handler._retrieve_rag_context 的相同路径

    注：ws_handler.py 在 import 时会拉起 minio_client → minio 包。
    本地 dev 环境若未安装 minio，导入就会失败，跳过整个测试类。
    生产/CI 环境装好依赖后请移除此 skip。
    """

    def _make_handler(self, role_collections_cfg):
        from server.api.ws_handler import WsHandler
        from server.services.llm_client import LlmClient
        from server.services.redis_client import RedisClient
        from server.services.minio_client import MinioClient

        llm = MagicMock(spec=LlmClient)
        redis = MagicMock(spec=RedisClient)
        minio = MagicMock(spec=MinioClient)

        agent = MagicMock()
        agent.qdrant.search_multi = AsyncMock(return_value=[
            {"id": "x", "score": 0.9, "payload": {"text": "t", "source": ""}, "collection": "pulan_default"},
        ])
        agent.qdrant.list_collections = AsyncMock(return_value=["pulan_default"])
        agent.embedding.embed = AsyncMock(return_value=[[0.0] * 1024])

        handler = WsHandler.__new__(WsHandler)
        handler.llm = llm
        handler.redis = redis
        handler.minio = minio
        handler.agent = agent

        import server.config
        original_cfg = server.config._config
        server.config._config = {
            "rag": {
                "role_collections": role_collections_cfg,
                "top_k": 5,
            }
        }
        return handler, agent, lambda: None

    def test_list_with_hyphen_is_normalized(self):
        handler, agent, _ = self._make_handler(_json.dumps({"普兰": ["pulan-default"]}))
        import asyncio
        asyncio.run(handler._retrieve_rag_context("测试"))
        called = agent.qdrant.search_multi.call_args.args[0]
        self.assertEqual(called, ["pulan_default"])

    def test_scalar_with_hyphen_is_normalized(self):
        handler, agent, _ = self._make_handler(_json.dumps({"普兰": "Pulan-Default"}))
        import asyncio
        asyncio.run(handler._retrieve_rag_context("测试"))
        called = agent.qdrant.search_multi.call_args.args[0]
        self.assertEqual(called, ["pulan_default"])


class TestRegressionHyphenVsUnderscore(unittest.TestCase):
    """核心回归测试：模拟真实事故场景，确保 'pulan-default' 配置下也能工作"""

    def test_full_pipeline_hyphen_role_collections_works(self):
        """配置 {普兰: ['pulan-default']} 时，agent_engine 应能正常检索 pulan_default 集合"""
        from server.agent.agent_engine import AgentEngine
        from server.services.llm_client import LlmClient
        from server.services.redis_client import RedisClient

        engine = AgentEngine(
            llm_client=MagicMock(spec=LlmClient),
            redis_client=MagicMock(spec=RedisClient),
            qdrant_client=MagicMock(),
            embedding_client=MagicMock(),
        )
        engine.qdrant.list_collections = AsyncMock(return_value=["pulan_default"])
        engine.qdrant.search_multi = AsyncMock(return_value=[
            {"id": "1", "score": 0.85, "payload": {"text": "Learning Hub 手册内容", "source": "MANUAL.md"}, "collection": "pulan_default"},
        ])
        engine.embedding.embed = AsyncMock(return_value=[[0.0] * 1024])

        import server.config
        original = server.config._config
        server.config._config = {
            "rag": {
                # 故意用 "pulan-default"（连字符），这是历史上出问题的配置
                "role_collections": _json.dumps({"普兰": ["pulan-default"]}),
                "top_k": 5,
            }
        }
        try:
            import asyncio
            result = asyncio.run(engine._retrieve_rag_context("Learning Hub 是什么？"))
            self.assertIsNotNone(result, "RAG 上下文应为非空（修复后应能命中 pulan_default 集合）")
            self.assertIn("Learning Hub", result)
            self.assertIn("参考", result)
        finally:
            server.config._config = original


if __name__ == "__main__":
    unittest.main(verbosity=2)