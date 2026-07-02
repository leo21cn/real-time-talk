# RAG 知识库 Qdrant 集成

## 架构概览

```
用户消息 → AgentEngine.process_message()
           ├→ EmbeddingClient.embed(query)        # 查询向量化
           ├→ QdrantClient.search(vector, top_k=5) # 语义检索
           ├→ 注入检索结果到 messages 列表           # 上下文增强
           └→ LlmClient.chat(messages)              # LLM 生成回复
```

**新增模块：**
- `server/services/qdrant_client.py` — Qdrant HTTP API 封装
- `server/services/embedding_client.py` — DashScope 文本嵌入封装
- `server/rag/__init__.py` — RAG 模块入口
- `server/api/routes_knowledge.py` — 知识管理 REST API

**修改模块：**
- `docker-compose.yml` — 添加 Qdrant 服务
- `server/config.py` — 添加 Qdrant + Embedding 配置项
- `.env` / `.env.example` — 添加环境变量
- `server/main.py` — 注册路由、初始化客户端
- `server/agent/agent_engine.py` — 集成 RAG 检索
- `server/agent/conversation_manager.py` — 支持注入 RAG 上下文
- `server/requirements.txt` — 添加依赖

---

## Task 1：基础设施 — Docker 服务 + 配置 + 依赖

- 修改 `docker-compose.yml`：
  - 添加 `qdrant` 服务（镜像 `qdrant/qdrant:latest`），端口 6333/6334，挂载 volume `qdrant_data`
  - server 的 `depends_on` 添加 qdrant
  - nginx 可选的，无需改动
- 修改 `.env` 和 `.env.example`：
  - 新增 `QDRANT_URL=http://qdrant:6333`
  - 新增 `QDRANT_COLLECTION=knowledge`
  - 新增 `EMBEDDING_ENDPOINT=https://dashscope.aliyuncs.com/compatible-mode/v1`
  - 新增 `EMBEDDING_MODEL=text-embedding-v3`
  - 新增 `RAG_TOP_K=5` （检索返回条数）
- 修改 `server/config.py`：
  - 添加 `AppConfig` 中 Qdrant/Embedding/RAG 字段（环境变量映射）
  - 在 `load_config()` 中合并到返回字典
- 修改 `server/requirements.txt`：
  - 添加 `qdrant-client>=1.9.0`（Python SDK，用于类型定义和便利方法）

## Task 2：QdrantClient 封装

- 新建 `server/services/qdrant_client.py`：
  - 类 `QdrantClient`，通过 httpx 异步请求 Qdrant REST API
  - 方法：
    - `ensure_collection(collection, vector_size)` — 创建集合（若不存在）
    - `upsert(collection, points)` — 批量写入向量点
    - `search(collection, vector, limit)` — 语义检索
    - `delete(collection, doc_ids)` — 按文档 ID 删除
    - `count(collection)` — 统计文档数量
  - 不依赖 `qdrant-client` Python SDK（减少镜像体积），直接用 httpx 调 REST API
  - Qdrant REST API 端点：
    - `PUT /collections/{name}` — 创建集合
    - `PUT /collections/{name}/points` — upsert
    - `POST /collections/{name}/points/search` — 检索
    - `POST /collections/{name}/points/delete` — 删除

## Task 3：EmbeddingClient 封装

- 新建 `server/services/embedding_client.py`：
  - 类 `EmbeddingClient`，调用 DashScope Embedding API
  - 方法 `embed(texts: list[str]) -> list[list[float]]`
  - DashScope Embedding API：
    - `POST {endpoint}/embeddings`
    - Body: `{ "model": "text-embedding-v3", "input": { "texts": [...] } }`
    - 返回: `data[i].embedding`，维度 1024
  - 支持批量（单次最多 10 条文本，API 限制）
  - 重试 + 错误处理（复用 LlmClient 的 httpx 模式）

## Task 4：RAG 知识管理 API

- 新建 `server/rag/__init__.py` — 导出 RAG 核心逻辑
- 新建 `server/api/routes_knowledge.py`：
  - **`POST /api/knowledge/ingest`**
    - Body: `{ "documents": [{ "text": "...", "source": "可选来源标识" }] }`
    - 流程：embed → upsert 到 Qdrant
    - 返回: `{ "ingested": 3, "total": 150 }`
    - 自动分块：若单条 text 超过 500 字符，按 `\n\n` 或 500 字符窗口切分（重叠 100 字符）
  - **`GET /api/knowledge/stats`**
    - 返回集合名称、向量数
  - **`DELETE /api/knowledge/clear`**
    - 清空整个集合（重建空集合）
  - **`GET /api/knowledge/search?q=测试&k=3`**
    - 调试用：文本搜索 → embed → Qdrant search → 返回结果

- 修改 `server/main.py`：
  - 导入 `routes_knowledge`，`app.include_router`
  - 在 `lifespan` 中初始化 `QdrantClient` + `EmbeddingClient` 并确保 collection 存在

## Task 5：AgentEngine 集成 RAG 检索

- 在 `AgentEngine.process_message()` 的 Step 3 和 Step 4 之间插入 RAG 检索：
  - 对用户文本 `user_text` 调 `EmbeddingClient.embed()`
  - 调 `QdrantClient.search()` 获取 top_k 条结果
  - 将检索结果构建为上下文文本：`[知识库参考]\n1. {text1}\n2. {text2}...`
  - 在 `messages` 中紧接 system prompt 之后插入一条 `system` 消息承载上下文：
    ```
    [以下是知识库中与用户问题相关的参考内容，请优先基于这些内容回答]
    参考1: ...
    参考2: ...
    ```
- 修改 `ConversationManager.get_messages_for_llm()`：
  - 新增可选参数 `rag_context: Optional[str] = None`
  - 若提供 rag_context，插入为第二条 system 消息（在 system prompt 之后、history 之前）
- 当 Qdrant 无结果时，静默跳过（不注入上下文，走纯通用 LLM 回复）

## Task 6：System Prompt 适配

- 修改 `server/resources/default_system_prompt.txt`：
  - 在"回复规范"之前增加一条 RAG 指导：
    ```
    知识库使用规则：
    - 当对话中提供「知识库参考内容」时，优先基于这些内容回答问题
    - 如果知识库内容与你的通用知识冲突，以知识库内容为准
    - 如果用户的问题与知识库内容无关，直接用你的通用知识回答
    - 引用知识库内容时，用自然的语言融入回复，不要直接说「根据知识库」
    ```

## Task 7：客户端知识管理界面（可选）

- 在 `ChatPanel.tsx` 中添加一个可折叠的「知识库」面板：
  - 显示已灌入文档数量（调 `GET /api/knowledge/stats`）
  - 一个文本输入框 + 「添加知识」按钮（调 `POST /api/knowledge/ingest`）
  - 简单易用，方便用户随时补充知识

## Task 8：重建部署 + 端到端验证

- `docker compose build server` 重建镜像
- `docker compose up -d` 启动全部服务（含 Qdrant）
- 验证链路：
  1. `curl POST /api/knowledge/ingest` 灌入测试知识（如「普兰的办公室在杭州西湖区」）
  2. `curl GET /api/knowledge/stats` 确认已写入
  3. 浏览器发送「普兰的办公室在哪？」
  4. 验证 AI 回复引用了灌入的知识（如「我的办公室在杭州西湖区」而非通用回答）
