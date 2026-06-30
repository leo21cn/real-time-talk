"""
OpenAI 兼容 Chat Completions API 客户端
"""
import asyncio
import json as _json
import logging
from typing import AsyncGenerator, List, Optional

import httpx

from server.config import get_config

logger = logging.getLogger(__name__)


class LlmClientError(Exception):
    """LLM 调用错误"""
    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class LlmClient:
    """OpenAI 兼容 API 客户端"""

    def __init__(self):
        cfg = get_config()
        self.endpoint = cfg["llm"]["endpoint"].rstrip("/")
        self.api_key = cfg["llm"]["api_key"]
        self.model = cfg["llm"]["model"]
        self.max_tokens = cfg["llm"]["max_tokens"]
        self.timeout = httpx.Timeout(60.0, connect=10.0)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def chat(self, messages: List[dict], max_tokens: Optional[int] = None) -> str:
        """
        发送对话请求，返回纯文本回复。

        Args:
            messages: [{"role": "system/user/assistant", "content": "..."}]
            max_tokens: 覆盖默认 max_tokens

        Returns:
            LLM 回复文本

        Raises:
            LlmClientError: API 调用失败
        """
        url = f"{self.endpoint}/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens or self.max_tokens,
            "stream": False,
        }

        last_error: Optional[LlmClientError] = None

        # 重试 1 次（总共 2 次尝试）
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(url, json=payload, headers=self._headers())

                if response.status_code == 200:
                    data = response.json()
                    choices = data.get("choices", [])
                    if choices:
                        content = choices[0].get("message", {}).get("content", "")
                        return content.strip()
                    return ""

                # 处理错误状态码
                error_msg = self._parse_error(response)
                if response.status_code in (401, 403):
                    raise LlmClientError(f"API Key 无效: {error_msg}", response.status_code)
                elif response.status_code == 429:
                    if attempt == 0:
                        await asyncio.sleep(2)  # 限流等待
                        continue
                    raise LlmClientError(f"请求过于频繁: {error_msg}", response.status_code)
                elif response.status_code >= 500:
                    if attempt == 0:
                        await asyncio.sleep(1)
                        continue
                    raise LlmClientError(f"服务端错误: {error_msg}", response.status_code)
                else:
                    raise LlmClientError(f"API 错误 ({response.status_code}): {error_msg}", response.status_code)

            except httpx.TimeoutException:
                last_error = LlmClientError("请求超时，请稍后重试")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except httpx.ConnectError:
                last_error = LlmClientError("无法连接到 LLM API")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except LlmClientError:
                raise  # 非重试错误直接抛出
            except Exception as e:
                last_error = LlmClientError(f"LLM 调用异常: {str(e)}")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)

        raise last_error or LlmClientError("未知错误")

    async def chat_stream(self, messages: List[dict], max_tokens: Optional[int] = None) -> AsyncGenerator[str, None]:
        """
        流式对话请求，逐 token 产出文本。

        Args:
            messages: [{"role": "system/user/assistant", "content": "..."}]
            max_tokens: 覆盖默认 max_tokens

        Yields:
            LLM 回复的文本片段（若干字符/token）

        Raises:
            LlmClientError: API 调用失败
        """
        url = f"{self.endpoint}/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens or self.max_tokens,
            "stream": True,
        }

        last_error: Optional[LlmClientError] = None

        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    async with client.stream("POST", url, json=payload, headers=self._headers()) as response:
                        if response.status_code != 200:
                            error_text = await response.aread()
                            if response.status_code == 429 and attempt == 0:
                                await asyncio.sleep(2)
                                continue
                            raise LlmClientError(
                                f"流式请求失败 ({response.status_code}): {error_text[:200].decode('utf-8', errors='replace')}",
                                response.status_code
                            )

                        async for line in response.aiter_lines():
                            if not line or not line.startswith("data: "):
                                continue
                            data = line[6:]
                            if data == "[DONE]":
                                return
                            try:
                                chunk = _json.loads(data)
                                choices = chunk.get("choices", [])
                                if not choices:
                                    continue
                                delta = choices[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    yield content
                            except (_json.JSONDecodeError, IndexError, KeyError):
                                continue
                        return

            except httpx.TimeoutException:
                last_error = LlmClientError("流式请求超时")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except httpx.ConnectError:
                last_error = LlmClientError("无法连接到 LLM API")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except LlmClientError:
                raise
            except Exception as e:
                last_error = LlmClientError(f"流式调用异常: {str(e)}")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)

        raise last_error or LlmClientError("流式未知错误")

    def _parse_error(self, response: httpx.Response) -> str:
        """从响应中提取错误消息"""
        try:
            data = response.json()
            if "error" in data:
                err = data["error"]
                if isinstance(err, dict):
                    return err.get("message", str(err))
                return str(err)
            return response.text[:200]
        except Exception:
            return response.text[:200]
