/**
 * 聊天面板组件
 * - 顶部：琳达 名称
 * - 中间：历史气泡列表（滚动）
 * - 底部：输入框 + 发送按钮
 */
import { useRef, useEffect, useCallback } from 'react';
import ChatBubble from './ChatBubble';
import type { ChatMessage } from '../types/chat';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled?: boolean;
}

export default function ChatPanel({ messages, onSend, disabled }: ChatPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 自动滚动到最新消息
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value.trim();
    if (!text || disabled) return;
    onSend(text);
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.style.height = 'auto';
    }
  }, [onSend, disabled]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // 输入框自动撑高
  const handleInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '75vh',
        maxHeight: '100vh',
        background: '#FAFAFA',
        border: '1px solid #e8e8e8',
        borderRadius: 12,
        overflow: 'hidden',
        flex: 1,
        minWidth: 360,
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      }}
    >
      {/* 面板头部 */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e8e8e8',
          background: '#FFFFFF',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            color: '#FFF',
            fontWeight: 600,
          }}
        >
          兰
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#333' }}>普兰</div>
          <div style={{ fontSize: 12, color: '#999' }}>项目管理问询助理</div>
        </div>
      </div>

      {/* 消息列表 */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#bbb',
              fontSize: 14,
              userSelect: 'none',
            }}
          >
            向普兰提问吧~
          </div>
        )}

        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            role={msg.role}
            text={msg.text}
            isTyping={msg.isTyping}
          />
        ))}
      </div>

      {/* 输入区域 */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid #e8e8e8',
          background: '#FFFFFF',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        <textarea
          ref={inputRef}
          placeholder="输入你想问的..."
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            border: '1px solid #e0e0e0',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 14,
            lineHeight: 1.5,
            outline: 'none',
            fontFamily: 'inherit',
            background: disabled ? '#f5f5f5' : '#FFFFFF',
            maxHeight: 120,
          }}
        />
        <button
          onClick={handleSend}
          disabled={disabled}
          style={{
            padding: '8px 20px',
            background: disabled ? '#d9d9d9' : '#1890FF',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            cursor: disabled ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => {
            if (!disabled) e.currentTarget.style.background = '#40a9ff';
          }}
          onMouseLeave={(e) => {
            if (!disabled) e.currentTarget.style.background = '#1890FF';
          }}
        >
          发送
        </button>
      </div>
    </div>
  );
}
