"""
DashScope 文本嵌入客户端

API 文档: https://help.aliyun.com/zh/model-studio/text-embedding-api
模型: text-embedding-v3, 维度 1024, 单次最多 10 条文本
"""
import asyncio
import json as _json
import logging
from typing import Optional

import httpx

from server.config import get_config

logger = logging.getLogger(__name__)


class EmbeddingClientError(Exception):
    """嵌入 API 错误"""
    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class EmbeddingClient:
    """DashScope 文本嵌入 HTTP 客户端"""

    # 已知的嵌入维度（text-embedding-v3 = 1024）
    VECTOR_SIZE = 1024

    def __init__(self):
        cfg = get_config()
        self.endpoint = cfg["embedding"]["endpoint"].rstrip("/")
        self.api_key = cfg["embedding"]["api_key"]
        self.model = cfg["embedding"]["model"]
        self.timeout = httpx.Timeout(60.0, connect=10.0)
        # 官方建议单次最多 10 条文本
        self._batch_size = 10

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """
        将文本列表转为向量列表。

        Args:
            texts: 文本列表，单次最多 10 条

        Returns:
            embeddings: 与 texts 一一对应的向量列表，每个向量 1024 维

        Raises:
            EmbeddingClientError: API 调用失败
        """
        if not texts:
            return []

        # 批量处理（若超过 batch_size 则分批）
        all_embeddings = []
        for i in range(0, len(texts), self._batch_size):
            batch = texts[i:i + self._batch_size]
            batch_embeddings = await self._embed_batch(batch)
            all_embeddings.extend(batch_embeddings)

        return all_embeddings

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        """执行一批嵌入请求（最多 batch_size 条）"""
        url = f"{self.endpoint}/embeddings"

        # DashScope embedding API 格式
        payload = {
            "model": self.model,
            "input": texts,
        }

        last_error: Optional[EmbeddingClientError] = None

        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(url, json=payload, headers=self._headers())

                if response.status_code == 200:
                    data = response.json()
                    # DashScope 返回格式: {"data": [{"embedding": [...], "index": 0}, ...]}
                    data_list = data.get("data", [])
                    # 按 index 排序确保顺序正确
                    data_list.sort(key=lambda x: x.get("index", 0))
                    embeddings = [item["embedding"] for item in data_list]
                    logger.debug(f"嵌入完成: {len(texts)} 条文本 → {len(embeddings)} 个向量")
                    return embeddings

                error_msg = self._parse_error(response)
                if response.status_code in (401, 403):
                    raise EmbeddingClientError(f"API Key 无效: {error_msg}", response.status_code)
                elif response.status_code == 429:
                    if attempt == 0:
                        await asyncio.sleep(2)
                        continue
                    raise EmbeddingClientError(f"请求过于频繁: {error_msg}", response.status_code)
                elif response.status_code >= 500:
                    if attempt == 0:
                        await asyncio.sleep(1)
                        continue
                    raise EmbeddingClientError(f"服务端错误: {error_msg}", response.status_code)
                else:
                    raise EmbeddingClientError(
                        f"API 错误 ({response.status_code}): {error_msg}", response.status_code
                    )

            except httpx.TimeoutException:
                last_error = EmbeddingClientError("嵌入请求超时")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except httpx.ConnectError:
                last_error = EmbeddingClientError("无法连接到嵌入 API")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except EmbeddingClientError:
                raise
            except Exception as e:
                last_error = EmbeddingClientError(f"嵌入调用异常: {str(e)}")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)

        raise last_error or EmbeddingClientError("嵌入未知错误")

    def _parse_error(self, response: httpx.Response) -> str:
        """从响应中提取错误消息"""
        try:
            data = response.json()
            if "error" in data:
                err = data["error"]
                if isinstance(err, dict):
                    return err.get("message", str(err))
                return str(err)
            return response.text[:300]
        except Exception:
            return response.text[:300]
