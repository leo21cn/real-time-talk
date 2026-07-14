# RAG 检索增强

<cite>
**本文引用的文件**   
- [server/main.py](file://server/main.py)
- [server/config.py](file://server/config.py)
- [server/rag/__init__.py](file://server/rag/__init__.py)
- [server/rag/collections_resolver.py](file://server/rag/collections_resolver.py)
- [server/services/embedding_client.py](file://server/services/embedding_client.py)
- [server/services/qdrant_client.py](file://server/services/qdrant_client.py)
- [server/api/routes_knowledge.py](file://server/api/routes_knowledge.py)
- [server/agent/agent_engine.py](file://server/agent/agent_engine.py)
- [server/agent/conversation_manager.py](file://server/agent/conversation_manager.py)
- [server/api/ws_handler.py](file://server/api/ws_handler.py)
- [doc/Qdrant知识库操作指南.md](file://doc/Qdrant知识库操作指南.md)
- [tests/test_collection_normalize.py](file://tests/test_collection_normalize.py)
</cite>

## 更新摘要
**变更内容**   
- 新增集合模式解析器模块，支持通配符模式查询
- 扩展角色-集合映射机制，支持 "*"、"pulan_*"、标量、列表四种语义
- 实现动态集合分辨率，提升分布式知识库检索灵活性
- 增强Qdrant客户端工具方法，提供通配符检测和前缀提取功能
- 完善测试覆盖，确保新功能的稳定性和向后兼容性

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能与优化](#性能与优化)
8. [故障排查](#故障排查)
9. [结论](#结论)
10. [附录：扩展与自定义示例](#附录扩展与自定义示例)

## 简介
本技术文档面向 RealTimeTalk 的 RAG（检索增强生成）子系统，系统性阐述其实现原理与工程实践。内容覆盖向量嵌入生成、语义相似度搜索、上下文构建、Qdrant 集合管理与查询优化、嵌入客户端配置与模型选择、**新增的集合模式解析器**、角色-集合映射机制、动态检索范围控制、结果质量评估与排序策略，并提供可操作的扩展与调优建议，兼顾初学者友好与资深开发者深度需求。

## 项目结构
RAG 相关代码主要分布在以下模块：
- 服务入口与生命周期管理：负责初始化 Qdrant 与 Embedding 客户端，并将它们注入到 Agent 引擎
- 配置中心：统一加载 JSON 与环境变量，提供 rag_top_k、role_collections 等关键参数
- **集合模式解析器**：处理角色值到实际检索集合列表的转换，支持通配符模式
- 检索增强工具：文本分块与上下文构建
- 外部服务客户端：DashScope 文本嵌入、Qdrant 向量数据库
- 知识库管理 API：集合管理、知识摄入、统计与调试搜索
- Agent 引擎：对话流程中触发 RAG 检索并注入上下文

```mermaid
graph TB
A["FastAPI 应用<br/>server/main.py"] --> B["配置加载<br/>server/config.py"]
A --> C["Qdrant 客户端<br/>server/services/qdrant_client.py"]
A --> D["嵌入客户端<br/>server/services/embedding_client.py"]
A --> E["Agent 引擎<br/>server/agent/agent_engine.py"]
E --> F["对话历史管理<br/>server/agent/conversation_manager.py"]
E --> G["RAG 工具<br/>server/rag/__init__.py"]
E --> H["集合模式解析器<br/>server/rag/collections_resolver.py"]
A --> I["知识库管理 API<br/>server/api/routes_knowledge.py"]
I --> C
I --> D
I --> G
J["WebSocket 处理器<br/>server/api/ws_handler.py"] --> E
J --> H
```

**图表来源**
- [server/main.py:42-90](file://server/main.py#L42-L90)
- [server/config.py:148-241](file://server/config.py#L148-L241)
- [server/services/qdrant_client.py:26-112](file://server/services/qdrant_client.py#L26-L112)
- [server/services/embedding_client.py:26-70](file://server/services/embedding_client.py#L26-L70)
- [server/agent/agent_engine.py:59-121](file://server/agent/agent_engine.py#L59-L121)
- [server/agent/conversation_manager.py:21-95](file://server/agent/conversation_manager.py#L21-L95)
- [server/rag/__init__.py:10-83](file://server/rag/__init__.py#L10-L83)
- [server/rag/collections_resolver.py:1-79](file://server/rag/collections_resolver.py#L1-79)
- [server/api/routes_knowledge.py:134-186](file://server/api/routes_knowledge.py#L134-L186)
- [server/api/ws_handler.py:370-405](file://server/api/ws_handler.py#L370-L405)

章节来源
- [server/main.py:42-90](file://server/main.py#L42-L90)
- [server/config.py:148-241](file://server/config.py#L148-L241)

## 核心组件
- 嵌入客户端（EmbeddingClient）
  - 功能：调用 DashScope 文本嵌入 API，将文本批量转为固定维度向量（默认 1024 维）
  - 特性：批处理（最多 10 条/批）、重试与限流处理、错误解析
  - 配置项：endpoint、api_key、model；通过 get_config() 读取 embedding.* 字段
- Qdrant 客户端（QdrantClient）
  - 功能：集合 CRUD、点写入（upsert）、单集合搜索、多集合并发搜索（search_multi）、计数与清空
  - 索引策略：创建集合时指定向量维度与距离度量（默认 Cosine）
  - 鉴权：可选 api-key 请求头
  - **新增工具方法**：is_wildcard() 检测通配符，extract_prefix() 提取前缀
- **集合模式解析器（CollectionsResolver）**
  - 功能：统一处理 ROLE_COLLECTIONS 中角色值到实际检索集合列表的转换
  - 支持语义：`*`（全部集合）、`pulan_*`（前缀匹配）、标量（精确匹配）、列表（多集合）
  - 动态解析：根据配置自动调用 list_collections() 进行集合发现
- RAG 工具（chunk_text、build_rag_context）
  - chunk_text：按段落优先切分，超长段落使用滑动窗口，支持重叠
  - build_rag_context：过滤低分结果，拼接为 system 消息片段
- Agent 引擎（AgentEngine）
  - 在 process_message 中执行 RAG 检索，根据 role_collections 决定检索范围，合并结果后注入上下文
  - **集成集合模式解析器**：通过 resolve_search_collections() 实现动态集合分辨率
  - 降级策略：当无集合、无结果或异常时回退纯 LLM 回复
- 对话历史管理（ConversationManager）
  - 维护 messages 列表，支持 Redis 持久化与智能摘要
  - 组装 messages 时插入 RAG 上下文片段
- 知识库管理 API（routes_knowledge）
  - 集合管理、知识摄入（自动分块+嵌入+upsert）、统计与调试搜索
  - 鉴权：X-Knowledge-Admin-Token 请求头

章节来源
- [server/services/embedding_client.py:26-149](file://server/services/embedding_client.py#L26-L149)
- [server/services/qdrant_client.py:26-257](file://server/services/qdrant_client.py#L26-L257)
- [server/rag/collections_resolver.py:1-79](file://server/rag/collections_resolver.py#L1-79)
- [server/rag/__init__.py:10-83](file://server/rag/__init__.py#L10-L83)
- [server/agent/agent_engine.py:59-181](file://server/agent/agent_engine.py#L59-L181)
- [server/agent/conversation_manager.py:21-139](file://server/agent/conversation_manager.py#L21-L139)
- [server/api/routes_knowledge.py:134-267](file://server/api/routes_knowledge.py#L134-L267)

## 架构总览
下图展示从用户提问到返回回答的端到端流程，包括新增的集合模式解析器和 RAG 检索与上下文注入。

```mermaid
sequenceDiagram
participant Client as "客户端"
participant WS as "WebSocket 处理器"
participant Agent as "AgentEngine"
participant Conf as "配置中心"
participant Resolver as "集合模式解析器"
participant Emb as "EmbeddingClient"
participant Q as "QdrantClient"
participant CM as "ConversationManager"
participant LLM as "LLM 客户端"
Client->>WS : 发送用户消息
WS->>Agent : process_message(user_text)
Agent->>CM : add_message("user", user_text)
Agent->>CM : summarize_if_needed()
Agent->>CM : get_messages_for_llm()
Agent->>Conf : 读取 rag.role_collections, rag.top_k
Agent->>Resolver : resolve_search_collections(qdrant, role_cols)
alt role_cols == "*"
Resolver->>Q : list_collections()
Q-->>Resolver : 所有集合名
else role_cols == "pulan_*"
Resolver->>Q : list_collections()
Q-->>Resolver : 所有集合名
Resolver->>Resolver : 过滤 pulan_ 前缀集合
else 列表或字符串
Resolver->>Resolver : 直接规范化集合名称
end
Resolver-->>Agent : 解析后的集合列表
Agent->>Emb : embed([query])
Emb-->>Agent : 查询向量
Agent->>Q : search_multi(collections, vector, limit=top_k)
Q-->>Agent : 合并后的 TopK 结果
Agent->>Agent : build_rag_context(results)
Agent->>CM : get_messages_for_llm(rag_context)
Agent->>LLM : chat(messages)
LLM-->>Agent : 回复文本
Agent->>CM : add_message("assistant", reply)
Agent-->>WS : 返回回复
WS-->>Client : 推送回复
```

**图表来源**
- [server/agent/agent_engine.py:74-121](file://server/agent/agent_engine.py#L74-L121)
- [server/agent/agent_engine.py:123-180](file://server/agent/agent_engine.py#L123-L180)
- [server/rag/collections_resolver.py:24-79](file://server/rag/collections_resolver.py#L24-L79)
- [server/rag/__init__.py:56-83](file://server/rag/__init__.py#L56-L83)
- [server/services/embedding_client.py:47-70](file://server/services/embedding_client.py#L47-L70)
- [server/services/qdrant_client.py:164-186](file://server/services/qdrant_client.py#L164-L186)
- [server/agent/conversation_manager.py:46-95](file://server/agent/conversation_manager.py#L46-L95)

## 详细组件分析

### 集合模式解析器（CollectionsResolver）
**新增组件** - 专门处理角色配置到实际集合列表的动态解析

- 设计要点
  - 统一接口：resolve_search_collections() 函数处理所有角色值类型
  - 四种语义支持：`*`（全部）、`pulan_*`（前缀匹配）、标量（精确）、列表（多集合）
  - 动态集合发现：通配符模式下自动调用 list_collections() 获取可用集合
  - 健壮性处理：空值、非字符串、非匹配等情况的安全降级
- 复杂度
  - 时间复杂度：O(N) 其中 N 为集合总数（通配符模式）
  - 空间复杂度：O(K) 其中 K 为匹配的集合数量
- 使用场景
  - 生产环境默认配置 `{"普兰": "pulan_*"}` 自动匹配所有 pulan_ 前缀集合
  - 开发环境可使用 `*` 匹配所有集合进行测试
  - 特定业务场景可使用精确集合名或集合列表

```mermaid
flowchart TD
Start(["开始"]) --> CheckType{"检查 role_cols 类型"}
CheckType --> |列表| NormalizeList["规范化每个集合名"]
CheckType --> |非字符串| ReturnEmpty["返回空列表"]
CheckType --> |字符串| CheckEmpty{"是否为空字符串?"}
CheckEmpty --> |是| ReturnEmpty
CheckEmpty --> |否| CheckWildcard{"是否包含通配符?"}
CheckWildcard --> |是| GetPrefix["提取前缀"]
GetPrefix --> ListCollections["调用 list_collections()"]
ListCollections --> FilterByPrefix{"是否有前缀?"}
FilterByPrefix --> |有| FilterCollections["过滤匹配前缀的集合"]
FilterByPrefix --> |无| UseAll["使用全部集合"]
FilterByPrefix --> NormalizeScalar["规范化单个集合名"]
NormalizeList --> End(["结束"])
UseAll --> End
FilterCollections --> End
NormalizeScalar --> End
ReturnEmpty --> End
```

**图表来源**
- [server/rag/collections_resolver.py:24-79](file://server/rag/collections_resolver.py#L24-L79)

章节来源
- [server/rag/collections_resolver.py:1-79](file://server/rag/collections_resolver.py#L1-79)

### Qdrant 客户端（QdrantClient）
- 设计要点
  - 集合管理：create/delete/list/info/count/clear
  - 数据操作：upsert、search、search_multi（并发合并排序）、delete_points
  - 索引策略：创建集合时指定向量维度与距离度量（Cosine）
  - **新增工具方法**：is_wildcard() 检测通配符模式，extract_prefix() 提取通配符前缀
- 复杂度
  - upsert/search：近似 O(1) 写入，O(log N) 检索（取决于底层索引）
  - search_multi：并发度等于集合数量，最终合并排序 O(K log K)
- 使用建议
  - 合理设置 top_k 与 limit，避免过大导致响应变慢
  - 对大集合定期清理无效条目，保持检索精度
  - 利用通配符模式简化集合管理，提高系统灵活性

```mermaid
classDiagram
class QdrantClient {
+create_collection(name, vector_size, distance)
+delete_collection(name)
+list_collections() str[]
+collection_info(name) dict
+count(name) int
+upsert(collection, points)
+search(collection, vector, limit) dict[]
+search_multi(collections, vector, limit) dict[]
+delete_points(collection, doc_ids)
+clear_collection(collection)
+generate_id() str
+normalize_collection_name(name) str
+is_wildcard(name) bool
+extract_prefix(wildcard) str
}
```

**图表来源**
- [server/services/qdrant_client.py:26-257](file://server/services/qdrant_client.py#L26-L257)

章节来源
- [server/services/qdrant_client.py:26-257](file://server/services/qdrant_client.py#L26-L257)

### 嵌入客户端（EmbeddingClient）
- 设计要点
  - 异步 HTTP 客户端，超时与重试策略完善
  - 批量处理：超过 batch_size 自动分批
  - 错误分类：鉴权失败、限流、服务端错误、网络异常
- 复杂度
  - 时间复杂度：O(N/B)，N 为文本数，B 为批大小
  - 空间复杂度：O(B) 每批缓存
- 配置与模型
  - endpoint、api_key、model 来自配置；默认模型 text-embedding-v3，输出维度 1024
- 使用建议
  - 合理设置 batch_size 以平衡吞吐与延迟
  - 监控 429/5xx 错误，必要时调整重试间隔

```mermaid
classDiagram
class EmbeddingClient {
+VECTOR_SIZE : int
+embed(texts) list[]float~~
-_embed_batch(texts) list[]float~~
-_headers() dict
}
```

**图表来源**
- [server/services/embedding_client.py:26-149](file://server/services/embedding_client.py#L26-L149)

章节来源
- [server/services/embedding_client.py:26-149](file://server/services/embedding_client.py#L26-L149)

### RAG 工具（分块与上下文构建）
- 分块策略
  - 优先按段落切分，段落内若超长则使用滑动窗口，保留 overlap 保证连续性
- 上下文构建
  - 过滤低分结果（score < 0.3），拼接为 system 消息片段，便于 LLM 优先参考

```mermaid
flowchart TD
Start(["开始"]) --> CheckLen["检查文本长度是否超过阈值"]
CheckLen --> |否| ReturnSingle["直接返回原文本"]
CheckLen --> |是| SplitPara["按段落切分"]
SplitPara --> BuildChunks["累积段落至不超过阈值"]
BuildChunks --> OverlapCheck{"段落是否超长?"}
OverlapCheck --> |是| SlideWindow["滑动窗口切分(含重叠)"]
OverlapCheck --> |否| AppendCurrent["追加当前段落"]
SlideWindow --> AppendCurrent
AppendCurrent --> End(["结束"])
```

**图表来源**
- [server/rag/__init__.py:10-53](file://server/rag/__init__.py#L10-L53)

章节来源
- [server/rag/__init__.py:10-83](file://server/rag/__init__.py#L10-L83)

### Agent 引擎（RAG 集成）
- 流程
  - 保存用户消息 → 智能摘要 → 获取 messages → **集合模式解析** → RAG 检索 → 注入上下文 → 调用 LLM → 保存助手回复
- **增强的角色-集合映射**
  - 从配置读取 role_collections，支持 "*"（全部集合）、"pulan_*"（前缀匹配）、列表（限定集合）
  - 通过 resolve_search_collections() 实现动态集合分辨率
- 降级策略
  - 无集合/无结果/异常时跳过 RAG，走纯 LLM 回复

```mermaid
sequenceDiagram
participant Agent as "AgentEngine"
participant Conf as "配置中心"
participant Resolver as "集合模式解析器"
participant Q as "QdrantClient"
participant Rag as "build_rag_context"
Agent->>Conf : 读取 rag.role_collections, rag.top_k
Agent->>Resolver : resolve_search_collections(qdrant, role_cols)
alt role_cols == "*"
Resolver->>Q : list_collections()
Q-->>Resolver : 所有集合名
else role_cols == "pulan_*"
Resolver->>Q : list_collections()
Q-->>Resolver : 所有集合名
Resolver->>Resolver : 过滤 pulan_ 前缀集合
else 列表或字符串
Resolver->>Resolver : 直接使用配置集合
end
Resolver-->>Agent : 解析后的集合列表
Agent->>Q : search_multi(collections, vector, limit=top_k)
Q-->>Agent : 合并后的 TopK 结果
Agent->>Rag : build_rag_context(results)
Rag-->>Agent : 上下文字符串
```

**图表来源**
- [server/agent/agent_engine.py:123-180](file://server/agent/agent_engine.py#L123-L180)
- [server/rag/collections_resolver.py:24-79](file://server/rag/collections_resolver.py#L24-L79)
- [server/rag/__init__.py:56-83](file://server/rag/__init__.py#L56-L83)

章节来源
- [server/agent/agent_engine.py:74-181](file://server/agent/agent_engine.py#L74-L181)

### WebSocket 处理器（RAG 集成）
- 功能
  - 处理 WebSocket 连接中的 RAG 检索逻辑
  - **集成集合模式解析器**：与 AgentEngine 保持一致的集合解析逻辑
  - 详细的日志记录：便于调试和监控
- 配置处理
  - 支持环境变量 ROLE_COLLECTIONS 覆盖默认配置
  - 兼容多种配置格式：JSON 字符串或字典对象

章节来源
- [server/api/ws_handler.py:370-405](file://server/api/ws_handler.py#L370-L405)

### 对话历史管理（ConversationManager）
- 功能
  - 维护 messages 列表，Redis 持久化，智能摘要
  - 组装 messages 时插入 RAG 上下文片段
- 复杂度
  - 摘要触发基于字符估算 token 数，阈值可控
- 使用建议
  - 合理设置 SUMMARY_THRESHOLD_TOKENS 以平衡上下文长度与成本

章节来源
- [server/agent/conversation_manager.py:21-139](file://server/agent/conversation_manager.py#L21-L139)

### 知识库管理 API（routes_knowledge）
- 能力
  - 集合管理：创建/删除/列出/信息/清空
  - 知识摄入：自动分块 → 批量嵌入 → upsert → 统计
  - 调试搜索：单集合或多集合语义检索
- 鉴权
  - X-Knowledge-Admin-Token 请求头校验

章节来源
- [server/api/routes_knowledge.py:81-267](file://server/api/routes_knowledge.py#L81-L267)

## 依赖关系分析
- 组件耦合
  - main.py 作为装配器，初始化 Qdrant 与 Embedding 客户端，并通过 set_rag_clients 注入到 AgentEngine
  - routes_knowledge 直接依赖 Qdrant 与 Embedding 客户端进行知识摄入与检索
  - AgentEngine 依赖 ConversationManager、RAG 工具和**集合模式解析器**完成上下文构建
  - **集合模式解析器**依赖 QdrantClient 进行集合发现和名称规范化
- 外部依赖
  - httpx 用于异步 HTTP 请求
  - Qdrant REST API 与 DashScope Embedding API

```mermaid
graph TB
Main["main.py"] --> QD["qdrant_client.py"]
Main --> EM["embedding_client.py"]
Main --> AE["agent_engine.py"]
AE --> CM["conversation_manager.py"]
AE --> RG["rag/__init__.py"]
AE --> CR["collections_resolver.py"]
CR --> QD
RK["routes_knowledge.py"] --> QD
RK --> EM
RK --> RG
WSH["ws_handler.py"] --> AE
WSH --> CR
```

**图表来源**
- [server/main.py:70-87](file://server/main.py#L70-L87)
- [server/api/routes_knowledge.py:134-186](file://server/api/routes_knowledge.py#L134-L186)
- [server/agent/agent_engine.py:59-121](file://server/agent/agent_engine.py#L59-L121)
- [server/rag/collections_resolver.py:19-24](file://server/rag/collections_resolver.py#L19-L24)
- [server/api/ws_handler.py:370-405](file://server/api/ws_handler.py#L370-L405)

章节来源
- [server/main.py:70-87](file://server/main.py#L70-L87)
- [server/api/routes_knowledge.py:134-186](file://server/api/routes_knowledge.py#L134-L186)
- [server/agent/agent_engine.py:59-121](file://server/agent/agent_engine.py#L59-L121)

## 性能与优化
- 嵌入批处理
  - 利用 EmbeddingClient 的批处理能力，提高吞吐；注意单次上限（如 10 条）
- 检索并发
  - search_multi 并发检索多个集合，减少整体延迟；需关注集合数量与网络开销
- **集合解析优化**
  - 通配符模式仅在需要时调用 list_collections()，避免不必要的网络请求
  - 标量和列表模式直接处理，无需额外 API 调用
- 结果过滤
  - build_rag_context 内置低分过滤（score >= 0.3），可减少无关上下文对 LLM 的干扰
- 索引与度量
  - 使用 Cosine 距离适合归一化向量；如需不同行为可在集合创建时调整
- 资源与超时
  - 合理设置 httpx 超时与重试策略，避免长尾请求拖慢整体链路
- 容量规划
  - 定期统计集合点数（count），清理过时知识，维持检索精度与性能
- **分布式检索优化**
  - 通过 pulan_* 前缀模式实现逻辑上的集合分组，便于水平扩展
  - 新集合只需遵循命名规范即可自动纳入检索范围，无需修改配置

## 故障排查
- 常见错误
  - 嵌入 API 鉴权失败（401/403）：检查 embedding.api_key 与 endpoint
  - 限流（429）：观察日志中的重试与等待逻辑，必要时降低并发或增加间隔
  - Qdrant 连接失败：确认 qdrant.url 与 api_key（若启用）
  - **集合解析失败**：检查 role_collections 配置格式，确认集合名称是否正确
  - **通配符匹配为空**：确认集合命名是否符合预期前缀（如 pulan_）
  - 检索结果为空：检查集合是否存在、知识是否已摄入、role_collections 是否正确
- 定位方法
  - 使用 /api/knowledge/search 调试检索效果，验证分数与文本相关性
  - 查看日志中的 RAG 相关提示（如"RAG 跳过"、"检索无结果"、"集合解析结果"）
  - **新增调试信息**：集合模式解析器会记录详细的解析过程和匹配结果
- 降级路径
  - 当 RAG 不可用时，系统自动回退纯 LLM 回复，确保可用性
  - **集合解析失败时**：返回空集合列表，触发 RAG 跳过逻辑

章节来源
- [server/services/embedding_client.py:84-135](file://server/services/embedding_client.py#L84-L135)
- [server/services/qdrant_client.py:115-186](file://server/services/qdrant_client.py#L115-L186)
- [server/rag/collections_resolver.py:48-56](file://server/rag/collections_resolver.py#L48-L56)
- [server/agent/agent_engine.py:178-180](file://server/agent/agent_engine.py#L178-L180)
- [server/api/routes_knowledge.py:233-267](file://server/api/routes_knowledge.py#L233-L267)

## 结论
RealTimeTalk 的 RAG 子系统以清晰的模块化设计与稳健的错误处理为基础，实现了从文本向量化、语义检索到上下文注入的完整链路。**新增的集合模式解析器**进一步增强了系统的灵活性和可扩展性，通过支持通配符模式查询和动态集合分辨率，使得分布式知识库的管理和维护变得更加便捷。通过角色-集合映射与动态检索范围控制，系统具备灵活的知识域隔离与扩展能力。结合合理的索引策略、并发检索与结果过滤，能够在保证检索精度的同时提升整体性能。对于初学者，建议从集合管理与知识摄入入手，逐步理解检索与上下文注入；对于资深开发者，可进一步定制分块策略、检索排序与降级策略，以满足更复杂的业务场景。

## 附录：扩展与自定义示例

### 扩展知识库（新增集合与摄入知识）
- 步骤
  - 创建集合：调用 POST /api/knowledge/collections，传入 name 与 vector_size
  - **集合命名规范**：生产环境建议使用 pulan_ 前缀（如 pulan_kb_001），以便被 RAG 自动检索
  - 摄入知识：调用 POST /api/knowledge/ingest，传入 collection 与 documents（text/source）
  - 验证检索：调用 GET /api/knowledge/search，输入问题验证 TopK 结果
- 注意事项
  - 集合名称会被规范化为小写+下划线
  - 长文本会自动分块，确保检索粒度合适
  - **通配符模式**：使用 pulan_* 配置可自动匹配所有 pulan_ 前缀集合

章节来源
- [server/api/routes_knowledge.py:105-186](file://server/api/routes_knowledge.py#L105-L186)
- [server/api/routes_knowledge.py:233-267](file://server/api/routes_knowledge.py#L233-L267)

### 自定义检索策略（调整 top_k 与过滤阈值）
- 调整 top_k
  - 通过环境变量或 config.json 的 rag.top_k 控制返回条数
- 调整过滤阈值
  - 修改 build_rag_context 中的 score 阈值（默认 0.3），以适应不同领域的相关性要求
- **角色-集合映射配置**
  - 通过 rag.role_collections 配置，支持多种语义：
    - `"*"`：匹配所有集合
    - `"pulan_*"`：匹配 pulan_ 前缀的所有集合
    - `"pulan_default"`：精确匹配单个集合
    - `["pulan_default", "pulan_kb_001"]`：精确匹配多个集合

章节来源
- [server/config.py:234-237](file://server/config.py#L234-L237)
- [server/rag/__init__.py:69-73](file://server/rag/__init__.py#L69-L73)
- [server/agent/agent_engine.py:137-156](file://server/agent/agent_engine.py#L137-L156)

### 嵌入客户端配置与模型选择
- 配置项
  - embedding.endpoint、embedding.api_key、embedding.model
- 模型选择
  - 默认 text-embedding-v3，维度 1024；可根据业务需求切换其他模型
- 参数调优
  - 调整批大小与超时策略，平衡吞吐与稳定性

章节来源
- [server/config.py:229-233](file://server/config.py#L229-L233)
- [server/services/embedding_client.py:29-40](file://server/services/embedding_client.py#L29-L40)

### 检索结果质量评估与排序算法
- 评分与排序
  - Qdrant 返回 score（余弦相似度），search_multi 合并后按 score 降序取 TopK
- 质量评估
  - 使用 /api/knowledge/search 验证相关性；结合业务反馈迭代知识内容与分块策略
- 降级策略
  - 当最高分数低于阈值或无结果时，跳过 RAG，走纯 LLM 回复

章节来源
- [server/services/qdrant_client.py:164-186](file://server/services/qdrant_client.py#L164-L186)
- [server/rag/__init__.py:69-73](file://server/rag/__init__.py#L69-L73)
- [doc/Qdrant知识库操作指南.md:153-171](file://doc/Qdrant知识库操作指南.md#L153-L171)

### 集合模式解析器使用示例
- **基本用法**
  ```python
  from server.rag.collections_resolver import resolve_search_collections
  
  # 解析 "*" 模式
  collections = await resolve_search_collections(qdrant, "*")
  
  # 解析 "pulan_*" 模式
  collections = await resolve_search_collections(qdrant, "pulan_*")
  
  # 解析精确集合名
  collections = await resolve_search_collections(qdrant, "pulan_default")
  
  # 解析集合列表
  collections = await resolve_search_collections(qdrant, ["pulan_default", "pulan_kb_001"])
  ```
- **配置示例**
  ```json
  {
    "rag": {
      "role_collections": {
        "普兰": "pulan_*",
        "客服": "customer_*",
        "技术支持": ["tech_support", "tech_help"]
      }
    }
  }
  ```
- **环境变量配置**
  ```bash
  export ROLE_COLLECTIONS='{"普兰": "pulan_*"}'
  ```

章节来源
- [server/rag/collections_resolver.py:24-79](file://server/rag/collections_resolver.py#L24-L79)
- [server/config.py:72-73](file://server/config.py#L72-L73)
- [server/config.py:133-134](file://server/config.py#L133-L134)
- [tests/test_collection_normalize.py:345-380](file://tests/test_collection_normalize.py#L345-L380)