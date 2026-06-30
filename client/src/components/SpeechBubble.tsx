/**
 * 对话气泡组件
 *
 * - 半透明毛玻璃效果
 * - 打字机逐字显示
 * - 延迟 2s → 0.5s fade-out 消失
 */
import { useEffect, useState } from 'react';

interface SpeechBubbleProps {
  /** 要显示的文字 */
  text: string;
  /** 是否正在打字 */
  isTyping: boolean;
  /** 是否已完成（触发消失计时） */
  isComplete: boolean;
  /** 是否应该消失 */
  shouldDismiss: boolean;
  /** 错误模式 */
  isError?: boolean;
}

export default function SpeechBubble({
  text,
  isTyping,
  isComplete,
  shouldDismiss,
  isError = false,
}: SpeechBubbleProps) {
  const [opacity, setOpacity] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // 有新文字时立即显示
    if (text && isTyping) {
      setOpacity(1);
      setVisible(true);
    }
  }, [text, isTyping]);

  useEffect(() => {
    if (isComplete && !shouldDismiss) {
      // 2s 延迟 → 0.5s fade-out
      const timer = setTimeout(() => {
        setOpacity(0);
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [isComplete, shouldDismiss]);

  useEffect(() => {
    if (shouldDismiss) {
      setVisible(false);
      setOpacity(0);
    }
  }, [shouldDismiss]);

  if (!visible || !text) return null;

  const bgColor = isError
    ? 'rgba(255, 100, 100, 0.9)'
    : 'rgba(255, 255, 255, 0.85)';

  const textColor = isError ? '#fff' : '#333';

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '75%',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: '400px',
        minWidth: '60px',
        padding: '12px 20px',
        background: bgColor,
        borderRadius: '12px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
        fontSize: '16px',
        color: textColor,
        lineHeight: '1.6',
        textAlign: 'center',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        opacity: opacity,
        transition: 'opacity 0.5s ease',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        zIndex: 10,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {text}
      {/* 打字光标 */}
      {isTyping && (
        <span
          style={{
            display: 'inline-block',
            width: '2px',
            height: '16px',
            background: '#333',
            marginLeft: '2px',
            verticalAlign: 'text-bottom',
            animation: 'blink 0.8s infinite',
          }}
        />
      )}
      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
