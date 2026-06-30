"""
Agent 引擎：纯对话 LLM 封装（不使用 function calling）
"""
import logging
import re
from typing import Optional

from server.agent.conversation_manager import ConversationManager
from server.services.llm_client import LlmClient, LlmClientError
from server.services.redis_client import RedisClient

logger = logging.getLogger(__name__)


def strip_markdown(text: str) -> str:
    """剥离 LLM 回复中的 Markdown 格式，输出纯文本。"""
    # 1. 去掉标题标记 (# ## ### 等)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    # 2. 去掉加粗 (**text**)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    # 3. 去掉斜体 (*text*)，注意不要误伤列表的 * 开头
    text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'\1', text)
    # 4. 去掉行内代码 (`code`)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # 5. 去掉引用标记 (> )
    text = re.sub(r'^>\s?', '', text, flags=re.MULTILINE)
    # 6. 去掉无序列表标记 (- * +)
    text = re.sub(r'^[\-\*\+]\s+', '', text, flags=re.MULTILINE)
    # 7. 去掉有序列表标记 (1. 2. 等)
    text = re.sub(r'^\d+\.\s+', '', text, flags=re.MULTILINE)
    # 8. 去掉链接 [text](url) → text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # 9. 去掉图片 ![alt](url) → alt
    text = re.sub(r'!\[([^\]]*)\]\([^)]+\)', r'\1', text)
    # 10. 去掉水平线 (--- *** ___)
    text = re.sub(r'^[\-\*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    # 11. 去掉下划线加粗(__text__)
    text = re.sub(r'__(.+?)__', r'\1', text)
    # 12. 清理多余空行（最多保留一个空行）
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


class AgentEngine:
    """对话引擎：接收用户输入 → 返回 LLM 纯文本回复"""

    def __init__(
        self,
        llm_client: LlmClient,
        redis_client: RedisClient,
    ):
        self.llm = llm_client
        self.redis = redis_client

    async def process_message(
        self,
        user_text: str,
        conversation: ConversationManager,
    ) -> str:
        """
        处理用户消息，返回 LLM 回复文本。

        流程:
        1. 保存用户消息到对话历史
        2. 检查 token 使用情况，必要时触发摘要
        3. 组装 messages（system + 摘要 + 历史 + 当前输入）
        4. 调用 LLM 生成回复
        5. 保存助手回复到对话历史
        6. 持久化到 Redis
        """
        # Step 1: 保存用户消息
        await conversation.add_message("user", user_text, self.redis)

        # Step 2: 检查 token 溢出 → 智能摘要
        await conversation.summarize_if_needed(self.llm)

        # Step 3: 获取 messages
        messages = conversation.get_messages_for_llm()

        # Step 4: 调用 LLM
        logger.info(f"发送 LLM 请求: {len(messages)} 条消息")
        try:
            reply = await self.llm.chat(messages)
        except LlmClientError as e:
            logger.error(f"LLM 调用失败: {e}")
            # 重新抛出，由上层（ws_handler）处理为 error 事件
            raise

        # Step 4.5: 剥离 Markdown 格式，确保纯文本输出
        reply = strip_markdown(reply)

        # Step 5: 保存助手回复
        await conversation.add_message("assistant", reply, self.redis)

        logger.info(f"LLM 回复: {reply[:100]}...")
        return reply
