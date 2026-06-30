/**
 * 输入框组件
 *
 * - 单行输入 + 发送按钮
 * - 回车发送
 * - 空消息拦截（trim 后为空不允许发送）
 * - 超长截断 > 2000 字
 * - 自动 focus
 */
import { useState, useRef, useEffect, useCallback } from 'react';

const MAX_LENGTH = 2000;

interface InputBoxProps {
  onSend: (text: string) => void;
  visible: boolean;
}

export default function InputBox({ onSend, visible }: InputBoxProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动获得焦点
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return; // 空消息拦截

    // 超长截断
    const text = trimmed.length > MAX_LENGTH ? trimmed.slice(0, MAX_LENGTH) : trimmed;
    onSend(text);
    setInput('');
  }, [input, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '10%',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 16px',
        background: 'rgba(255, 255, 255, 0.95)',
        borderRadius: '24px',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.1)',
        zIndex: 20,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入你想问的..."
        maxLength={MAX_LENGTH}
        style={{
          border: 'none',
          outline: 'none',
          fontSize: '16px',
          padding: '8px 4px',
          minWidth: '280px',
          maxWidth: '400px',
          background: 'transparent',
          color: '#333',
        }}
      />
      <button
        onClick={handleSend}
        disabled={!input.trim()}
        style={{
          border: 'none',
          background: input.trim() ? '#4A90D9' : '#ccc',
          color: '#fff',
          borderRadius: '50%',
          width: '36px',
          height: '36px',
          fontSize: '18px',
          cursor: input.trim() ? 'pointer' : 'not-allowed',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
        title="发送 (Enter)"
      >
        ↑
      </button>
    </div>
  );
}
