/**
 * 单条聊天气泡组件
 * - 用户消息：右对齐，蓝色背景，纯文本
 * - AI 消息：左对齐，白色背景带边框，Markdown 渲染
 * - 打字机效果：AI 消息逐字显示（打字中不渲染 Markdown）
 */
import { memo, useMemo } from 'react';
import { marked } from 'marked';

export interface ChatBubbleProps {
  role: 'user' | 'assistant';
  text: string;
  isTyping?: boolean;
}

const ChatBubble = memo(function ChatBubble({ role, text, isTyping }: ChatBubbleProps) {
  const isUser = role === 'user';

  // AI 消息：非打字状态时渲染 Markdown
  const markdownHtml = useMemo(() => {
    if (isUser || !text || isTyping) return null;
    return marked.parse(text) as string;
  }, [isUser, text, isTyping]);

  const isMarkdown = !isUser && markdownHtml && !isTyping;

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

      {isMarkdown ? (
        /* AI Markdown 气泡 */
        <div
          className="chat-markdown"
          style={{
            maxWidth: '75%',
            padding: '10px 14px',
            borderRadius: '4px 18px 18px 18px',
            background: '#FFFFFF',
            color: '#333333',
            border: '1px solid #e8e8e8',
            fontSize: 15,
            lineHeight: 1.7,
            wordBreak: 'break-word',
            boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
          }}
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      ) : (
        /* 普通文本气泡 */
        <div
          style={{
            maxWidth: '75%',
            padding: '10px 14px',
            borderRadius: isUser ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
            background: isUser ? '#1890FF' : '#FFFFFF',
            color: isUser ? '#FFFFFF' : '#333333',
            border: isUser ? 'none' : '1px solid #e8e8e8',
            fontSize: 15,
            lineHeight: 1.6,
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
      )}
    </div>
  );
});

export default ChatBubble;
