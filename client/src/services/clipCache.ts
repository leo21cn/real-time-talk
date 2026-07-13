/**
 * IndexedDB Blob 缓存服务 — 客户端预缓存核心
 *
 * 设计要点：
 * - DB: real-time-talk-clips / object store: clips (keyPath: url)
 * - 命中即 URL.createObjectURL(blob)，调用方负责 revokeObjectURL
 * - 失败容忍：单条 URL 拉取失败不影响整体进度
 * - 微信浏览器兼容：IndexedDB 在微信内置浏览器各版本可用
 *
 * V2 增强：
 * - 内存 Map 缓存 objectURL，避免每次段间切换都查 IDB（5-15ms 开销）
 * - 预取完成后预热 Map，首段切换 0 延迟
 * - 暴露迭代器供 admin panel 查看缓存内容
 */

const DB_NAME = 'real-time-talk-clips';
const DB_VERSION = 1;
const STORE_NAME = 'clips';

let dbPromise: Promise<IDBDatabase> | null = null;

/** 打开 / 升级 IndexedDB */
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 初始化缓存（幂等，可多次调用） */
export async function initClipCache(): Promise<void> {
  try {
    await openDB();
  } catch (err) {
    console.warn('[clipCache] 初始化失败，将回退到 HTTP 缓存：', err);
  }
}

/**
 * 内存级 objectURL 缓存（V2）：
 * key = 原始 URL，value = 已创建的 blob:URL
 * 命中时直接返回（同步 <1ms），无需 IDB 事务开销
 */
const objectUrlCache = new Map<string, string>();

/**
 * 从 IDB 读取单条记录（不创建 objectURL）
 * 内部使用，由 getCachedClipUrl 和预热逻辑调用
 */
async function getBlobFromIDB(url: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(url);
      req.onsuccess = () => {
        const record = req.result as { url: string; blob: Blob } | undefined;
        if (!record || !record.blob) {
          resolve(null);
          return;
        }
        resolve(record.blob);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[clipCache] getBlobFromIDB 异常：', err);
    return null;
  }
}

/**
 * 查询单个 URL 是否已缓存。
 * - L1 命中（内存 Map）→ 同步返回 <1ms
 * - L2 命中（IDB）→ 创建 objectURL 并缓存到 Map，返回
 * - 都未命中或异常 → 返回 null
 */
export async function getCachedClipUrl(url: string): Promise<string | null> {
  // L1: 内存缓存
  const cached = objectUrlCache.get(url);
  if (cached) return cached;

  // L2: IndexedDB
  const blob = await getBlobFromIDB(url);
  if (!blob) return null;

  try {
    const objUrl = URL.createObjectURL(blob);
    objectUrlCache.set(url, objUrl);
    return objUrl;
  } catch (err) {
    console.warn('[clipCache] createObjectURL 失败：', err);
    return null;
  }
}

/** 写入 / 覆盖一条缓存 */
export async function putClip(url: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ url, blob, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // 同步刷新内存缓存（如果该 URL 已经在内存里有旧的 objectURL，先 revoke）
    const existing = objectUrlCache.get(url);
    if (existing) {
      try {
        URL.revokeObjectURL(existing);
      } catch {
        /* ignore */
      }
    }
    try {
      objectUrlCache.set(url, URL.createObjectURL(blob));
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.warn(`[clipCache] putClip 失败 (${url})：`, err);
  }
}

/**
 * 预取完成后预热内存缓存（消除首次段间切换的 IDB 查询）
 * 返回成功预热的条数
 */
export async function warmupMemoryCache(): Promise<number> {
  try {
    const db = await openDB();
    const all = await new Promise<Array<{ url: string; blob: Blob }>>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () =>
          resolve((req.result || []) as Array<{ url: string; blob: Blob }>);
        req.onerror = () => reject(req.error);
      },
    );
    let count = 0;
    for (const r of all) {
      if (!objectUrlCache.has(r.url) && r.blob) {
        try {
          objectUrlCache.set(r.url, URL.createObjectURL(r.blob));
          count++;
        } catch {
          /* ignore */
        }
      }
    }
    return count;
  } catch (err) {
    console.warn('[clipCache] warmupMemoryCache 异常：', err);
    return 0;
  }
}

/**
 * 并行预取一组 URL 到 IndexedDB。最多 MAX_CONCURRENCY 路并发。
 *
 * - 单条失败仅 warn，整体不抛错
 * - onProgress(done, total) 用于 UI 进度回调
 * - AbortSignal 用于中途取消（页面卸载 / 用户切到其他标签）
 * - 完成后自动调用 warmupMemoryCache 预热内存
 */
export async function prefetchClips(
  urls: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; fail: number }> {
  const total = urls.length;
  let done = 0;
  let ok = 0;
  let fail = 0;

  const reportProgress = () => {
    if (onProgress) onProgress(done, total);
  };
  reportProgress();

  const queue = [...urls];
  const MAX_CONCURRENCY = 4;

  const workers = Array.from({ length: MAX_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const url = queue.shift();
      if (!url) return;
      try {
        const resp = await fetch(url, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        await putClip(url, blob);
        ok++;
      } catch (err) {
        fail++;
        console.warn(`[clipCache] 预取失败 ${url}：`, err);
      } finally {
        done++;
        reportProgress();
      }
    }
  });

  await Promise.all(workers);

  // 预取完成后预热内存缓存（消除首段切换的 IDB 查询延迟）
  await warmupMemoryCache();

  return { ok, fail };
}

/** 统计缓存占用 */
export async function getClipCacheStats(): Promise<{
  count: number;
  bytes: number;
  memoryCached: number;
}> {
  try {
    const db = await openDB();
    const records = await new Promise<Array<{ url: string; blob: Blob }>>(
      (resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () =>
          resolve((req.result || []) as Array<{ url: string; blob: Blob }>);
        req.onerror = () => resolve([]);
      },
    );
    const bytes = records.reduce(
      (sum, r) => sum + (r.blob?.size || 0),
      0,
    );
    return {
      count: records.length,
      bytes,
      memoryCached: objectUrlCache.size,
    };
  } catch (err) {
    console.warn('[clipCache] stats 异常：', err);
    return { count: 0, bytes: 0, memoryCached: 0 };
  }
}

/**
 * 获取内存缓存当前持有的 URL 列表（admin panel 用）
 */
export function getMemoryCachedUrls(): string[] {
  return Array.from(objectUrlCache.keys());
}

/**
 * 释放单个内存缓存项（被 AvatarView 切换时调用）
 */
export function releaseMemoryCacheEntry(url: string): void {
  const objUrl = objectUrlCache.get(url);
  if (objUrl) {
    try {
      URL.revokeObjectURL(objUrl);
    } catch {
      /* ignore */
    }
    objectUrlCache.delete(url);
  }
}

/** 清空所有缓存（调试 / 强制刷新用） */
export async function clearClipCache(): Promise<void> {
  // 内存缓存先 revoke 所有 objectURL
  for (const objUrl of objectUrlCache.values()) {
    try {
      URL.revokeObjectURL(objUrl);
    } catch {
      /* ignore */
    }
  }
  objectUrlCache.clear();

  // IDB 清空
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[clipCache] clear 异常：', err);
  }
}