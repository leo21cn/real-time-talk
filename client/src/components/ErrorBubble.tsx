/**
 * 错误提示气泡
 *
 * - 样式与 SpeechBubble 一致
 * - 红色警告色调
 * - 显示 4 秒后自动消失
 */
import { useEffect, useState } from 'react';

interface ErrorBubbleProps {
  message: string;
  onDismiss: () => void;
}

export default function ErrorBubble({ message, onDismiss }: ErrorBubbleProps) {
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    setOpacity(1);

    // 4 秒后自动淡出
    const fadeTimer = setTimeout(() => {
      setOpacity(0);
    }, 3500);

    // 淡出后通知父组件移除
    const dismissTimer = setTimeout(() => {
      onDismiss();
    }, 4000);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(dismissTimer);
    };
  }, [message, onDismiss]);

  if (!message) return null;

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
        background: 'rgba(255, 80, 80, 0.92)',
        borderRadius: '12px',
        boxShadow: '0 4px 16px rgba(255, 0, 0, 0.15)',
        fontSize: '16px',
        color: '#fff',
        lineHeight: '1.6',
        textAlign: 'center',
        wordBreak: 'break-word',
        opacity: opacity,
        transition: 'opacity 0.5s ease',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        zIndex: 15,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {message}
    </div>
  );
}
