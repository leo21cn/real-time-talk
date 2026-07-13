/**
 * 客户端缓存状态面板（admin 用）
 *
 * 显示当前设备的：
 * - IndexedDB 记录数 / 占用字节 / 内存 objectURL 缓存
 * - 段间切换延迟分布（P50/P95）+ 命中率
 * - Service Worker 状态
 */
import { useEffect, useState } from 'react';
import {
  getClipCacheStats,
  getMemoryCachedUrls,
} from '../services/clipCache';
import {
  computePercentiles,
  getRecentRecords,
  type SwitchRecord,
} from '../services/avatarDiagnostics';

interface CacheStats {
  idbCount: number;
  idbBytes: number;
  memoryCached: number;
  memoryUrls: string[];
}

interface SwState {
  supported: boolean;
  active: boolean | null;
  scope: string | null;
}

interface ServerStats {
  count: number;
  p50_loadingMs: number;
  p95_loadingMs: number;
  p50_totalMs: number;
  p95_totalMs: number;
  hitRate: number;
  recentErrors: number;
}

export default function CacheStatusPanel() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [clientStats, setClientStats] = useState(() =>
    computePercentiles(getRecentRecords()),
  );
  const [sw, setSw] = useState<SwState>({
    supported: false,
    active: null,
    scope: null,
  });
  const [serverStats, setServerStats] = useState<ServerStats | null>(null);

  const refresh = async () => {
    const s = await getClipCacheStats();
    setStats({
      idbCount: s.count,
      idbBytes: s.bytes,
      memoryCached: s.memoryCached,
      memoryUrls: getMemoryCachedUrls(),
    });
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // 订阅埋点事件
  useEffect(() => {
    const handler = () =>
      setClientStats(computePercentiles(getRecentRecords()));
    window.addEventListener('avatar-diag', handler);
    return () => window.removeEventListener('avatar-diag', handler);
  }, []);

  // 检测 Service Worker
  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      setSw({ supported: false, active: null, scope: null });
      return;
    }
    navigator.serviceWorker.getRegistration().then((reg) => {
      setSw({
        supported: true,
        active: !!reg?.active,
        scope: reg?.scope || null,
      });
    });
    const handler = () => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        setSw({
          supported: true,
          active: !!reg?.active,
          scope: reg?.scope || null,
        });
      });
    };
    navigator.serviceWorker.addEventListener('controllerchange', handler);
    return () =>
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handler,
      );
  }, []);

  // 拉取服务端聚合
  const refreshServer = async () => {
    try {
      const resp = await fetch('/api/diag/avatar', { credentials: 'same-origin' });
      if (resp.ok) setServerStats(await resp.json());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refreshServer();
    const t = setInterval(refreshServer, 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* IndexedDB + 内存缓存 */}
      <section
        style={{
          background: '#FFF',
          borderRadius: 8,
          padding: '16px 20px',
          border: '1px solid #e8e8e8',
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#333' }}>
          客户端缓存
        </h3>
        {stats ? (
          <div style={{ fontSize: 13, color: '#555', lineHeight: 1.8 }}>
            <div>
              IndexedDB 记录：<b>{stats.idbCount}</b> 条 / 占用{' '}
              <b>{(stats.idbBytes / 1024).toFixed(1)} KB</b>
            </div>
            <div>
              内存 objectURL 缓存：<b>{stats.memoryCached}</b> 条
            </div>
            {stats.memoryUrls.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary
                  style={{ cursor: 'pointer', color: '#1890FF', fontSize: 12 }}
                >
                  查看内存缓存 URL 列表
                </summary>
                <ul
                  style={{
                    margin: '4px 0 0',
                    padding: '4px 0 4px 20px',
                    fontSize: 11,
                    color: '#999',
                    wordBreak: 'break-all',
                  }}
                >
                  {stats.memoryUrls.map((u) => (
                    <li key={u}>{u.split('/').pop()}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#999' }}>加载中…</div>
        )}
      </section>

      {/* Service Worker */}
      <section
        style={{
          background: '#FFF',
          borderRadius: 8,
          padding: '16px 20px',
          border: '1px solid #e8e8e8',
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#333' }}>
          Service Worker
        </h3>
        <div style={{ fontSize: 13, color: '#555', lineHeight: 1.8 }}>
          {!sw.supported ? (
            <span style={{ color: '#ff4d4f' }}>浏览器不支持 SW</span>
          ) : (
            <>
              <div>
                注册：<b style={{ color: sw.active ? '#52c41a' : '#999' }}>{sw.active ? '已激活' : '未激活'}</b>
              </div>
              {sw.scope && (
                <div style={{ fontSize: 11, color: '#999', wordBreak: 'break-all' }}>
                  scope: {sw.scope}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* 段间切换延迟（客户端最近 200 条） */}
      <section
        style={{
          background: '#FFF',
          borderRadius: 8,
          padding: '16px 20px',
          border: '1px solid #e8e8e8',
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#333' }}>
          段间切换延迟（设备本地）
        </h3>
        {clientStats.count === 0 ? (
          <div style={{ fontSize: 12, color: '#999' }}>
            暂无数据。用户首次打开页面后即可开始采集。
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 12, color: '#555' }}>
            <thead>
              <tr style={{ color: '#999', fontWeight: 500 }}>
                <th style={{ textAlign: 'left', padding: '4px 0' }}>指标</th>
                <th style={{ textAlign: 'right', padding: '4px 0' }}>值</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>样本数</td>
                <td style={{ textAlign: 'right' }}>{clientStats.count}</td>
              </tr>
              <tr>
                <td>命中率</td>
                <td style={{ textAlign: 'right' }}>
                  {(clientStats.hitRate * 100).toFixed(1)}%
                </td>
              </tr>
              <tr>
                <td>P50 总耗时</td>
                <td style={{ textAlign: 'right' }}>{clientStats.p50} ms</td>
              </tr>
              <tr>
                <td>P95 总耗时</td>
                <td
                  style={{
                    textAlign: 'right',
                    color: clientStats.p95 > 200 ? '#ff4d4f' : '#52c41a',
                  }}
                >
                  {clientStats.p95} ms
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* 服务端聚合（所有客户端） */}
      <section
        style={{
          background: '#FFF',
          borderRadius: 8,
          padding: '16px 20px',
          border: '1px solid #e8e8e8',
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#333' }}>
          服务端聚合（所有用户）
        </h3>
        {serverStats && serverStats.count > 0 ? (
          <table style={{ width: '100%', fontSize: 12, color: '#555' }}>
            <tbody>
              <tr>
                <td>样本数</td>
                <td style={{ textAlign: 'right' }}>{serverStats.count}</td>
              </tr>
              <tr>
                <td>命中率</td>
                <td style={{ textAlign: 'right' }}>
                  {(serverStats.hitRate * 100).toFixed(1)}%
                </td>
              </tr>
              <tr>
                <td>P50 loadingMs</td>
                <td style={{ textAlign: 'right' }}>{serverStats.p50_loadingMs}</td>
              </tr>
              <tr>
                <td>P95 loadingMs</td>
                <td
                  style={{
                    textAlign: 'right',
                    color: serverStats.p95_loadingMs > 200 ? '#ff4d4f' : '#52c41a',
                  }}
                >
                  {serverStats.p95_loadingMs}
                </td>
              </tr>
              <tr>
                <td>P50 totalMs</td>
                <td style={{ textAlign: 'right' }}>{serverStats.p50_totalMs}</td>
              </tr>
              <tr>
                <td>P95 totalMs</td>
                <td
                  style={{
                    textAlign: 'right',
                    color: serverStats.p95_totalMs > 200 ? '#ff4d4f' : '#52c41a',
                  }}
                >
                  {serverStats.p95_totalMs}
                </td>
              </tr>
              <tr>
                <td>错误数</td>
                <td style={{ textAlign: 'right' }}>{serverStats.recentErrors}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 12, color: '#999' }}>
            暂无上报（用户在微信浏览器操作后自动上报）
          </div>
        )}
      </section>
    </div>
  );
}