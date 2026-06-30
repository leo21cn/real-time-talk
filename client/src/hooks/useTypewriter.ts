/**
 * 打字机动画 Hook
 *
 * 功能:
 * - 接收 bubble_char 事件，逐字追加到显示文本
 * - 按字符间隔时间渲染（interval = duration_ms / text_length）
 * - 提供完成状态和 dismiss 触发
 */
import { useState, useRef, useCallback } from 'react';

interface TypewriterState {
  /** 当前显示的文本 */
  displayText: string;
  /** 是否已全部显示完毕 */
  isComplete: boolean;
  /** 是否应该消失 */
  shouldDismiss: boolean;
}

interface UseTypewriterReturn extends TypewriterState {
  /** 追加一个字符 */
  addChar: (char: string) => void;
  /** 触发消失 */
  dismiss: () => void;
  /** 重置状态 */
  reset: () => void;
}

export function useTypewriter(): UseTypewriterReturn {
  const [displayText, setDisplayText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const [shouldDismiss, setShouldDismiss] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addChar = useCallback((char: string) => {
    setDisplayText((prev) => prev + char);
    setIsComplete(false);
    setShouldDismiss(false);

    // 清除之前的 dismiss 定时器
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
    }

    // 设置新的 dismiss 定时器（2s 延迟 + 0.5s 可选动画）
    dismissTimerRef.current = setTimeout(() => {
      setIsComplete(true);
    }, 2000);
  }, []);

  const dismiss = useCallback(() => {
    setIsComplete(true);
    // 0.5s 后真正消失（配合 CSS transition）
    setTimeout(() => {
      setShouldDismiss(true);
    }, 500);
  }, []);

  const reset = useCallback(() => {
    setDisplayText('');
    setIsComplete(false);
    setShouldDismiss(false);
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
    }
  }, []);

  return {
    displayText,
    isComplete,
    shouldDismiss,
    addChar,
    dismiss,
    reset,
  };
}
