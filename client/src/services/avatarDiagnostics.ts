/**
 * 客户端诊断埋点 — 段间切换耗时追踪
 *
 * 用法：
 *   const trace = avatarDiagnostics.start(url);
 *   // ... 异步 IDB 查询 ...
 *   trace.markIdbDone(resolvedSrc);
 *   // ... video.src = resolvedSrc ...
 *   trace.markSrcSet();
 *   // ... canplay event ...
 *   trace.markCanplay();
 *   trace.commit();
 */

export interface SwitchTrace {
  url: string;
  tsStart: number;
  tsIdbLookupDone: number | null;
  tsSrcSet: number | null;
  tsCanplay: number | null;
  tsError: number | null;
  cacheHit: boolean;
  resolvedSrcKind: 'blob:' | 'http:' | 'unknown';
  markIdbDone(resolvedSrc: string | null): void;
  markSrcSet(): void;
  markCanplay(): void;
  markError(): void;
  commit(): void;
}

export interface SwitchRecord extends SwitchTrace {
  loadingDurationMs: number | null;       // tsCanplay - tsSrcSet
  totalSwitchDurationMs: number | null;   // tsCanplay - tsStart
}

const recentRecords: SwitchRecord[] = [];
const MAX_RECORDS = 200;
const listeners: Array<(r: SwitchRecord) => void> = [];

/** 订阅埋点事件（admin panel 用） */
export function onAvatarDiag(cb: (r: SwitchRecord) => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** 获取最近的诊断记录 */
export function getRecentRecords(): SwitchRecord[] {
  return recentRecords.slice();
}

class TraceImpl implements SwitchTrace {
  url: string;
  tsStart: number;
  tsIdbLookupDone: number | null = null;
  tsSrcSet: number | null = null;
  tsCanplay: number | null = null;
  tsError: number | null = null;
  cacheHit = false;
  resolvedSrcKind: 'blob:' | 'http:' | 'unknown' = 'unknown';

  constructor(url: string) {
    this.url = url;
    this.tsStart = performance.now();
  }

  markIdbDone(resolvedSrc: string | null): void {
    this.tsIdbLookupDone = performance.now();
    if (resolvedSrc) {
      this.cacheHit = resolvedSrc !== this.url; // 不同即命中（URL 已被替换成 blob:）
      this.resolvedSrcKind = resolvedSrc.startsWith('blob:')
        ? 'blob:'
        : resolvedSrc.startsWith('http')
        ? 'http:'
        : 'unknown';
    } else {
      this.cacheHit = false;
    }
  }

  markSrcSet(): void {
    this.tsSrcSet = performance.now();
  }

  markCanplay(): void {
    this.tsCanplay = performance.now();
    this.commit();
  }

  markError(): void {
    this.tsError = performance.now();
    this.commit();
  }

  commit(): void {
    const record: SwitchRecord = {
      ...this,
      loadingDurationMs:
        this.tsCanplay !== null && this.tsSrcSet !== null
          ? this.tsCanplay - this.tsSrcSet
          : null,
      totalSwitchDurationMs:
        this.tsCanplay !== null ? this.tsCanplay - this.tsStart : null,
    };

    // 内存环缓冲
    recentRecords.push(record);
    if (recentRecords.length > MAX_RECORDS) {
      recentRecords.shift();
    }

    // console 调试
    if (typeof console !== 'undefined') {
      console.debug('[AvatarDiag]', {
        url: record.url.split('/').pop(),
        cacheHit: record.cacheHit,
        kind: record.resolvedSrcKind,
        load: record.loadingDurationMs?.toFixed(0) + 'ms',
        total: record.totalSwitchDurationMs?.toFixed(0) + 'ms',
      });
    }

    // 自定义事件（便于外部监听）
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('avatar-diag', { detail: record }));
    }

    // 订阅者
    for (const cb of listeners) {
      try {
        cb(record);
      } catch {
        /* ignore */
      }
    }

    // 抽样上报到服务端（1/10）
    if (Math.random() < 0.1 && typeof fetch !== 'undefined') {
      try {
        fetch('/api/diag/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
          keepalive: true,
        }).catch(() => {
          /* 静默失败 */
        });
      } catch {
        /* ignore */
      }
    }
  }
}

/** 启动一次段间切换的追踪 */
export function startSwitchTrace(url: string): TraceImpl {
  return new TraceImpl(url);
}

/** 计算延迟分布（admin 面板用） */
export function computePercentiles(records: SwitchRecord[]): {
  p50: number;
  p95: number;
  count: number;
  hitRate: number;
} {
  const completed = records.filter(
    (r) => r.totalSwitchDurationMs !== null,
  );
  if (completed.length === 0) {
    return { p50: 0, p95: 0, count: 0, hitRate: 0 };
  }
  const sorted = completed
    .map((r) => r.totalSwitchDurationMs as number)
    .sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const hits = completed.filter((r) => r.cacheHit).length;
  return {
    p50: Math.round(p50),
    p95: Math.round(p95),
    count: completed.length,
    hitRate: hits / completed.length,
  };
}