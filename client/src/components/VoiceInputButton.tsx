/**
 * 语音输入按钮（按住说话）
 *
 * 交互：
 * - 鼠标按下 / 触摸开始 → 开始录音
 * - 鼠标松开 / 触摸结束 / 离开 → 停止录音并自动提交转写
 * - ESC 键 → 取消录音（由 useVoiceRecorder Hook 监听）
 *
 * 录音中弹层（按钮上方）：
 *   - 实时音量条
 *   - 倒计时（00:xx / 01:00）
 *   - 提示文案（松开发送，按 ESC 取消）
 *
 * 转写完成后回调 onTranscribed(text)，由 ChatPanel 填入 textarea。
 */
import { useCallback, useRef, useState } from 'react';
import {
  useVoiceRecorder,
  RecorderState,
  audioBlobToBase64,
} from '../hooks/useVoiceRecorder';

interface VoiceInputButtonProps {
  /** 转写完成回调：父组件把 text 填入输入框 */
  onTranscribed: (text: string) => void;
  /** 禁用（如正在对话中） */
  disabled?: boolean;
  /** 最大录音时长（ms），默认 60000 */
  maxDurationMs?: number;
}

/** 格式化毫秒为 mm:ss */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 从 MIME 提取 format（如 audio/webm;codecs=opus → webm） */
function mimeToFormat(mime: string): string {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** ---------------------------------------------------------------------------
 * Beep 提示音（Web Audio API）
 *
 * 为避免引入音频文件，使用 OscillatorNode 生成短促的正弦波。
 * - 开始录音：高频 880Hz, 80ms（提示用户“可以说了”）
 * - 结束录音：低频 660Hz, 100ms（提示用户“录音已结束”）
 *
 * 浏览器自动播放策略：
 * AudioContext 必须在用户交互（click/touchstart/mousedown）中创建并 resume。
 * 本组件的 handlePressStart 在用户点击事件内调用 getBeepCtx() 拿到（或创建）
 * AudioContext，并且在 start() 之前会调用一次 unlockBeepCtx() 进行 resume，
 * 以保证后续 recorder 状态变化触发 playBeep 时也能正常发声。
 * --------------------------------------------------------------------------- */
let _beepCtx: AudioContext | null = null;

function getBeepCtx(): AudioContext | null {
  if (_beepCtx && _beepCtx.state !== 'closed') return _beepCtx;
  if (typeof window === 'undefined') return null;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  try {
    _beepCtx = new AC();
    return _beepCtx;
  } catch {
    return null;
  }
}

/** 在用户交互中调用，确保 AudioContext 处于 running 状态 */
function unlockBeepCtx(): void {
  const ctx = getBeepCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

/** 播放短促 beep。失败静默，不影响录音主流程 */
function playBeep(frequency = 880, durationMs = 80): void {
  const ctx = getBeepCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    // 还未被激活（用户尚未交互过），跳过避免被拒绝
    return;
  }
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    // 快速上升 → 衰减包络，避免“噗”声
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch {
    // 静默失败
  }
}

export default function VoiceInputButton({
  onTranscribed,
  disabled = false,
  maxDurationMs = 60000,
}: VoiceInputButtonProps) {
  const recorder = useVoiceRecorder(maxDurationMs);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  // ref 预留：可用于未来取消进行中的转写请求
  const lastSubmitRef = useRef<Promise<void> | null>(null);

  /** 调用后端 ASR 接口 */
  const submitForTranscribe = useCallback(
    async (blob: Blob, mime: string) => {
      try {
        setSubmitting(true);
        setSubmitError('');

        const base64 = await audioBlobToBase64(blob);
        const format = mimeToFormat(mime);

        const resp = await fetch('/api/asr/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio: base64,
            format,
            language: 'zh',
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        const data = await resp.json();
        const text = (data.text || '').trim();

        if (text) {
          onTranscribed(text);
        } else {
          setSubmitError('未识别到语音内容，请重试');
        }
      } catch (err: any) {
        console.error('ASR 转写失败:', err);
        setSubmitError(err?.message || '转写失败，请重试');
      } finally {
        setSubmitting(false);
        recorder.reset();
      }
    },
    [onTranscribed, recorder]
  );

  /** 松开/离开 → 停止录音并自动提交 */
  const handleStop = useCallback(async () => {
    if (recorder.state !== RecorderState.Recording) return;
    await recorder.stop();
    // stop 后 state 会变 Processing，然后变 Done，audioBlob 才有值
    // 用 watch 替代：这里直接检查
  }, [recorder]);

  // 监听 recorder 状态变化：Done 时自动提交；开始/结束时播放 beep
  // 用 prevStateRef 检测状态转换
  const prevStateRef = useRef(recorder.state);
  if (prevStateRef.current !== recorder.state) {
    const prev = prevStateRef.current;
    prevStateRef.current = recorder.state;

    // ① 开始录音：* → Recording（实际场景是 RequestingPermission → Recording）
    if (
      recorder.state === RecorderState.Recording &&
      prev !== RecorderState.Recording
    ) {
      playBeep(880, 80);
    }
    // ② 录音结束：Recording → Processing（手动 stop）或 Recording → Idle（取消）
    if (
      prev === RecorderState.Recording &&
      (recorder.state === RecorderState.Processing ||
        recorder.state === RecorderState.Idle)
    ) {
      playBeep(660, 100);
    }

    if (
      recorder.state === RecorderState.Done &&
      recorder.audioBlob &&
      !submitting
    ) {
      // 用微任务延迟，确保 audioBlob 已写入 state
      const blob = recorder.audioBlob;
      const mime = recorder.mimeType;
      lastSubmitRef.current = submitForTranscribe(blob, mime);
    }
    // 错误状态：只显示错误，不提交
    if (recorder.state === RecorderState.Error) {
      setSubmitError(recorder.error);
    }
  }

  // ── 鼠标/触摸事件 ──
  const handlePressStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      if (disabled || submitting) return;
      // 用户交互内激活 AudioContext，使后续 playBeep 能发声
      unlockBeepCtx();
      recorder.start();
    },
    [disabled, submitting, recorder]
  );

  const handlePressEnd = useCallback(
    (e?: React.MouseEvent | React.TouchEvent) => {
      e?.preventDefault();
      handleStop();
    },
    [handleStop]
  );

  // 鼠标移出按钮也停止（防止拖出后无法松开）
  const handleMouseLeave = useCallback(
    (e: React.MouseEvent) => {
      if (recorder.state === RecorderState.Recording) {
        handlePressEnd(e);
      }
    },
    [recorder.state, handlePressEnd]
  );

  // ── 渲染 ──
  const isRecording = recorder.state === RecorderState.Recording;
  const isProcessing =
    recorder.state === RecorderState.Processing || submitting;
  const isError = recorder.state === RecorderState.Error;

  const maxSec = Math.floor(maxDurationMs / 1000);
  const usedSec = Math.floor(recorder.durationMs / 1000);

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* 录音中弹层（按钮上方） */}
      {(isRecording || isProcessing) && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 12px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#1f1f1f',
            color: '#fff',
            padding: '12px 16px',
            borderRadius: 12,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            zIndex: 100,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
            minWidth: 200,
          }}
        >
          {/* 音量条 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 8,
              justifyContent: 'center',
              height: 24,
            }}
          >
            {Array.from({ length: 12 }).map((_, i) => {
              const threshold = i / 12;
              const active = recorder.volume > threshold;
              const barHeight = 4 + i * 1.5;
              return (
                <div
                  key={i}
                  style={{
                    width: 4,
                    height: barHeight,
                    borderRadius: 2,
                    background: active ? '#ff4d4f' : 'rgba(255,255,255,0.25)',
                    transition: 'background 0.08s ease',
                  }}
                />
              );
            })}
          </div>

          {/* 倒计时 */}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              color: isProcessing ? '#52c41a' : '#ff7875',
            }}
          >
            {isProcessing
              ? '🔄 转写中...'
              : `${formatDuration(recorder.durationMs)} / ${formatDuration(
                  maxDurationMs
                )}`}
          </div>

          {/* 提示 */}
          {!isProcessing && (
            <div
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.65)',
                textAlign: 'center',
                marginTop: 4,
              }}
            >
              松开发送 · 按 ESC 取消
            </div>
          )}

          {/* 小三角 */}
          <div
            style={{
              position: 'absolute',
              bottom: -6,
              left: '50%',
              transform: 'translateX(-50%) rotate(45deg)',
              width: 12,
              height: 12,
              background: '#1f1f1f',
            }}
          />
        </div>
      )}

      {/* 错误提示（按钮上方） */}
      {(isError || submitError) && !isRecording && !isProcessing && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 12px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#ff4d4f',
            color: '#fff',
            padding: '6px 12px',
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: 'nowrap',
            zIndex: 100,
            pointerEvents: 'none',
            userSelect: 'none',
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={submitError || recorder.error}
        >
          {submitError || recorder.error}
        </div>
      )}

      {/* 主按钮 */}
      <button
        type="button"
        // 鼠标事件
        onMouseDown={handlePressStart}
        onMouseUp={handlePressEnd}
        onMouseLeave={handleMouseLeave}
        // 触摸事件
        onTouchStart={handlePressStart}
        onTouchEnd={handlePressEnd}
        onTouchCancel={handlePressEnd}
        // 防止拖动产生选区
        onDragStart={(e) => e.preventDefault()}
        disabled={disabled}
        title={
          isRecording
            ? '正在录音，松开发送'
            : isProcessing
              ? '转写中...'
              : '按住说话'
        }
        style={{
          width: 36,
          height: 36,
          border: 'none',
          background: isRecording ? '#ff4d4f' : '#1890FF',
          color: '#fff',
          borderRadius: '50%',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          opacity: disabled ? 0.4 : 1,
          transition: 'background 0.15s, transform 0.1s',
          transform: isRecording ? 'scale(1.1)' : 'scale(1)',
          // 防止浏览器原生行为干扰
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {isProcessing ? (
          // 转写中：loading 转圈
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            style={{ animation: 'spin 1s linear infinite' }}
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="3"
              fill="none"
            />
            <path
              d="M22 12 a10 10 0 0 0 -10 -10"
              stroke="#fff"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          // 麦克风图标
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11z" />
          </svg>
        )}

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </button>
    </div>
  );
}