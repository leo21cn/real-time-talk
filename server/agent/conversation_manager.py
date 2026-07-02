"""
对话历史管理器：维护 messages 列表 + Redis 持久化 + Token 溢出智能摘要
"""
import logging
from typing import List, Optional, TYPE_CHECKING

from server.models.message import Message

if TYPE_CHECKING:
    from server.services.redis_client import RedisClient
    from server.services.llm_client import LlmClient

logger = logging.getLogger(__name__)

# 估算：1 个中文字 ≈ 1.5 tokens
CHARS_PER_TOKEN = 1.0 / 1.5
# 当总 token 数超过此阈值时触发摘要（留 1500 tokens 给近期对话 + 回答）
SUMMARY_THRESHOLD_TOKENS = 3500


class ConversationManager:
    """
    对话历史管理器。
    每个 Session 拥有独立实例。
    """

    def __init__(self, session_token: str, system_prompt: str):
        self.session_token = session_token
        self.system_prompt = system_prompt
        self.messages: List[Message] = []
        self._summary: Optional[str] = None  # 早期对话摘要

    async def load_from_redis(self, redis_client: "RedisClient"):
        """从 Redis 恢复对话历史"""
        history = await redis_client.get_history(self.session_token)
        self.messages = history
        logger.info(f"从 Redis 加载 {len(history)} 条历史消息: session={self.session_token}")

    async def add_message(self, role: str, content: str, redis_client: Optional["RedisClient"] = None):
        """添加一条消息并持久化到 Redis"""
        msg = Message(role=role, content=content)
        self.messages.append(msg)
        if redis_client:
            await redis_client.save_message(self.session_token, msg)

    def get_messages_for_llm(self, max_tokens: int = 2048, rag_context: Optional[str] = None) -> List[dict]:
        """
        获取发送给 LLM 的完整 messages 列表。
        包含 system prompt + RAG 上下文 + 可能的摘要 + 对话历史。
        """
        messages = []

        # System prompt
        messages.append({"role": "system", "content": self.system_prompt})

        # RAG 上下文（在 system prompt 之后、对话历史之前）
        if rag_context:
            messages.append({"role": "system", "content": rag_context})

        # 如果有摘要，添加为 system 消息
        if self._summary:
            messages.append({
                "role": "system",
                "content": f"[对话历史摘要]\n{self._summary}"
            })

        # 过滤掉 analytics 的临时消息（语义分析 prompt 不应出现在对话历史中）
        for msg in self.messages:
            # 跳过语义分析的 user 消息（这些消息内容包含 SEMANTIC_ANALYSIS_PROMPT）
            content = msg.content
            if msg.role == "user" and "可选标签（仅输出标签名，逗号分隔）" in content:
                continue
            if msg.role == "assistant" and all(
                label in content.lower()
                for label in ["greeting", "explaining", "conclusion"]
            ) and len(content) < 200:
                # 可能是语义分析返回的纯标签，跳过
                if "," in content and len(content.split(",")) >= 1:
                    # 简单判断：标签返回通常很短且全是标签名
                    is_pure_labels = True
                    for part in content.replace("，", ",").split(","):
                        part = part.strip().lower()
                        if part and part not in {
                            "greeting", "introduction", "explaining", "listing",
                            "emphasis", "example", "analysis", "comparison",
                            "transition", "conclusion", "thanks",
                        }:
                            is_pure_labels = False
                            break
                    if is_pure_labels:
                        continue

            messages.append(msg.to_dict())

        return messages

    async def summarize_if_needed(self, llm_client: "LlmClient"):
        """
        检查是否需要触发智能摘要。
        当对话历史接近 token 上限时，将早期对话压缩为摘要。
        """
        total_chars = sum(len(m.content) for m in self.messages)
        estimated_tokens = int(total_chars * 1.5)  # 粗略估算

        if estimated_tokens < SUMMARY_THRESHOLD_TOKENS:
            return  # 无需摘要

        # 保留最近 10 条消息，对更早的消息做摘要
        if len(self.messages) <= 10:
            return

        early_messages = self.messages[:-10]
        recent_messages = self.messages[-10:]

        # 构建摘要 prompt
        history_text = "\n".join(
            f"{m.role}: {m.content}" for m in early_messages
        )
        summary_prompt = f"""请将以下对话历史压缩为简洁的摘要（保留关键信息和上下文，不超过 500 字）：

{history_text}

摘要："""

        try:
            summary_response = await llm_client.chat(
                [{"role": "user", "content": summary_prompt}],
                max_tokens=800,
            )
            self._summary = summary_response.strip()
            self.messages = recent_messages
            logger.info(f"对话摘要完成，保留最近 {len(recent_messages)} 条消息")
        except Exception as e:
            logger.warning(f"对话摘要失败: {e}，保留完整历史")

    def get_recent_messages(self, count: int = 10) -> List[Message]:
        """获取最近 N 条消息"""
        return self.messages[-count:] if self.messages else []
