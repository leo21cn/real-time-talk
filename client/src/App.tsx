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

// 资源路径（v=8 确保浏览器加载 yuv420p 无透明版；v=9 是 analysis 备用副本）
// mp4 副本作为移动端 fallback（iOS Safari / 微信内置浏览器对 WebM/VP9 解码不稳定）
const IDLE_SRC = '/api/clips/idle/idle_breathing.webm?v=8';
const IDLE_MP4_SRC = '/api/clips/idle/idle_breathing.mp4?v=8';
const ANALYSIS_SRC = '/api/clips/idle/idle_breathing.webm?v=9';
const ANALYSIS_MP4_SRC = '/api/clips/idle/idle_breathing.mp4?v=9';

// 检测是否需要优先使用 mp4（iOS Safari、微信内置浏览器对 WebM/VP9 支持不稳定）
function prefersMp4(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iOS 全系列 + 微信内置浏览器
  return /iPhone|iPad|iPod/i.test(ua) || /MicroMessenger/i.test(ua);
}
const USE_MP4 = prefersMp4();

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
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [needsUserTap, setNeedsUserTap] = useState<boolean>(true);

  // Refs
  const avatarRef = useRef<AvatarViewHandle>(null);
  const appStateRef = useRef<AppState>(AppState.Idle);
  const deferredIdleRef = useRef(false);
  const currentSegmentIndexRef = useRef(-1);
  appStateRef.current = appState;

  useEffect(() => {
    currentSegmentIndexRef.current = currentSegmentIndex;
  }, [currentSegmentIndex]);

  // ─── 响应式布局：屏幕宽度 < 768px 时切换为竖排布局 ───
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
    };
    handler(mql);
    // 监听屏幕旋转 / 浏览器 resize
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    } else {
      // 旧版 Safari 兼容
      mql.addListener(handler);
      return () => mql.removeListener(handler);
    }
  }, []);

  // ─── 移动端自动播放解锁：首次用户交互后才允许视频播放 ───
  // iOS Safari / 微信内置浏览器要求用户必须点击页面后才能播放视频
  useEffect(() => {
    if (!isMobile) return; // 桌面端不需要引导遮罩
    if (!needsUserTap) return;

    const onFirstTap = () => {
      unlockAudio();
      // 显式触发 idle 播放，确保用户首次交互后视频立即显示
      avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
      setNeedsUserTap(false);
      // 解绑事件（仅触发一次）
      window.removeEventListener('pointerdown', onFirstTap);
      window.removeEventListener('touchstart', onFirstTap);
      window.removeEventListener('keydown', onFirstTap);
    };

    window.addEventListener('pointerdown', onFirstTap, { once: true, passive: true });
    window.addEventListener('touchstart', onFirstTap, { once: true, passive: true });
    window.addEventListener('keydown', onFirstTap, { once: true });

    return () => {
      window.removeEventListener('pointerdown', onFirstTap);
      window.removeEventListener('touchstart', onFirstTap);
      window.removeEventListener('keydown', onFirstTap);
    };
  }, [isMobile, needsUserTap]);

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
          avatarRef.current?.playLoop(USE_MP4 ? ANALYSIS_MP4_SRC : ANALYSIS_SRC);
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
          avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
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
        avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
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
          avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
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
    avatarRef.current?.playLoop(USE_MP4 ? ANALYSIS_MP4_SRC : ANALYSIS_SRC);

    ws.sendMessage(text);
  }, [ws]);

  /** 清除错误 */
  const handleErrorDismiss = useCallback(() => {
    setErrorMessage('');
  }, []);

  const isProcessing = appState === AppState.Thinking ||
                       appState === AppState.Speaking ||
                       appState === AppState.Bridging;

  // ─── 响应式布局参数 ───
  const rootStyle: React.CSSProperties = {
    width: '100vw',
    height: '100vh',
    background: '#FFFFFF',
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: isMobile ? 'stretch' : 'center',
    justifyContent: 'center',
    // 小屏：上下安全区 + 更小 padding
    padding: isMobile ? 'max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom)) 8px' : '20px',
    boxSizing: 'border-box',
    gap: isMobile ? '8px' : '24px',
    // 小屏：竖排（形象上 / 聊天下）；大屏：横排
    flexDirection: isMobile ? 'column' : 'row',
  };

  // ─── 渲染 ───
  return (
    <div style={rootStyle}>
      {/* 形象（移动端在上方缩小，桌面端在左侧） */}
      <AvatarView
        ref={avatarRef}
        idleSrc={IDLE_SRC}
        idleMp4Src={IDLE_MP4_SRC}
        analysisSrc={ANALYSIS_SRC}
        analysisMp4Src={ANALYSIS_MP4_SRC}
        isMobile={isMobile}
      />

      {/* 聊天面板（移动端占满下方，桌面端在右侧） */}
      <ChatPanel
        messages={messages}
        onSend={handleSend}
        disabled={isProcessing}
        isMobile={isMobile}
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

      {/* 移动端首次访问引导遮罩：点击解锁视频自动播放 */}
      {isMobile && needsUserTap && (
        <div
          onClick={() => {
            // 显式调用一次（pointerdown 会先触发，但这里确保 click 也生效）
            unlockAudio();
            avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
            setNeedsUserTap(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(255, 255, 255, 0.92)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            cursor: 'pointer',
            userSelect: 'none',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
              boxShadow: '0 8px 24px rgba(102, 126, 234, 0.4)',
              animation: 'pulse 2s ease-in-out infinite',
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="#fff">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#333', marginBottom: 8 }}>
            点击与普兰对话
          </div>
          <div style={{ fontSize: 13, color: '#999' }}>
            点击屏幕开始
          </div>
          <style>{`
            @keyframes pulse {
              0%, 100% { transform: scale(1); box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4); }
              50% { transform: scale(1.05); box-shadow: 0 8px 32px rgba(102, 126, 234, 0.6); }
            }
          `}</style>
        </div>
      )}

      {/* 气泡样式 */}
      <style>{`
        @keyframes typingBounce {
          from { opacity: 0.3; transform: translateY(0); }
          to { opacity: 1; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}
