"""
会话状态数据模型
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from server.pipeline.streaming_pipeline import StreamingPipeline
    from server.agent.conversation_manager import ConversationManager


class SessionState(StrEnum):
    """会话播放状态"""
    IDLE = "idle"
    THINKING = "thinking"
    SPEAKING = "speaking"
    BRIDGING = "bridging"


@dataclass
class SessionContext:
    """单个会话的完整上下文"""
    token: str
    state: SessionState = SessionState.IDLE
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    # 对话管理（由 agent 层管理）
    conversation: Optional["ConversationManager"] = None

    # 当前活跃的 Pipeline（生成中时存在）
    pipeline: Optional["StreamingPipeline"] = None

    # WebSocket 引用（用于服务端主动关闭）
    ws: Optional[object] = None

    def is_active(self) -> bool:
        """检查会话是否处于活跃状态（非 idle）"""
        return self.state != SessionState.IDLE
