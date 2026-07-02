/**
 * 单条聊天气泡组件
 * - 用户消息：右对齐，蓝色背景，纯文本
 * - AI 消息：左对齐，白色背景带边框，pre-wrap 纯文本（保持换行一致性）
 * - 打字机效果：AI 消息逐字显示
 */
import { memo } from 'react';

export interface ChatBubbleProps {
  role: 'user' | 'assistant';
  text: string;
  isTyping?: boolean;
}

const ChatBubble = memo(function ChatBubble({ role, text, isTyping }: ChatBubbleProps) {
  const isUser = role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        padding: '4px 16px',
      }}
    >
      {/* AI 头像占位 */}
      {!isUser && (
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: '#f0f0f0',
            marginRight: 8,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            color: '#999',
          }}
        >
          兰
        </div>
      )}

      {/* 文本气泡 — AI 与用户统一 pre-wrap，避免打字/完成两阶段换行不一致 */}
      <div
        style={{
          maxWidth: '75%',
          padding: '10px 14px',
          borderRadius: isUser ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
          background: isUser ? '#1890FF' : '#FFFFFF',
          color: isUser ? '#FFFFFF' : '#333333',
          border: isUser ? 'none' : '1px solid #e8e8e8',
          fontSize: 15,
          lineHeight: 1.7,
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          boxShadow: isUser ? '0 1px 3px rgba(24,144,255,0.3)' : '0 1px 2px rgba(0,0,0,0.06)',
          minHeight: 20,
        }}
      >
        {text || (isTyping ? (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center', height: 20 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#bbb',
              animation: 'typingBounce 0.6s infinite alternate',
            }} />
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#bbb',
              animation: 'typingBounce 0.6s 0.2s infinite alternate',
            }} />
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#bbb',
              animation: 'typingBounce 0.6s 0.4s infinite alternate',
            }} />
          </span>
        ) : null)}
      </div>
    </div>
  );
});

export default ChatBubble;
