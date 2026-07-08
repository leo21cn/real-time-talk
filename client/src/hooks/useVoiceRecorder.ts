/**
 * 语音录音 Hook
 *
 * 功能：
 * - 封装 MediaRecorder API
 * - 支持音量实时分析（AnalyserNode + getByteFrequencyData）
 * - 60s 自动停止
 * - 浏览器格式自适应：webm/opus 优先（Chrome/Edge/Firefox），mp4 fallback（Safari）
 * - ESC 键取消
 * - 状态机：idle → requesting-permission → recording → processing → done / error
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 录音状态 */
export enum RecorderState {
  Idle = 'idle',
  RequestingPermission = 'requesting-permission',
  Recording = 'recording',
  Processing = 'processing',
  Done = 'done',
  Error = 'error',
}

/** Hook 输出 */
export interface UseVoiceRecorderReturn {
  /** 当前状态 */
  state: RecorderState;
  /** 已录音时长（ms） */
  durationMs: number;
  /** 实时音量 0-1（用于 UI 波形/音量条） */
  volume: number;
  /** 错误信息 */
  error: string;
  /** 产出的音频 Blob（done 后） */
  audioBlob: Blob | null;
  /** 音频 MIME（done 后，例如 'audio/webm'） */
  mimeType: string;
  /** 开始录音（请求权限 + 启动 MediaRecorder） */
  start: () => Promise<void>;
  /** 停止录音并产出 Blob */
  stop: () => Promise<void>;
  /** 取消录音（不产出 Blob） */
  cancel: () => void;
  /** 重置状态回 idle */
  reset: () => void;
}

/** 默认最大时长（ms），与后端配置一致 */
const DEFAULT_MAX_DURATION_MS = 60_000;

/** MIME 优先级 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a',
  'audio/mp4',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // 去掉 "data:audio/webm;base64," 前缀
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取音频失败'));
    reader.readAsDataURL(blob);
  });
}

export function useVoiceRecorder(
  maxDurationMs: number = DEFAULT_MAX_DURATION_MS
): UseVoiceRecorderReturn {
  const [state, setState] = useState<RecorderState>(RecorderState.Idle);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState('');
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [mimeType, setMimeType] = useState('');

  // Refs（避免闭包陷阱）
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const volumeRafRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const tickTimerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const resolveStopRef = useRef<((blob: Blob) => void) | null>(null);

  /** 清理所有资源 */
  const cleanup = useCallback(() => {
    if (volumeRafRef.current !== null) {
      cancelAnimationFrame(volumeRafRef.current);
      volumeRafRef.current = null;
    }
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  /** 音量轮询 */
  const tickVolume = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    // 取均值 → 0-1
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length / 255;
    // 平滑（避免跳动）
    setVolume((prev) => prev * 0.6 + avg * 0.4);
    volumeRafRef.current = requestAnimationFrame(tickVolume);
  }, []);

  /** 实际停止（内部） */
  const doStop = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      resolveStopRef.current = resolve;
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== 'inactive') {
        mr.stop(); // 会触发 onstop
      } else {
        // 已 inactive，直接 resolve 空 blob
        resolve(new Blob([], { type: mimeType || 'audio/webm' }));
      }
    });
  }, [mimeType]);

  /** 开始录音 */
  const start = useCallback(async () => {
    if (state === RecorderState.Recording || state === RecorderState.Processing) {
      return;
    }

    // 浏览器能力检查
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState(RecorderState.Error);
      setError('当前浏览器不支持麦克风访问');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setState(RecorderState.Error);
      setError('当前浏览器不支持录音');
      return;
    }

    setError('');
    setAudioBlob(null);
    setDurationMs(0);
    setVolume(0);
    chunksRef.current = [];
    setState(RecorderState.RequestingPermission);

    try {
      // 1. 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // 2. 创建 AudioContext + AnalyserNode（用于音量）
      const AudioCtx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;
        volumeRafRef.current = requestAnimationFrame(tickVolume);
      }

      // 3. 创建 MediaRecorder
      const mime = pickMimeType();
      setMimeType(mime);
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
        setAudioBlob(blob);
        setState(RecorderState.Done);
        cleanup();
        if (resolveStopRef.current) {
          resolveStopRef.current(blob);
          resolveStopRef.current = null;
        }
      };
      mr.onerror = (e: any) => {
        console.error('MediaRecorder 错误:', e);
        setState(RecorderState.Error);
        setError('录音过程中出错');
        cleanup();
        if (resolveStopRef.current) {
          resolveStopRef.current(new Blob([], { type: mime || 'audio/webm' }));
          resolveStopRef.current = null;
        }
      };

      mr.start(100); // 每 100ms 产出一个 chunk
      startTimeRef.current = Date.now();
      setState(RecorderState.Recording);

      // 4. 启动时长计时
      tickTimerRef.current = window.setInterval(() => {
        setDurationMs(Date.now() - startTimeRef.current);
      }, 100);

      // 5. 60s 自动停止
      maxTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          console.log('达到最大时长，自动停止');
          doStop();
        }
      }, maxDurationMs);
    } catch (err: any) {
      console.error('启动录音失败:', err);
      cleanup();
      setState(RecorderState.Error);
      if (
        err?.name === 'NotAllowedError' ||
        err?.name === 'PermissionDeniedError'
      ) {
        setError('麦克风权限被拒绝，请在浏览器设置中允许');
      } else if (err?.name === 'NotFoundError') {
        setError('未找到可用的麦克风设备');
      } else {
        setError(`启动录音失败: ${err?.message || err}`);
      }
    }
  }, [state, maxDurationMs, cleanup, tickVolume, doStop]);

  /** 停止并产出 Blob */
  const stop = useCallback(async () => {
    if (state !== RecorderState.Recording) return;
    // 停止计时器但保留 MR 完成
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    setState(RecorderState.Processing);
    await doStop();
  }, [state, doStop]);

  /** 取消（不产出 Blob） */
  const cancel = useCallback(() => {
    cleanup();
    chunksRef.current = [];
    setAudioBlob(null);
    setState(RecorderState.Idle);
    setDurationMs(0);
    setVolume(0);
    if (resolveStopRef.current) {
      // 用空 blob resolve 以解锁可能的 await
      resolveStopRef.current(new Blob([], { type: mimeType || 'audio/webm' }));
      resolveStopRef.current = null;
    }
  }, [cleanup, mimeType]);

  /** 重置状态回 idle（供父组件在收到结果后调用） */
  const reset = useCallback(() => {
    setState(RecorderState.Idle);
    setError('');
    setDurationMs(0);
    setVolume(0);
    setAudioBlob(null);
  }, []);

  /** ESC 键取消 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state === RecorderState.Recording) {
        console.log('ESC 取消录音');
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, cancel]);

  /** 卸载清理 */
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    durationMs,
    volume,
    error,
    audioBlob,
    mimeType,
    start,
    stop,
    cancel,
    reset,
  };
}

/** 工具函数：把 Blob 转 base64（在 submit 时调用） */
export async function audioBlobToBase64(blob: Blob): Promise<string> {
  return blobToBase64(blob);
}