/**
 * 知识库管理独立页面
 * - Token 登录鉴权
 * - Collection 管理（创建/删除/切换）
 * - 知识摄入（文本添加）
 * - 调试搜索
 */
import { useState, useEffect, useCallback } from 'react';

interface CollectionInfo {
  name: string;
  points_count: number;
  vector_size: number;
  distance: string;
}

interface SearchResult {
  score: number;
  text: string;
  source: string;
  collection: string;
}

const API_BASE = '';
const TOKEN_KEY = 'knowledge_admin_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { 'X-Knowledge-Admin-Token': token };
}

/** Token 登录界面 */
function LoginView({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setLocalToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/collections`, {
        headers: { 'X-Knowledge-Admin-Token': t },
      });
      if (res.ok) {
        onLogin(t);
      } else {
        setError('Token 无效，请检查后重试');
      }
    } catch {
      setError('服务不可达，请确认服务已启动');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#F0F2F5',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#FFF',
          padding: '40px 36px',
          borderRadius: 12,
          boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
          width: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a1a', margin: 0 }}>
            知识库管理
          </h2>
          <p style={{ fontSize: 13, color: '#999', margin: '8px 0 0' }}>
            请输入管理员 Token 以继续
          </p>
        </div>

        <input
          type="password"
          value={token}
          onChange={(e) => { setLocalToken(e.target.value); setError(''); }}
          placeholder="Knowledge Admin Token"
          autoFocus
          style={{
            width: '100%',
            padding: '10px 14px',
            fontSize: 14,
            border: '1px solid #d9d9d9',
            borderRadius: 6,
            outline: 'none',
            fontFamily: 'monospace',
          }}
        />

        {error && (
          <div
            style={{
              padding: '8px 12px',
              fontSize: 13,
              color: '#ff4d4f',
              background: '#FFF2F0',
              border: '1px solid #FFCCC7',
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !token.trim()}
          style={{
            width: '100%',
            padding: '10px 0',
            fontSize: 15,
            fontWeight: 500,
            background: loading ? '#b0b0b0' : '#1890FF',
            color: '#FFF',
            border: 'none',
            borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '验证中...' : '验证'}
        </button>
      </form>
    </div>
  );
}

/** 知识管理主界面 */
function AdminDashboard({ onLogout }: { onLogout: () => void }) {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selectedCollection, setSelectedCollection] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [ingestText, setIngestText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // 加载集合列表（限定 pulan_default）
  const loadCollections = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/collections`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      // 仅保留 pulan_default
      const allCollections: CollectionInfo[] = data.collections || [];
      const filtered = allCollections.filter((c) => c.name === 'pulan_default');
      setCollections(filtered);
      if (filtered.length > 0) {
        setSelectedCollection('pulan_default');
      }
    } catch {
      // 静默失败
    }
  }, []);

  useEffect(() => {
    loadCollections();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 创建集合
  const handleCreateCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) return;
    setLoading(true);
    setStatusMsg('');
    try {
      await fetch(`${API_BASE}/api/knowledge/collections`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setNewCollectionName('');
      setStatusMsg(`集合 "${name}" 创建成功`);
      await loadCollections();
      setSelectedCollection(name.toLowerCase().replace(/ /g, '_').replace(/-/g, '_'));
    } catch (e: any) {
      setStatusMsg(`创建失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 删除集合
  const handleDeleteCollection = async () => {
    if (!selectedCollection) return;
    if (!confirm(`确定要删除集合 "${selectedCollection}" 吗？其中所有知识将丢失。`)) return;
    setLoading(true);
    setStatusMsg('');
    try {
      await fetch(`${API_BASE}/api/knowledge/collections/${selectedCollection}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      setStatusMsg(`集合 "${selectedCollection}" 已删除`);
      setSelectedCollection('');
      await loadCollections();
    } catch (e: any) {
      setStatusMsg(`删除失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 摄入知识
  const handleIngest = async () => {
    const text = ingestText.trim();
    if (!text || !selectedCollection) return;
    setLoading(true);
    setStatusMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/ingest`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: selectedCollection,
          documents: [{ text }],
        }),
      });
      const data = await res.json();
      setIngestText('');
      setStatusMsg(`已添加 ${data.ingested} 条知识`);
      await loadCollections();
    } catch (e: any) {
      setStatusMsg(`添加失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 搜索
  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, k: '5' });
      if (selectedCollection) params.set('collection', selectedCollection);
      const res = await fetch(`${API_BASE}/api/knowledge/search?${params}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (e: any) {
      setStatusMsg(`搜索失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#F5F5F5' }}>
      {/* 顶部栏 */}
      <div
        style={{
          padding: '12px 24px',
          background: '#FFF',
          borderBottom: '1px solid #e8e8e8',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', margin: 0 }}>
          知识库管理
        </h1>
        <button
          onClick={onLogout}
          style={{
            padding: '6px 16px',
            fontSize: 13,
            background: '#FAFAFA',
            color: '#666',
            border: '1px solid #d9d9d9',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          退出登录
        </button>
      </div>

      {/* 主内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px', maxWidth: 800, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* 集合管理区 */}
          <section style={{ background: '#FFF', borderRadius: 8, padding: '20px 24px', border: '1px solid #e8e8e8' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 16px', color: '#333' }}>集合管理</h2>

            {/* 集合下拉 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>当前集合</label>
              <select
                value={selectedCollection}
                onChange={(e) => setSelectedCollection(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: 14,
                  border: '1px solid #d9d9d9',
                  borderRadius: 4,
                  background: '#FFF',
                }}
              >
                {collections.length === 0 && (
                  <option value="">-- 暂无集合，请新建 --</option>
                )}
                {collections.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.points_count} 条知识)
                  </option>
                ))}
              </select>
            </div>

            {/* 新建集合 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="新集合名称"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  fontSize: 13,
                  border: '1px solid #d9d9d9',
                  borderRadius: 4,
                  outline: 'none',
                }}
              />
              <button
                onClick={handleCreateCollection}
                disabled={loading || !newCollectionName.trim()}
                style={{
                  padding: '8px 20px',
                  fontSize: 13,
                  background: loading ? '#d9d9d9' : '#52c41a',
                  color: '#FFF',
                  border: 'none',
                  borderRadius: 4,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                新建集合
              </button>
            </div>

            {/* 删除集合 */}
            {selectedCollection && (
              <button
                onClick={handleDeleteCollection}
                disabled={loading}
                style={{
                  padding: '8px 20px',
                  fontSize: 13,
                  background: '#ff4d4f',
                  color: '#FFF',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                删除当前集合
              </button>
            )}
          </section>

          {/* 知识摄入区 */}
          <section style={{ background: '#FFF', borderRadius: 8, padding: '20px 24px', border: '1px solid #e8e8e8' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 16px', color: '#333' }}>添加知识</h2>
            <textarea
              value={ingestText}
              onChange={(e) => setIngestText(e.target.value)}
              placeholder="输入知识内容，超过 500 字自动分块..."
              rows={6}
              disabled={!selectedCollection || loading}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: '10px 14px',
                fontSize: 14,
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                outline: 'none',
                fontFamily: 'inherit',
                lineHeight: 1.6,
                background: (!selectedCollection || loading) ? '#f5f5f5' : '#FFF',
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={handleIngest}
              disabled={loading || !ingestText.trim() || !selectedCollection}
              style={{
                marginTop: 8,
                width: '100%',
                padding: '10px 0',
                fontSize: 14,
                background: loading ? '#d9d9d9' : '#1890FF',
                color: '#FFF',
                border: 'none',
                borderRadius: 4,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              添加到当前集合
            </button>
          </section>

          {/* 搜索区 */}
          <section style={{ background: '#FFF', borderRadius: 8, padding: '20px 24px', border: '1px solid #e8e8e8' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 16px', color: '#333' }}>搜索知识</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="输入关键词或问题..."
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  fontSize: 14,
                  border: '1px solid #d9d9d9',
                  borderRadius: 4,
                  outline: 'none',
                }}
              />
              <button
                onClick={handleSearch}
                disabled={loading || !searchQuery.trim()}
                style={{
                  padding: '8px 24px',
                  fontSize: 14,
                  background: loading ? '#d9d9d9' : '#FAAD14',
                  color: '#FFF',
                  border: 'none',
                  borderRadius: 4,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                搜索
              </button>
            </div>

            {/* 搜索结果 */}
            {searchResults.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {searchResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '10px 14px',
                      marginBottom: 8,
                      background: '#FAFAFA',
                      borderRadius: 6,
                      border: '1px solid #f0f0f0',
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    <div style={{ color: '#999', fontSize: 12, marginBottom: 4 }}>
                      [{r.collection}] 相似度: {r.score.toFixed(4)}
                    </div>
                    <div style={{ color: '#333' }}>{r.text}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 状态提示 */}
          {statusMsg && (
            <div
              style={{
                padding: '10px 16px',
                fontSize: 13,
                color: '#666',
                background: '#FFFBE6',
                border: '1px solid #FFE58F',
                borderRadius: 6,
                textAlign: 'center',
              }}
            >
              {statusMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [token, setAppToken] = useState<string | null>(getToken);

  const handleLogin = (t: string) => {
    setToken(t);
    setAppToken(t);
  };

  const handleLogout = () => {
    clearToken();
    setAppToken(null);
  };

  if (!token) {
    return <LoginView onLogin={handleLogin} />;
  }

  return <AdminDashboard onLogout={handleLogout} />;
}
