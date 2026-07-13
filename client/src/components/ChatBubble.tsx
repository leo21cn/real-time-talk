/**
 * 单条聊天气泡组件
 * - 用户消息：右对齐，蓝色背景，纯文本
 * - AI 消息：左对齐，白色背景带边框，pre-wrap 纯文本（保持换行一致性）
 * - V8 打字机效果：按 displayedLen 控制可见字符（由 App.tsx 动画 hook 驱动）
 */
import { memo } from 'react';

export interface ChatBubbleProps {
  role: 'user' | 'assistant';
  text: string;
  isTyping?: boolean;
  /** V8: 已显示字符数（undefined = 全部显示） */
  displayedLen?: number;
}

const ChatBubble = memo(function ChatBubble({ role, text, isTyping, displayedLen }: ChatBubbleProps) {
  const isUser = role === 'user';

  // V8: 按 displayedLen 裁剪可见字符，保留原 text 用于预占据高度（避免动画时高度跳动）
  const visibleText = !isUser && displayedLen !== undefined
    ? text.slice(0, displayedLen)
    : text;
  // 动画进行中：是否还在打字（displayedLen < text.length）
  const isAnimating = !isUser && displayedLen !== undefined && displayedLen < text.length;

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

      {/* 文本气泡 — AI 与用户统一 pre-wrap，避兔打字/完成两阶段换行不一致 */}
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
        {/* V24: 不再预留全文高度——气泡随实际可见文字增长。消除"底部大幅空白"问题。 */}
        {/* V26: 思考态（isTyping && !text）跳过 \u00A0，三点动画本身就是内容 */}
        {(!text && isTyping) ? null : (visibleText || '\u00A0')}
        {/* V24: 打字机光标（动画进行中） */}
        {isAnimating && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: '1em',
              background: '#333',
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'typingBlink 0.8s step-end infinite',
            }}
          />
        )}
        {/* V7 兼容：旧 isTyping=true 且无 text 时显示三点动画 */}
        {!text && isTyping && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', verticalAlign: 'middle' }}>
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
        )}
      </div>
    </div>
  );
});

export default ChatBubble;
