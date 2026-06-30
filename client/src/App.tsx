/**
 * RealTimeTalk 根组件 — 聊天对话模式
 *
 * 布局：左侧普兰形象 + 右侧对话面板
 * 状态流转:
 *   Idle → (发送) → Thinking → (segment_ready) → Speaking
 *   Speaking → (ended+ack) → Speaking(下段) 或 Bridging
 *   Speaking/Bridging → (all_completed) → Idle
 *   任意非Idle → (点击形象) → cancel → Idle
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState } from './types/events';
import type { ServerEvent } from './types/events';
import type { ChatMessage } from './types/chat';
import { useWebSocket } from './hooks/useWebSocket';
import AvatarView from './components/AvatarView';
import type { AvatarViewHandle } from './components/AvatarView';
import ChatPanel from './components/ChatPanel';
import ErrorBubble from './components/ErrorBubble';

// 资源路径（v=8 确保浏览器加载 yuv420p 无透明版）
const IDLE_SRC = '/api/clips/idle/idle_breathing.webm?v=8';
const ANALYSIS_SRC = '/api/clips/idle/idle_breathing.webm?v=9';

// ─── 消息 ID 生成器 ───
let msgCounter = 0;
function nextMsgId(): string {
  msgCounter++;
  return `msg_${Date.now()}_${msgCounter}`;
}

// ─── 持久化 AudioContext（解锁浏览器自动播放策略）───
let audioCtx: AudioContext | null = null;

function unlockAudio() {
  if (!audioCtx) {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      audioCtx = new AudioCtx();
    }
  }
  if (audioCtx) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    if (audioCtx.state === 'running') {
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.01);
      } catch (_) {}
    }
  }
}

export default function App() {
  // ─── 状态 ───
  const [appState, setAppState] = useState<AppState>(AppState.Idle);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState<number>(-1);

  // Refs
  const avatarRef = useRef<AvatarViewHandle>(null);
  const appStateRef = useRef<AppState>(AppState.Idle);
  const deferredIdleRef = useRef(false);
  const currentSegmentIndexRef = useRef(-1);
  appStateRef.current = appState;

  useEffect(() => {
    currentSegmentIndexRef.current = currentSegmentIndex;
  }, [currentSegmentIndex]);

  // ─── WebSocket 事件处理 ───
  const handleSegmentReady = useCallback((event: ServerEvent) => {
    if (event.type !== 'segment_ready') return;
    const { index, video_url } = event;
    setCurrentSegmentIndex(index);
    setAppState(AppState.Speaking);
    avatarRef.current?.play(video_url);
  }, []);

  const handleWsEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'connected':
        console.log('会话已连接:', event.session_token);
        break;

      case 'state_change':
        if (event.state === 'idle' && appStateRef.current !== AppState.Speaking) {
          setAppState(AppState.Idle);
        }
        break;

      case 'segment_ready':
        handleSegmentReady(event);
        break;

      case 'bubble_char':
        // 追加字符到最后一条 AI 消息
        setMessages(prev => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, text: last.text + event.char };
          }
          return msgs;
        });
        break;

      case 'bubble_dismiss':
        // 聊天模式下不消除气泡，段间加换行
        setMessages(prev => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, text: last.text + '\n\n' };
          }
          return msgs;
        });
        break;

      case 'play_analysis':
        if (appStateRef.current !== AppState.Speaking) {
          setAppState(AppState.Bridging);
          avatarRef.current?.playLoop(ANALYSIS_SRC);
        }
        break;

      case 'all_completed':
        setCurrentSegmentIndex(-1);
        setMessages(prev => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, isTyping: false };
          }
          return msgs;
        });
        break;

      case 'return_to_idle':
        if (appStateRef.current === AppState.Speaking ||
            appStateRef.current === AppState.Bridging ||
            appStateRef.current === AppState.Thinking) {
          deferredIdleRef.current = true;
        } else {
          setAppState(AppState.Idle);
          avatarRef.current?.playLoop(IDLE_SRC);
          setMessages(prev => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, isTyping: false };
            }
            return msgs;
          });
        }
        break;

      case 'error':
        console.error('服务端错误:', event.message);
        setErrorMessage(event.message);
        setAppState(AppState.Idle);
        avatarRef.current?.playLoop(IDLE_SRC);
        setMessages(prev => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant' && last.isTyping) {
            msgs.pop();
          }
          return msgs;
        });
        break;

      default:
        break;
    }
  }, [handleSegmentReady]);

  const handleDisconnect = useCallback(() => {
    console.log('WebSocket 断开，等待重连...');
  }, []);

  const ws = useWebSocket({
    onEvent: handleWsEvent,
    onDisconnect: handleDisconnect,
  });

  // ─── 视频播放完毕 ───
  // 段间保持最后一帧可见，仅末段切换到 idle
  useEffect(() => {
    const handler = () => {
      if (appStateRef.current === AppState.Speaking) {
        // 先发送 ack，再立即切 idle，不等 return_to_idle
        ws.sendAck(currentSegmentIndexRef.current);
        if (deferredIdleRef.current) {
          // 末段：切换到 idle 循环
          deferredIdleRef.current = false;
          setAppState(AppState.Idle);
          avatarRef.current?.playLoop(IDLE_SRC);
          setMessages(prev => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, isTyping: false };
            }
            return msgs;
          });
        }
        // 非末段：保持主视频最后一帧可见，等下一个 segment_ready 自然切换
      }
    };
    window.addEventListener('video-ended', handler);
    return () => window.removeEventListener('video-ended', handler);
  }, []);

  // ─── 用户交互 ───

  /** 发送消息 */
  const handleSend = useCallback((text: string) => {
    if (!text.trim()) return;
    unlockAudio();

    deferredIdleRef.current = false;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      text: text.trim(),
      timestamp: Date.now(),
    };

    const aiMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'assistant',
      text: '',
      isTyping: true,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMsg, aiMsg]);

    setAppState(AppState.Thinking);
    avatarRef.current?.playLoop(ANALYSIS_SRC);

    ws.sendMessage(text);
  }, [ws]);

  /** 清除错误 */
  const handleErrorDismiss = useCallback(() => {
    setErrorMessage('');
  }, []);

  const isProcessing = appState === AppState.Thinking ||
                       appState === AppState.Speaking ||
                       appState === AppState.Bridging;

  // ─── 渲染 ───
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: '#FFFFFF',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        boxSizing: 'border-box',
        gap: '24px',
      }}
    >
      {/* 左侧：普兰形象 */}
      <AvatarView
        ref={avatarRef}
        idleSrc={IDLE_SRC}
      />

      {/* 右侧：聊天面板 */}
      <ChatPanel
        messages={messages}
        onSend={handleSend}
        disabled={isProcessing}
      />

      {/* 错误提示 */}
      {errorMessage && (
        <ErrorBubble
          message={errorMessage}
          onDismiss={handleErrorDismiss}
        />
      )}

      {/* 状态指示器（调试用） */}
      <div
        style={{
          position: 'fixed',
          bottom: '8px',
          right: '8px',
          fontSize: '11px',
          color: '#ccc',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        {appState}
      </div>

      {/* Markdown 气泡样式 */}
      <style>{`
        .chat-markdown h3 {
          margin: 8px 0 4px;
          font-size: 15px;
          font-weight: 600;
          color: #1a1a1a;
        }
        .chat-markdown h3:first-child {
          margin-top: 0;
        }
        .chat-markdown p {
          margin: 4px 0;
        }
        .chat-markdown p:last-child {
          margin-bottom: 0;
        }
        .chat-markdown ul, .chat-markdown ol {
          margin: 4px 0;
          padding-left: 20px;
        }
        .chat-markdown li {
          margin: 2px 0;
        }
        .chat-markdown strong {
          color: #1a1a1a;
          font-weight: 600;
        }
        .chat-markdown code {
          background: #f0f0f0;
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 13px;
          font-family: 'SF Mono', 'Fira Code', monospace;
          word-break: break-all;
        }
        .chat-markdown blockquote {
          margin: 6px 0;
          padding: 4px 10px;
          border-left: 3px solid #1890FF;
          background: #f6f9ff;
          color: #555;
        }
        .chat-markdown hr {
          border: none;
          border-top: 1px solid #e8e8e8;
          margin: 8px 0;
        }
      `}</style>
    </div>
  );
}
