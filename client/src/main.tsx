/**
 * RealTimeTalk 前端入口
 *
 * 启动 Service Worker（用于视频请求拦截 + Range 切片）。
 * 注册失败降级到 IDB + HTTP 缓存路径，不影响功能。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// ─── Service Worker 注册 ────────────────────────────────────────
// SW 必须在 React 渲染前注册（首屏 fetch 才会被 SW 拦截）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[SW] Service Worker registered, scope:', reg.scope);
      })
      .catch((err) => {
        // 微信 X5 旧版本可能不支持 SW，降级到 IDB + HTTP 缓存路径
        console.warn(
          '[SW] 注册失败，降级到 IndexedDB + HTTP 缓存路径：',
          err.message || err,
        );
      });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);