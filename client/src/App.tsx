/**
 * RealTimeTalk 根组件 — 聊天对话模式
 *
 * 布局：左侧普兰形象 + 右侧对话面板
 * 状态流转:
 *   Idle → (发送) → Thinking → (segment_ready) → Speaking
 *   Speaking → (video-ended, playlist消费) → Speaking(下段) 或 Idle
 *   任意非Idle → (点击形象) → cancel → Idle
 *
 * V20: 单泡泡模式 — 整轮对话只维护一条 assistant 消息，
 * 所有段文本追加到同一消息，视频通过 videoPlaylistRef 队列管理。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState } from './types/events';
import type { ServerEvent } from './types/events';
import type { ChatMessage } from './types/chat';
import { useWebSocket } from './hooks/useWebSocket';
import { useClipPreloader } from './hooks/useClipPreloader';
import AvatarView from './components/AvatarView';
import type { AvatarViewHandle } from './components/AvatarView';
import ChatPanel from './components/ChatPanel';
import ErrorBubble from './components/ErrorBubble';
import {
  startSwitchTrace,
  type SwitchTrace,
} from './services/avatarDiagnostics';

// 资源路径（v=10 是压缩后的低码率 mp4（移动端 ~60KB）；v=11 是 analysis 占位）
// mp4 副本作为移动端 fallback（iOS Safari / 微信内置浏览器对 WebM/VP9 解码不稳定）
const IDLE_SRC = '/api/clips/idle/idle_breathing.webm?v=10';
const IDLE_MP4_SRC = '/api/clips/idle/idle_breathing.mp4?v=10';
const ANALYSIS_SRC = '/api/clips/idle/idle_breathing.webm?v=11';
const ANALYSIS_MP4_SRC = '/api/clips/idle/idle_breathing.mp4?v=11';

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

// V25: 客户端本地打字机动画（单泡泡模式）。
// - 服务端 segment_ready 一次性携带 text + duration_ms（视频/语音时长）
// - 打字速度 = durationMs / 剩余字符数（1.0x 天然速率，对准语音）
// - 钳位 [50, 160] ms/char（约 6-20 字/秒），避免极端快/慢
// - 后续段到来时从 displayedLenRef 继续（不清零）
function startTypingAnimation(
  msgId: string,
  fullText: string,
  durationMs: number,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  timersRef: React.MutableRefObject<Set<ReturnType<typeof setInterval>>>,
  displayedLenRef: React.MutableRefObject<number>,
  startFrom: number = 0,
) {
  if (!fullText) {
    displayedLenRef.current = 0;
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, text: '', displayedLen: 0, isTyping: false } : m
    ));
    return;
  }

  const charCount = fullText.length;
  if (startFrom >= charCount) return; // 已经全部显示

  const remainingChars = charCount - startFrom;
  // V25: 天然速率（匹配语音速度），钳位 [50, 160] ms/char
  // 不乘 slowdown factor，避免“语音完了字还没打完”
  const interval = durationMs > 0
    ? Math.max(50, Math.min(160, Math.round(durationMs / remainingChars)))
    : 80;

  // 设置完整 text + 起始 displayedLen
  setMessages(prev => prev.map(m =>
    m.id === msgId
      ? {
          ...m,
          text: fullText,
          displayedLen: startFrom,
          isTyping: false,
        }
      : m
  ));

  let displayed = startFrom;
  const timer = setInterval(() => {
    displayed += 1;
    if (displayed >= charCount) {
      clearInterval(timer);
      timersRef.current.delete(timer);
      displayedLenRef.current = charCount;
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, displayedLen: charCount } : m
      ));
      return;
    }
    displayedLenRef.current = displayed;
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, displayedLen: displayed } : m
    ));
  }, interval);
  timersRef.current.add(timer);

  // 兑底：动画超过预期时长 + 500ms 强制完成（避免 setInterval 漏失）
  const maxTypingMs = remainingChars * interval + 500;
  const fallback = setTimeout(() => {
    clearInterval(timer);
    timersRef.current.delete(timer);
    displayedLenRef.current = charCount;
    setMessages(prev => prev.map(m =>
      m.id === msgId && (m.displayedLen ?? 0) < charCount
        ? { ...m, displayedLen: charCount }
        : m
    ));
  }, maxTypingMs);
  timersRef.current.add(fallback);
}

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

  // V22: 单泡泡模式核心 refs
  // - activeAiMsgIdRef: 当前活跃 AI 消息 ID（整轮对话只有一条 assistant 消息）
  // - activeAiTextRef: 当前 AI 消息的累积完整文本
  // - videoPlaylistRef: 视频播放队列（{url, duration_ms}，video-ended 时逐个消费）
  // - responseCompleteRef: 服务端是否已推送 response_complete
  // - displayedLenRef: V22 同步跟踪当前打字位置（避免从 React 异步 state 读取导致始终为 0）
  // - isVideoPlayingRef: V23 当前是否有视频正在播放（防止 response_complete 提前切 idle）
  const activeAiMsgIdRef = useRef<string | null>(null);
  const activeAiTextRef = useRef<string>('');
  const videoPlaylistRef = useRef<Array<{ url: string; duration_ms: number }>>([]);
  const responseCompleteRef = useRef<boolean>(false);
  const displayedLenRef = useRef<number>(0);
  const isVideoPlayingRef = useRef<boolean>(false);

  // V17: 当前会话的 msg_seq（从服务端的 session_reset / segment_ready 等事件读取）。
  // 用于过滤旧会话的残留事件（上一轮取消后还未发出的 segment_ready）。
  const currentMsgSeqRef = useRef(0);
  // V5: WebSocket 连接时获得的 session_token。用于自己拼出段 N+1 的 URL，
  // 提前启动 preloadVideo（不等 segment_ready 推送）。服务端生成段 N+1 期间
  // fetch 会 404，由 AvatarView 内部 200ms 重试直到就绪。
  const sessionTokenRef = useRef<string | null>(null);
  // V5: 已知的总段数（从 manifest 获取后存入）。为 null 表示还没拉 manifest。
  const totalSegmentsRef = useRef<number | null>(null);
  // V8: 打字机动画 timer 列表（用于清理，避免内存泄漏）
  const typingTimersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());

  useEffect(() => {
    currentSegmentIndexRef.current = currentSegmentIndex;
  }, [currentSegmentIndex]);

  // V2: 监听 AvatarView 发出的埋点事件，记录段间切换耗时
  const activeTracesRef = useRef<Map<string, SwitchTrace>>(new Map());
  useEffect(() => {
    const handleSrcSet = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        url: string;
        originalUrl: string;
        ts: number;
      };
      const trace = startSwitchTrace(detail.originalUrl);
      trace.markIdbDone(detail.url);
      trace.markSrcSet();
      (trace as any).__srcSetTs = detail.ts;
      activeTracesRef.current.set(detail.originalUrl, trace);
    };
    const handleCanplay = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        url: string;
        originalUrl: string;
        ts: number;
      };
      const trace = activeTracesRef.current.get(detail.originalUrl);
      if (trace) {
        trace.markCanplay();
        activeTracesRef.current.delete(detail.originalUrl);
      }
    };
    window.addEventListener('avatar-src-set', handleSrcSet);
    window.addEventListener('avatar-canplay', handleCanplay);
    return () => {
      window.removeEventListener('avatar-src-set', handleSrcSet);
      window.removeEventListener('avatar-canplay', handleCanplay);
    };
  }, []);

  // ─── 响应式布局：屏幕宽度 < 768px 时切换为竖排布局 ───
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
    };
    handler(mql);
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    } else {
      mql.addListener(handler);
      return () => mql.removeListener(handler);
    }
  }, []);

  // ─── 预取 Hook：页面加载即启动 + 首交互后重试（V2）───
  const { prefetchOnUnlock: prefetchClipsOnUnlock } = useClipPreloader();

  // V2: 页面加载即开始预取（不阻塞首屏，fetch() 不需用户交互）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      prefetchClipsOnUnlock();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [prefetchClipsOnUnlock]);

  // ─── 移动端自动播放解锁：首次用户交互后才允许视频播放 ───
  useEffect(() => {
    if (!isMobile) return;
    if (!needsUserTap) return;

    const onFirstTap = () => {
      unlockAudio();
      avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
      setNeedsUserTap(false);
      prefetchClipsOnUnlock();
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
  }, [isMobile, needsUserTap, prefetchClipsOnUnlock]);

  // V5: 主动预加载段 N+1（如果存在）。拼 URL，不依赖服务端 push。
  const tryPreloadNext = useCallback((currentIndex: number, total: number | null) => {
    if (total === null) return;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= total) return;
    const token = sessionTokenRef.current;
    if (!token) return;
    const nextUrl = `/api/media/${token}/segment_${nextIndex}.webm`;
    avatarRef.current?.preloadVideo(nextUrl);
  }, []);

  // ─── V20: 单泡泡模式 segment_ready 处理 ───
  // 核心逻辑：
  //   1. 取 activeAiMsgIdRef 找到唯一 assistant 消息
  //   2. 将 segment.text 追加到该消息的 text 字段
  //   3. 将 {video_url, duration_ms} 推入 videoPlaylistRef 队列
  //   4. 首段 (index===0): 启动打字动画 + 立即播放视频 + setAppState(Speaking)
  //   5. 后续段: 扩展打字动画 + 预加载视频 + 等待 video-ended 消费
  const handleSegmentReady = useCallback((event: ServerEvent) => {
    if (event.type !== 'segment_ready') return;
    const { index, video_url, text, duration_ms } = event;

    // V17: 丢弃旧会话的残留 segment_ready
    const eventSeq = (event as any).msg_seq as number | undefined;
    if (typeof eventSeq === 'number' && eventSeq < currentMsgSeqRef.current) {
      console.warn(`[V17] 丢弃旧会话残留 segment_ready (index=${index}, seq=${eventSeq} < ${currentMsgSeqRef.current})`);
      return;
    }

    const msgId = activeAiMsgIdRef.current;
    if (!msgId) return;

    // V20: 累积文本
    const prevText = activeAiTextRef.current;
    const newFullText = prevText + text;
    activeAiTextRef.current = newFullText;

    setCurrentSegmentIndex(index);

    // V22: 清除上一次的打字动画 timer（如果有），为新文本重新启动
    typingTimersRef.current.forEach(t => { try { clearInterval(t); } catch {} });
    typingTimersRef.current.clear();

    // V22: 从 ref 同步读取当前打字位置（避免 React state 异步导致的始终为 0 问题）
    const startFrom = index === 0 ? 0 : displayedLenRef.current;
    startTypingAnimation(msgId, newFullText, duration_ms, setMessages, typingTimersRef, displayedLenRef, startFrom);

    if (index === 0) {
      // V23: 首段直接播放（不推入队列，避免播放列表立即为空导致 response_complete 提前切 idle）
      isVideoPlayingRef.current = true;
      setAppState(AppState.Speaking);
      avatarRef.current?.play(video_url);
    } else {
      // V23: 后续段推入播放列表，由 video-ended 逐个消费
      videoPlaylistRef.current.push({ url: video_url, duration_ms });
      avatarRef.current?.preloadVideo(video_url);
    }

    // V5: 拉 manifest + 预加载段 N+1
    if (totalSegmentsRef.current === null) {
      fetch('/api/clips/manifest')
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
          if (m && typeof m.count === 'number') {
            totalSegmentsRef.current = m.count;
            tryPreloadNext(index, totalSegmentsRef.current);
          }
        })
        .catch(() => { /* ignore */ });
    } else {
      tryPreloadNext(index, totalSegmentsRef.current);
    }
  }, [tryPreloadNext]);

  // V6: 处理 segment_pending — LLM 输出完成后立即启动预加载。
  // V20: 简化为直接预加载视频 URL（不再使用 preloadedBuffer 队列）。
  const handleSegmentPending = useCallback((event: ServerEvent) => {
    if (event.type !== 'segment_pending') return;
    const { index, video_url } = event;

    const eventSeq = (event as any).msg_seq as number | undefined;
    if (typeof eventSeq === 'number' && eventSeq < currentMsgSeqRef.current) {
      console.warn(`[V17] 丢弃旧会话残留 segment_pending (index=${index}, seq=${eventSeq})`);
      return;
    }

    // V20: 直接预加载（不经过 buffer）
    avatarRef.current?.preloadVideo(video_url);
  }, []);

  // V23: 统一 idle 过渡检查。video-ended / response_complete / return_to_idle
  // 三者到达顺序不确定（无 ack 后服务端一次性推送），任一触发都检查是否该切 idle。
  // isVideoPlayingRef 防止单段回答时 response_complete 提前切 idle（视频还在播放）。
  // 也兼容纯文本回答（无视频段，状态保持 Thinking）。
  const tryGoIdle = useCallback(() => {
    if (isVideoPlayingRef.current) return;                    // V23: 视频还在播放（首段未结束）
    if (videoPlaylistRef.current.length > 0) return;          // 还有视频未播
    if (!deferredIdleRef.current && !responseCompleteRef.current) return; // 未收到完成信号
    if (appStateRef.current !== AppState.Speaking &&
        appStateRef.current !== AppState.Bridging &&
        appStateRef.current !== AppState.Thinking) return;    // V22: 兼容纯文本回答

    deferredIdleRef.current = false;
    responseCompleteRef.current = false;
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
  }, []);

  const handleWsEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'connected':
        console.log('会话已连接:', event.session_token);
        sessionTokenRef.current = event.session_token;
        break;

      case 'session_reset':
        // V17: 服务端推送新会话标记，记录最新 msg_seq
        currentMsgSeqRef.current = event.msg_seq;
        console.log(`[V17] session_reset: seq=${event.msg_seq}`);
        break;

      case 'segment_pending':
        handleSegmentPending(event);
        break;

      case 'state_change':
        // V22: 从非 Speaking 切到 idle 时也播放 idle 循环（解决纯文本回答后动画不回归的问题）
        if (event.state === 'idle' && appStateRef.current !== AppState.Speaking) {
          setAppState(AppState.Idle);
          avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
        }
        break;

      case 'segment_ready':
        handleSegmentReady(event);
        break;

      case 'bubble_char':
        // V8: 服务端不再推 bubble_char，此 case 为兼容保留（不动作）。
        break;

      case 'bubble_dismiss':
        // V8: 服务端不再推 bubble_dismiss，此 case 为兼容保留。
        break;

      case 'play_analysis':
        if (appStateRef.current !== AppState.Speaking) {
          setAppState(AppState.Bridging);
          avatarRef.current?.playLoop(USE_MP4 ? ANALYSIS_MP4_SRC : ANALYSIS_SRC);
        }
        break;

      // V20: response_complete — 服务端所有段已推送完毕
      case 'response_complete':
        responseCompleteRef.current = true;
        console.log(`[V20] response_complete: total_segments=${event.total_segments}`);
        // V21: 如果视频已播完（队列空），立即切 idle（消除竞态）
        tryGoIdle();
        break;

      case 'all_completed':
        // V21: 不再强制 displayedLen = text.length（会导致文字瞬间全部出现）。
        // 打字动画通过自身的 interval + fallback 自然完成，用户看到渐进显示。
        setCurrentSegmentIndex(-1);
        setMessages(prev => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, isTyping: false };
          }
          return msgs;
        });
        // V21: 兜底 — 如果视频已播完，立即切 idle
        tryGoIdle();
        break;

      case 'return_to_idle':
        // V21: 统一通过 tryGoIdle 判断。deferredIdleRef 标记"服务端已要求切 idle"，
        // 待 video-ended 或本 handler 触发 tryGoIdle 时实际切换。
        deferredIdleRef.current = true;
        tryGoIdle();
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
  }, [handleSegmentReady, handleSegmentPending]);

  const handleDisconnect = useCallback(() => {
    console.log('WebSocket 断开，等待重连...');
  }, []);

  const ws = useWebSocket({
    onEvent: handleWsEvent,
    onDisconnect: handleDisconnect,
  });

  // ─── V23: 视频播放完毕 — 从 videoPlaylistRef 队列消费下一段 ───
  // 不再发送 ack_played。pop 队列 → 有视频则播放 → 无视频则清 isVideoPlayingRef 并调 tryGoIdle。
  // isVideoPlayingRef 防止单段回答时 completion 事件提前切 idle。
  useEffect(() => {
    const handler = () => {
      if (appStateRef.current !== AppState.Speaking) return;

      const next = videoPlaylistRef.current.shift();
      if (next) {
        // 有下一段视频：播放它（isVideoPlayingRef 保持 true）
        setCurrentSegmentIndex(currentSegmentIndexRef.current + 1);
        avatarRef.current?.play(next.url);
      } else {
        // 队列空 → 当前视频播完，没有后续 → 清标志并检查是否切 idle
        isVideoPlayingRef.current = false;
        tryGoIdle();
      }
    };
    window.addEventListener('video-ended', handler);
    return () => window.removeEventListener('video-ended', handler);
  }, [tryGoIdle]);

  // ─── 用户交互 ───

  /** 发送消息 */
  const handleSend = useCallback((text: string) => {
    if (!text.trim()) return;
    unlockAudio();

    // V18: 预升 msg_seq
    currentMsgSeqRef.current += 1;
    console.log(`[V18] handleSend: 预升 currentMsgSeqRef → ${currentMsgSeqRef.current}`);

    deferredIdleRef.current = false;
    responseCompleteRef.current = false;
    isVideoPlayingRef.current = false;

    // V20: 清理上一轮会话状态
    setCurrentSegmentIndex(-1);
    currentSegmentIndexRef.current = -1;
    videoPlaylistRef.current = [];
    activeAiTextRef.current = '';
    displayedLenRef.current = 0;

    // V8: 清理打字机动画 timers
    typingTimersRef.current.forEach(t => {
      try { clearInterval(t); } catch { /* ignore */ }
    });
    typingTimersRef.current.clear();

    // V12: 清理 AvatarView 内部的 blob/warmup/preload 缓存
    avatarRef.current?.clearPreloadedBlobs();

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

    // V20: 记录活跃 AI 消息 ID（单泡泡模式核心）
    activeAiMsgIdRef.current = aiMsg.id;

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
    padding: isMobile ? 'max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom)) 8px' : '20px',
    boxSizing: 'border-box',
    gap: isMobile ? '8px' : '24px',
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
            unlockAudio();
            avatarRef.current?.playLoop(USE_MP4 ? IDLE_MP4_SRC : IDLE_SRC);
            setNeedsUserTap(false);
            prefetchClipsOnUnlock();
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
