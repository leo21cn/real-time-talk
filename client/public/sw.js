/**
 * RealTimeTalk Service Worker — 客户端视频缓存拦截
 *
 * 目标：
 *   - 拦截 /api/clips/* 请求，命中 Cache API 直接返回（0 网络往返）
 *   - 支持 Range 请求：从 Cache 中的完整响应切片返回 206 Partial Content
 *   - 缓存名按 manifest version 命名（clips-v{N}），bump version 自动失效
 *
 * 兼容性：
 *   - iOS WeChat WKWebView (iOS 11.3+) 支持
 *   - Android WeChat X5 支持度因 TBS 版本而异
 *   - 注册失败时降级到现有 IDB + HTTP 缓存路径
 */

const SW_VERSION = 'v2';
const CACHE_PREFIX = 'clips';

self.addEventListener('install', (event) => {
  // 立即接管页面
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // 清理旧版本缓存
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX + '-') && !k.endsWith('-' + SW_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/api/clips/')) return;

  event.respondWith(handleClipRequest(event.request));
});

/**
 * 处理 /api/clips/* 请求：
 * 1. 先尝试 Cache API 完整响应
 * 2. 若命中且请求带 Range → 从完整响应切片返回 206
 * 3. 若未命中 → 走网络，完整响应存入 Cache
 */
async function handleClipRequest(request) {
  const url = new URL(request.url);
  // 移除 ?v=N 版本号归一化 cache key（让版本号变化时 URL 不同 → cache miss）
  const normalizedUrl = stripVersionParam(url);

  const cache = await caches.open(`${CACHE_PREFIX}-${SW_VERSION}`);
  const cachedFull = await cache.match(normalizedUrl);

  // Range 请求
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    return await handleRangeRequest(cache, request, normalizedUrl, cachedFull, rangeHeader);
  }

  if (cachedFull) {
    return cachedFull;
  }

  // 未命中：走网络 + 写入缓存
  try {
    const resp = await fetch(request);
    if (resp.ok && resp.status === 200) {
      // 用 normalizedUrl 作为 cache key
      cache.put(normalizedUrl, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    // 网络失败 + 未缓存 → 返回 504
    return new Response('Network error and no cache', {
      status: 504,
      statusText: 'Gateway Timeout',
    });
  }
}

/**
 * 处理 Range 请求（HTML5 video 通常用 Range: bytes=0-）
 * 命中缓存：从完整响应切片
 * 未命中：走网络，让浏览器拿到 206 Partial Content
 */
async function handleRangeRequest(cache, request, normalizedUrl, cachedFull, rangeHeader) {
  if (cachedFull) {
    try {
      const blob = await cachedFull.blob();
      const size = blob.size;
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : size - 1;
        const sliced = blob.slice(start, end + 1, cachedFull.headers.get('content-type') || 'video/mp4');
        return new Response(sliced, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': cachedFull.headers.get('content-type') || 'video/mp4',
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }
    } catch (err) {
      console.warn('[SW] Range 请求处理失败，回退到网络:', err);
    }
  }
  // 未命中或处理失败：直接走网络
  return fetch(request);
}

/** 剥离 ?v=N 参数，让 cache key 不含版本号（版本变化由 SW 缓存名变更处理） */
function stripVersionParam(url) {
  const u = new URL(url.toString());
  u.searchParams.delete('v');
  return u.toString();
}