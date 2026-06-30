"""
Redis 操作封装
"""
import json
import logging
from typing import List, Optional

import redis.asyncio as aioredis

from server.config import get_config
from server.models.message import Message

logger = logging.getLogger(__name__)


class RedisClientError(Exception):
    """Redis 操作错误"""
    pass


class RedisClient:
    """Redis 客户端封装"""

    def __init__(self):
        cfg = get_config()
        self.redis_url = cfg["redis"]["url"]
        self.session_ttl = cfg["redis"]["session_ttl_hours"] * 3600  # 转为秒
        self._client: Optional[aioredis.Redis] = None

    async def connect(self) -> bool:
        """建立 Redis 连接并验证可用性"""
        try:
            self._client = aioredis.from_url(self.redis_url, decode_responses=True)
            await self._client.ping()
            logger.info(f"Redis 连接成功: {self.redis_url}")
            return True
        except Exception as e:
            logger.error(f"Redis 连接失败: {e}")
            raise RedisClientError(f"Redis 不可用: {e}")

    async def disconnect(self):
        """关闭 Redis 连接"""
        if self._client:
            await self._client.close()
            self._client = None

    @property
    def client(self) -> aioredis.Redis:
        if not self._client:
            raise RedisClientError("Redis 未连接")
        return self._client

    # ---- Session 状态 ----

    def _session_state_key(self, token: str) -> str:
        return f"session:{token}:state"

    def _session_history_key(self, token: str) -> str:
        return f"session:{token}:history"

    async def set_session_state(self, token: str, state: str) -> None:
        """设置会话状态"""
        await self.client.set(self._session_state_key(token), state, ex=self.session_ttl)

    async def get_session_state(self, token: str) -> Optional[str]:
        """获取会话状态"""
        return await self.client.get(self._session_state_key(token))

    # ---- 对话历史 ----

    async def save_message(self, token: str, message: Message) -> None:
        """保存一条对话消息到历史"""
        key = self._session_history_key(token)
        data = json.dumps(message.to_redis_dict(), ensure_ascii=False)
        await self.client.rpush(key, data)
        await self.client.expire(key, self.session_ttl)

    async def get_history(self, token: str) -> List[Message]:
        """获取完整对话历史"""
        key = self._session_history_key(token)
        raw_list = await self.client.lrange(key, 0, -1)
        messages = []
        for raw in raw_list:
            try:
                data = json.loads(raw)
                messages.append(Message.from_redis_dict(data))
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"解析对话历史失败: {e}")
        return messages

    async def clear_history(self, token: str) -> None:
        """清除会话对话历史"""
        await self.client.delete(self._session_history_key(token))

    # ---- Session 生命周期 ----

    async def session_exists(self, token: str) -> bool:
        """检查会话是否存在（通过 state key 判断，因为新会话可能尚无历史）"""
        return await self.client.exists(self._session_state_key(token)) > 0

    async def refresh_ttl(self, token: str) -> None:
        """刷新会话 TTL"""
        for key_suffix in ["state", "history"]:
            key = f"session:{token}:{key_suffix}"
            await self.client.expire(key, self.session_ttl)

    async def delete_session(self, token: str) -> None:
        """删除会话所有 Redis 数据"""
        keys = [self._session_state_key(token), self._session_history_key(token)]
        await self.client.delete(*keys)
