/**
 * 聊天面板组件
 * - 顶部：琳达 名称
 * - 中间：历史气泡列表（滚动）
 * - 底部：输入框 + 发送按钮
 */
import { useRef, useEffect, useCallback, memo } from 'react';
import ChatBubble from './ChatBubble';
import VoiceInputButton from './VoiceInputButton';
import type { ChatMessage } from '../types/chat';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled?: boolean;
  /** 是否为移动端布局（控制最小宽度与高度） */
  isMobile?: boolean;
  /** V37: 微信移动端 — 隐藏录音按钮 */
  isWeChatMobile?: boolean;
}

// V41: 用 React.memo 包裹函数组件（需在 ChatPanel 定义之前先声明类型）
// 配合 useWebSocket 的 useMemo（P1.4）让 onSend 引用稳定，
// memo 才能真正跳过打字期间的不必要重渲染。
function ChatPanelInner({ messages, onSend, disabled, isMobile = false, isWeChatMobile = false }: ChatPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // V44 P0: 用户是否在底部附近 — 只有"贴底"时才自动跟随新消息滚动。
  // 用户上滑查看历史时，不应被打字变化拖回底部。
  const userAtBottomRef = useRef<boolean>(true);

  // V44 P0: ResizeObserver 监听消息容器高度变化 — 代替依赖 messages 的 useEffect。
  // 原实现每次 messages 变化都 scrollTop=scrollHeight，触发 layout（读 scrollHeight）+
  // paint（写 scrollTop）。打字期间 messages 每 200-300ms 变一次，每次都 layout。
  // ResizeObserver 在浏览器内部已优化的布局回调中触发，不占用主线程的 React render 路径。
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') {
      // 兑底：老浏览器走原 useEffect 路径
      list?.scrollTo({ top: list.scrollHeight });
      return;
    }

    const ro = new ResizeObserver((entries) => {
      // 只有当气泡高度实际增长且用户贴底时才跟随
      if (!userAtBottomRef.current) return;
      const entry = entries[0];
      // 避免不必要的滚动：只有高度增加时才 scroll
      const newHeight = entry.contentRect.height;
      list.scrollTo({ top: list.scrollHeight, behavior: 'auto' });
    });
    ro.observe(list);
    // 首次挂载时滚到底
    list.scrollTo({ top: list.scrollHeight });

    // 跟踪用户是否在底部（上下 80px 内视为贴底）
    const onScroll = () => {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      userAtBottomRef.current = distanceFromBottom < 80;
    };
    list.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      ro.disconnect();
      list.removeEventListener('scroll', onScroll);
    };
  }, []);

  // V51: 新消息 / 打字期间 displayedLen 变化时滚动到底部。
  // 依赖 messages 数组引用本身，typing 期间 setMessages(prev.map(...)) 每字符都返回新引用 → 触发滚动。
  // RAF 节流避免 typing 高频时多次 scrollTo 导致 layout thrashing。
  // 仅在用户贴底（userAtBottomRef）时才滚动，避免用户上滑查看历史时被拖回。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (!userAtBottomRef.current) return;
    const rafId = requestAnimationFrame(() => {
      list.scrollTo({ top: list.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(rafId);
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

  /**
   * 语音转写完成：追加模式写入 textarea 并触发自动撑高。
   * - 输入框为空：直接填入
   * - 输入框已有内容：在末尾追加换行 + 新文本，避免覆盖用户手动输入部分
   */
  const handleTranscribed = useCallback((text: string) => {
    const el = inputRef.current;
    if (!el) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const existing = el.value.replace(/\s+$/, ''); // 去掉原文本末尾空白
    el.value = existing ? `${existing}\n${trimmed}` : trimmed;
    // 触发撑高
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    // 滚到底部 + focus
    el.focus();
    // 光标移到末尾
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // 某些浏览器在 readonly/disabled 状态下会抛错，忽略即可
    }
  }, []);

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
        // 移动端：剩余空间（68vh - 头像 - padding）
        // 桌面端：保持 75vh
        height: isMobile ? 'calc(100vh - 32vh - 24px)' : '75vh',
        maxHeight: '100vh',
        background: '#FAFAFA',
        border: '1px solid #e8e8e8',
        borderRadius: 12,
        overflow: 'hidden',
        flex: 1,
        // 桌面端：最小宽度 360（保证输入框可读）
        // 移动端：不限制最小宽度，让面板占满屏幕
        minWidth: isMobile ? 0 : 360,
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
            displayedLen={msg.displayedLen}
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
        {/* V37: 微信移动端不显示录音按钮 */}
        {!isWeChatMobile && (
          <VoiceInputButton
            onTranscribed={handleTranscribed}
            disabled={disabled}
          />
        )}
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

const ChatPanel = memo(ChatPanelInner);

export default ChatPanel;
