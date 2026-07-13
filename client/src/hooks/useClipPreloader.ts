/**
 * 切片预取 Hook — 在用户首次交互解锁后并行预取所有切片到 IndexedDB
 *
 * 调用流程：
 *   1. App.tsx 在 onFirstTap 中调用 prefetchOnUnlock()
 *   2. 该函数初始化 IndexedDB → 拉取 /api/clips/manifest → 并行预取
 *   3. 整个过程不阻塞主流程，失败可在下次解锁时重试
 *
 * V2 增强：
 * - 预取完成后自动调用 warmupMemoryCache 预热 objectURL Map
 * - 暴露 prefs/stats 给 admin panel
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  initClipCache,
  prefetchClips,
  getClipCacheStats,
  getMemoryCachedUrls,
} from '../services/clipCache';

interface ManifestResponse {
  items: string[];
  version: number;
}

interface PreloaderState {
  count: number;
  bytes: number;
  memoryCached: number;
  prefetching: boolean;
  /** 0~1；undefined 表示尚未启动或无法统计 */
  progress: number | null;
  /** V2: 预取总耗时（毫秒） */
  durationMs: number | null;
}

let manifestCache: { version: number; items: string[] } | null = null;

/** 获取 manifest（带内存缓存） */
async function fetchManifest(): Promise<ManifestResponse> {
  if (manifestCache) return manifestCache;
  const resp = await fetch('/api/clips/manifest', { credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`manifest HTTP ${resp.status}`);
  const data = (await resp.json()) as ManifestResponse;
  manifestCache = data;
  return data;
}

export function useClipPreloader(): {
  prefetchOnUnlock: () => Promise<void>;
  state: PreloaderState;
  /** V2: 获取内存缓存 URL 列表（admin 用） */
  getMemoryCacheKeys: () => string[];
} {
  const [state, setState] = useState<PreloaderState>({
    count: 0,
    bytes: 0,
    memoryCached: 0,
    prefetching: false,
    progress: null,
    durationMs: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const prefetchOnUnlock = useCallback(async () => {
    // 已有进行中的预取则跳过
    if (state.prefetching) return;

    const tStart = performance.now();
    setState((s) => ({
      ...s,
      prefetching: true,
      progress: 0,
      durationMs: null,
    }));

    try {
      await initClipCache();
      const manifest = await fetchManifest();

      const controller = new AbortController();
      abortRef.current = controller;

      const result = await prefetchClips(
        manifest.items,
        (done, total) => {
          setState((s) => ({
            ...s,
            progress: total > 0 ? done / total : null,
          }));
        },
        controller.signal,
      );

      const tEnd = performance.now();
      const durationMs = Math.round(tEnd - tStart);

      console.log(
        `[useClipPreloader] 预取完成 ok=${result.ok} fail=${result.fail} version=${manifest.version} durationMs=${durationMs}`,
      );

      const stats = await getClipCacheStats();
      setState({
        count: stats.count,
        bytes: stats.bytes,
        memoryCached: stats.memoryCached,
        prefetching: false,
        progress: 1,
        durationMs,
      });
    } catch (err) {
      console.warn('[useClipPreloader] 预取流程异常：', err);
      setState((s) => ({
        ...s,
        prefetching: false,
        progress: null,
        durationMs: null,
      }));
    }
  }, [state.prefetching]);

  // V2: 暴露内存缓存 keys 用于诊断
  const getMemoryCacheKeys = useCallback(() => getMemoryCachedUrls(), []);

  return { prefetchOnUnlock, state, getMemoryCacheKeys };
}