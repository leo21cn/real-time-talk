/**
 * 知识库管理面板
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

export default function KnowledgePanel() {
  const [expanded, setExpanded] = useState(false);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selectedCollection, setSelectedCollection] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [ingestText, setIngestText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // 加载集合列表
  const loadCollections = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/collections`);
      const data = await res.json();
      setCollections(data.collections || []);
      if (data.collections?.length > 0 && !selectedCollection) {
        setSelectedCollection(data.collections[0].name);
      }
    } catch {
      // 静默失败
    }
  }, [selectedCollection]);

  useEffect(() => {
    if (expanded) {
      loadCollections();
    }
  }, [expanded, loadCollections]);

  // 创建集合
  const handleCreateCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) return;
    setLoading(true);
    setStatusMsg('');
    try {
      await fetch(`${API_BASE}/api/knowledge/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`${API_BASE}/api/knowledge/search?${params}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (e: any) {
      setStatusMsg(`搜索失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        transition: 'all 0.3s ease',
        width: expanded ? 280 : 36,
        minWidth: expanded ? 280 : 36,
        overflow: 'hidden',
        border: '1px solid #e8e8e8',
        borderRadius: 12,
        background: '#FAFAFA',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      }}
    >
      {/* 折叠开关 */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '10px 12px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: '#FFF',
          borderBottom: expanded ? '1px solid #e8e8e8' : 'none',
          borderRadius: 12,
          userSelect: 'none',
          fontSize: 14,
          fontWeight: 600,
          color: '#555',
        }}
      >
        <span style={{ flexShrink: 0 }}>{expanded ? '<<' : '>>'}</span>
        {expanded && <span>知识库</span>}
        {!expanded && (
          <span style={{ writingMode: 'vertical-rl', fontSize: 13, letterSpacing: 2 }}>
            知识库
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Collection 选择区 */}
          <div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>集合管理</div>
            <select
              value={selectedCollection}
              onChange={(e) => setSelectedCollection(e.target.value)}
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: 13,
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                background: '#FFF',
              }}
            >
              {collections.length === 0 && (
                <option value="">-- 无集合 --</option>
              )}
              {collections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.points_count}条)
                </option>
              ))}
            </select>
          </div>

          {/* 新建集合 */}
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              type="text"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              placeholder="新集合名称"
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: 12,
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                outline: 'none',
              }}
            />
            <button
              onClick={handleCreateCollection}
              disabled={loading || !newCollectionName.trim()}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                background: loading ? '#d9d9d9' : '#52c41a',
                color: '#FFF',
                border: 'none',
                borderRadius: 4,
                cursor: loading ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              +新建
            </button>
          </div>

          {/* 删除集合 */}
          {selectedCollection && (
            <button
              onClick={handleDeleteCollection}
              disabled={loading}
              style={{
                padding: '4px 10px',
                fontSize: 12,
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

          {/* 分隔线 */}
          <div style={{ borderTop: '1px solid #e8e8e8' }} />

          {/* 知识摄入区 */}
          <div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>添加知识</div>
            <textarea
              value={ingestText}
              onChange={(e) => setIngestText(e.target.value)}
              placeholder="输入知识内容..."
              rows={4}
              disabled={!selectedCollection || loading}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: '6px 8px',
                fontSize: 12,
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                background: (!selectedCollection || loading) ? '#f5f5f5' : '#FFF',
              }}
            />
            <button
              onClick={handleIngest}
              disabled={loading || !ingestText.trim() || !selectedCollection}
              style={{
                marginTop: 4,
                width: '100%',
                padding: '6px 12px',
                fontSize: 12,
                background: loading ? '#d9d9d9' : '#1890FF',
                color: '#FFF',
                border: 'none',
                borderRadius: 4,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              已添加到当前集合
            </button>
          </div>

          {/* 分隔线 */}
          <div style={{ borderTop: '1px solid #e8e8e8' }} />

          {/* 搜索区 */}
          <div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>搜索知识</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="搜索关键词..."
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  fontSize: 12,
                  border: '1px solid #d9d9d9',
                  borderRadius: 4,
                  outline: 'none',
                }}
              />
              <button
                onClick={handleSearch}
                disabled={loading || !searchQuery.trim()}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
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
              <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto' }}>
                {searchResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '4px 6px',
                      marginBottom: 4,
                      background: '#FFF',
                      borderRadius: 4,
                      border: '1px solid #f0f0f0',
                      fontSize: 11,
                      lineHeight: 1.4,
                    }}
                  >
                    <div style={{ color: '#999' }}>
                      [{r.collection}] score: {r.score.toFixed(3)}
                    </div>
                    <div style={{ color: '#333' }}>{r.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 状态提示 */}
          {statusMsg && (
            <div
              style={{
                padding: '4px 8px',
                fontSize: 11,
                color: '#666',
                background: '#FFFBE6',
                border: '1px solid #FFE58F',
                borderRadius: 4,
                textAlign: 'center',
              }}
            >
              {statusMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
