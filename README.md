# RealTimeTalk · 实时对话 AI 助手

> 一个以卡通形象为载体的 **Web 端实时对话 AI 助手**。
> 形象以「**语音 + 动画视频 + 打字机气泡**」三种方式同步输出回复内容，
> 长回复自动**流式分段生成 + 确认式逐段播放**，并在多个浏览器标签页之间**完全隔离**。

[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://www.python.org/)
[![React](https://img.shields.io/badge/React-18-61dafb.svg)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688.svg)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/License-Internal-lightgrey.svg)](#license)

---

## ✨ 核心特性

| 模块 | 说明 |
|------|------|
| 🎭 **卡通形象对话** | 以 `speaker-short-hair-teacher-girl`（年轻短发干练女教师）为载体，WebM VP9 Alpha 透明视频与页面背景自然融合 |
| 🧠 **Agent 对话引擎** | 纯对话 LLM（OpenAI 兼容协议），支持 DashScope / OpenAI / 自部署模型；多轮上下文 + Token 溢出智能摘要 |
| 🎬 **流式分段生成** | 长回复按 `。！？；` 切段 → **TTS + 语义分析 + FFmpeg 拼接 + MinIO 上传** 全流程并行 |
| 💬 **打字机气泡** | 半透明毛玻璃气泡，16px 字号，逐字打字机效果与语音严格同步 |
| 🔄 **确认式逐段播放** | 客户端 `ack_played` 背压控制，段间 `analysis` 衔接动画无缝切换 |
| 🔐 **多会话隔离** | Session Token + 独立 `ConversationManager` / `StreamingPipeline` / 工作目录；关闭标签页即清除 |
| 📚 **RAG 知识库** | Qdrant 向量检索 + DashScope Embedding，支持角色化 collection 前缀路由（`普兰 → pulan_*`） |
| 🎙️ **语音输入 (ASR)** | 浏览器原生 `MediaRecorder` + DashScope `qwen3-asr-flash`，按住说话，文字填入输入框 |
| ⚡ **客户端预缓存** | L1 HTTP `Cache-Control: immutable` + L2 IndexedDB Blob 缓存，弱网下段间停顿 < 200ms |
| 🔁 **WebSocket 断线重连** | 指数退避（1s → 2s → 4s → 8s，最大 30s），自动恢复同一会话 |
| 🛠️ **知识库管理后台** | 独立 `/admin` 入口，集合管理 / 文档导入 / 检索测试 |
| 🐳 **一键 Docker 启动** | Compose 五件套：Qdrant + Redis + MinIO + Server + Nginx |

---

## 🏛️ 系统架构

```
┌──────────────────────────────────────────────────────┐
│                    浏览器 (Browser)                    │
│  ┌────────────────────────────────────────────────┐  │
│  │              React SPA (Vite)                   │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────┐  │  │
│  │  │ 形象视频 │  │  对话气泡层  │  │  输入框  │  │  │
│  │  │ <video>  │  │ (打字机CSS)  │  │  +录音   │  │  │
│  │  │ WebM VP9 │  │              │  │          │  │  │
│  │  │  Alpha   │  │              │  │          │  │  │
│  │  └────┬─────┘  └──────┬───────┘  └────┬─────┘  │  │
│  │       │               │               │        │  │
│  │  ┌────┴───────────────┴───────────────┴─────┐  │  │
│  │  │         WebSocket Client                 │  │  │
│  │  └────────────────────┬─────────────────────┘  │  │
│  └───────────────────────┼────────────────────────┘  │
└──────────────────────────┼───────────────────────────┘
                           │  wss://
┌──────────────────────────┼───────────────────────────┐
│                  Docker Compose                        │
│                          │                            │
│  ┌───────────────────────┴─────────────────────────┐  │
│  │              Nginx (:80) 反向代理                │  │
│  │  · 静态文件 serve (React dist/)                 │  │
│  │  · /api/*, /ws → FastAPI                        │  │
│  └───────────────────────┬─────────────────────────┘  │
│                          │ proxy_pass                │
│  ┌───────────────────────┴─────────────────────────┐  │
│  │              FastAPI Server (:8000)              │  │
│  │  ┌────────────────┐  ┌───────────────────────┐  │  │
│  │  │  Agent Engine   │  │  StreamingPipeline     │  │  │
│  │  │  (纯对话 LLM)   │  │  分段→生成→确认推送     │  │  │
│  │  └───────┬────────┘  └───────────┬───────────┘  │  │
│  │          │                       │               │  │
│  │  ┌───────┴───────────────────────┴───────────┐  │  │
│  │  │           Session Manager                 │  │  │
│  │  │  (会话创建/隔离/销毁，独立上下文)           │  │  │
│  │  └───────┬───────────────┬───────────────────┘  │  │
│  └──────────┼───────────────┼──────────────────────┘  │
│             │               │                          │
│  ┌──────────┴───┐  ┌───────┴──────────┐               │
│  │  Redis       │  │     MinIO        │               │
│  │  对话历史     │  │  视频/音频文件    │               │
│  │  Session状态  │  │  临时产物        │               │
│  └──────────────┘  └──────────────────┘               │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │  Qdrant  向量库  +  DashScope TTS / ASR / LLM  │   │
│  │  + FFmpeg (容器内进程)                          │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

---

## 📁 工程结构

```
real-time-talk/
├── docker-compose.yml                  # 本地五件套编排（Qdrant + Redis + MinIO + Server + Nginx）
├── docker-stack.yml                    # Swarm 生产编排
├── Dockerfile                          # FastAPI 服务镜像（python:3.11-slim + FFmpeg）
├── nginx.conf                          # 反向代理：/api、/ws → server:8000
├── nginx-pulan.conf                    # 生产 HTTPS 反代片段（pulan.smartmoves.com.cn）
├── config.json                         # 运行时业务配置（LLM / TTS / Avatar / RAG / MinIO …）
├── convert_clips.py                    # 预转换脚本：.mkv 切片 → WebM VP9 Alpha
│
├── server/                             # Python 服务端（FastAPI + asyncio）
│   ├── main.py                         # FastAPI 入口
│   ├── config.py                       # pydantic-settings 双源加载（env > config.json）
│   ├── agent/                          # 对话引擎
│   │   ├── agent_engine.py             #   · 纯对话 LLM 调用
│   │   └── conversation_manager.py     #   · 历史 + Redis 持久化 + 智能摘要
│   ├── pipeline/                       # 流式分段引擎
│   │   ├── streaming_pipeline.py       #   · 分段→生成→确认推送编排
│   │   ├── segment_splitter.py         #   · 中文标点切段
│   │   └── segment_generator.py        #   · 单段：TTS → 语义 → FFmpeg → MinIO
│   ├── services/                       # 服务模块
│   │   ├── llm_client.py               #   · OpenAI 兼容协议客户端
│   │   ├── tts_engine.py               #   · DashScope TTS（Cherry 音色）
│   │   ├── asr_engine.py               #   · DashScope ASR（qwen3-asr-flash）
│   │   ├── semantic_analyzer.py        #   · LLM 语义标签序列
│   │   ├── video_concat.py             #   · FFmpeg stream copy 拼接
│   │   ├── redis_client.py             #   · 会话状态 / 历史
│   │   ├── minio_client.py             #   · 视频 / 音频文件
│   │   ├── qdrant_client.py            #   · 向量检索
│   │   └── embedding_client.py         #   · DashScope text-embedding-v3
│   ├── api/                            # 接口层
│   │   ├── ws_handler.py               #   · WebSocket 会话编排
│   │   ├── routes_session.py           #   · POST /api/session/{create,delete,history}
│   │   ├── routes_clips.py             #   · /api/clips/{*,manifest} + immutable cache
│   │   ├── routes_media.py             #   · /api/media/{token}/{file}
│   │   ├── routes_knowledge.py         #   · 知识库 CRUD + 检索测试
│   │   ├── routes_asr.py               #   · POST /api/asr/transcribe
│   │   └── routes_diag.py              #   · 健康检查 / 调试
│   ├── models/                         # Pydantic 模型（message / session / semantic_label）
│   ├── rag/
│   │   └── collections_resolver.py     # 角色 → collection 前缀路由
│   └── resources/
│       └── default_system_prompt.txt   # 出厂默认角色人设
│
├── client/                             # React 前端（Vite + TS）
│   ├── index.html / admin.html         # 双入口：聊天页 + 管理后台
│   ├── vite.config.ts                  # 多入口构建
│   └── src/
│       ├── App.tsx                     # 根组件 + 状态机（Idle/Thinking/Speaking/Bridging）
│       ├── admin.tsx                   # 知识库管理后台入口
│       ├── components/                 # 纯 UI 组件
│       │   ├── AvatarView.tsx          #   · 形象视频播放（WebM VP9 Alpha）
│       │   ├── ChatPanel.tsx           #   · 对话面板（消息列表 + 输入框）
│       │   ├── ChatBubble.tsx          #   · 用户 / 助手气泡
│       │   ├── SpeechBubble.tsx        #   · 打字机气泡
│       │   ├── InputBox.tsx            #   · 文字输入
│       │   ├── VoiceInputButton.tsx    #   · 按住说话录音
│       │   ├── ErrorBubble.tsx         #   · 错误提示气泡
│       │   ├── KnowledgePanel.tsx      #   · 知识库检索来源展示
│       │   ├── CacheStatusPanel.tsx    #   · 切片缓存状态面板
│       │   └── AdminPage.tsx           #   · 知识库管理 UI
│       ├── hooks/
│       │   ├── useWebSocket.ts         #   · 连接管理 + 指数退避重连
│       │   ├── useTypewriter.ts        #   · 打字机效果
│       │   ├── useVoiceRecorder.ts     #   · MediaRecorder + 音量条 + 倒计时
│       │   └── useClipPreloader.ts     #   · 4 路并发预取
│       ├── services/
│       │   ├── api.ts                  #   · REST 客户端
│       │   ├── clipCache.ts            #   · IndexedDB Blob 缓存
│       │   └── avatarDiagnostics.ts    #   · 形象诊断 / 浏览器兼容探测
│       └── types/
│           ├── events.ts               #   · WebSocket 事件协议
│           └── chat.ts                 #   · 本地消息模型
│
├── clips/                              # 语义切片库（资源需通过 convert_clips.py 转码）
│   └── short-hair-teacher-girl/
│       ├── clips.toml                  # 切片描述 + 过渡规则
│       ├── greeting.mkv … thanks.mkv   # 11 个原始语义切片
│       ├── .webm/                      # 转码产物（WebM VP9 Alpha，git-ignored）
│       └── idle/idle_breathing.webm    # 待机呼吸动画（HappyHorse 预生成）
│
├── doc/                                # 设计与交付文档
│   ├── req-spec.md                     # 需求规格说明书
│   ├── tech-spec.md                    # 技术设计文档
│   ├── test-spec.md                    # 测试规范
│   ├── deploy-manual.md                # 生产环境发布指南
│   └── Qdrant知识库操作指南.md
│
└── .env.example                        # 环境变量模板
```

---

## 🚀 快速开始

### 1. 准备环境

- Docker 20+ / Docker Compose v2
- （生产环境）阿里云 ECS ARM64 / Docker Swarm 单节点
- 一个 OpenAI 兼容协议的 LLM 端点（默认示例为 DashScope）
- DashScope API Key（TTS + ASR + Embedding）

### 2. 准备切片资源

```bash
# 1. 将原始 .mkv 切片复制到 clips/short-hair-teacher-girl/
#    （来源：ppt-to-video-vertical 技能的切片库）

# 2. 转码为 WebM VP9 Alpha（一次性，运行时直接 stream copy 拼接）
python convert_clips.py

# 3. 将 idle_breathing.webm 放到 clips/short-hair-teacher-girl/idle/
#    （通过 HappyHorse API 从源图生成）
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填入：
#   LLM_API_KEY / LLM_ENDPOINT / LLM_MODEL
#   DASHSCOPE_API_KEY
```

### 4. 启动全栈

```bash
docker compose up -d
```

启动后浏览器访问：

| 入口 | 地址 | 说明 |
|------|------|------|
| 💬 聊天页面 | http://localhost/ | 卡通形象对话 |
| 🛠️ 管理后台 | http://localhost/admin.html | 知识库管理 |
| 📦 MinIO 控制台 | http://localhost:9001 | `minioadmin / minioadmin` |
| 🔍 Qdrant 控制台 | http://localhost:6333/dashboard | 向量库 |
| 📡 Redis | localhost:6379 | 会话状态 |

### 5. （可选）创建知识库

```bash
# 通过 API 创建默认 collection（向量维度 1024）
curl -X POST http://localhost/api/knowledge/collections \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: your-admin-token" \
  -d '{"name": "pulan_default", "vector_size": 1024}'
```

> 集合名建议以 `pulan_` 为前缀以匹配默认 `ROLE_COLLECTIONS={"普兰": "pulan_*"}` 路由规则。

---

## 🎬 切片与动画系统

### 语义标签对照表

| 标签 | 中文 | 典型触发语义 |
|------|------|--------------|
| `greeting` | 问候开场 | 你好、欢迎、嗨 |
| `introduction` | 引入主题 | 今天聊一聊、关于这个问题 |
| `explaining` | 解释说明 | 这个概念、意思是、指的是 |
| `listing` | 列举分点 | 第一、首先、其次、另外 |
| `emphasis` | 强调重点 | 关键、重要、必须、核心 |
| `example` | 举例说明 | 例如、比如、举个例子 |
| `analysis` | 深度分析 / 思考中 | 分析、原因、本质、深层 |
| `comparison` | 对比分析 | 对比、相比、差异、优劣 |
| `transition` | 过渡转换 | 接下来、下面、另外还有 |
| `conclusion` | 总结收尾 | 总结、综上、回顾 |
| `thanks` | 致谢结束 | 谢谢、感谢、欢迎交流 |

### 拼接策略

```
1. TTS 合成单段语音（DashScope Cherry）
2. LLM 输出标签序列（如 ["greeting", "explaining", "emphasis"]）
3. 根据 clips.toml 过渡规则过滤 / 重排
4. FFmpeg stream copy（流拷贝，无重编码）拼接切片
5. 末尾切片 loop 填充时长差（无变速滤镜）
6. 音频流混入 TTS MP3 → libopus 编码 → 输出 .webm
```

### 循环平滑性约束

> 所有循环播放的视频（待机、analysis、11 个语义切片）**首帧与尾帧必须画面完全一致**，
> 确保循环衔接**无跳变、无闪烁**。

---

## 🔌 通信协议

### WebSocket 端点

```
ws://host:8000/ws?token={session_token}
```

### 客户端 → 服务端

```jsonc
// 用户输入
{ "type": "user_message", "text": "请解释一下什么是机器学习" }

// 播放确认（每段视频 ended 触发）
{ "type": "ack_played", "segment_index": 0 }

// 中断
{ "type": "cancel" }
```

### 服务端 → 客户端

| 事件 | 说明 |
|------|------|
| `state_change` | 状态变更（`thinking` / `speaking` / `bridging` / `idle`） |
| `segment_ready` | 单段视频就绪（含 `video_url` / `duration_ms` / `text`） |
| `bubble_char` | 打字机逐字推送 |
| `bubble_dismiss` | 气泡消失 |
| `play_analysis` | 服务端令前端循环 analysis 衔接动画 |
| `all_completed` | 全部段落播放完毕 |
| `return_to_idle` | 回到待机状态 |
| `error` | 错误提示（含 message） |

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/session/create` | 创建新会话，返回 `session_token` |
| `GET` | `/api/session/{token}/history` | 获取会话对话历史 |
| `DELETE` | `/api/session/{token}` | 销毁会话 |
| `GET` | `/api/clips/manifest` | 获取预取清单（含 `?v=N` 版本号） |
| `GET` | `/api/clips/{name}` | 切片文件（`Cache-Control: immutable`） |
| `GET` | `/api/media/{session_token}/{filename}` | 生成视频 / 音频文件 |
| `POST` | `/api/asr/transcribe` | 音频转写（base64） |
| `POST/GET/DELETE` | `/api/knowledge/collections[/...]` | 知识库 CRUD（需 Admin Token） |
| `GET` | `/api/health` | 健康检查 |

---

## 🎙️ 语音输入（ASR）

| 项 | 说明 |
|----|------|
| 录音 API | 浏览器原生 `MediaRecorder`（`audio/webm;codecs=opus`，Safari fallback `audio/mp4`） |
| 转写模型 | DashScope `qwen3-asr-flash`（OpenAI 兼容模式） |
| 上限时长 | 60 秒（自动停止） |
| API Key | 复用 `DASHSCOPE_API_KEY` |
| 取消方式 | 仅支持 **ESC** 键（无上滑手势） |
| 转写后行为 | 文字**填入输入框**，不自动发送（用户可编辑） |

> ⚠️ `getUserMedia` 仅在 HTTPS / localhost 下可用。

---

## 🧠 RAG 知识库

### 工作流程

```
用户输入
   │
   ▼
┌─────────────────┐
│ EmbeddingClient │ ← DashScope text-embedding-v3
└────────┬────────┘
         │
         ▼
┌──────────────────────┐
│ CollectionsResolver  │ ← ROLE_COLLECTIONS 角色路由
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│ Qdrant 检索           │ ← top_k 默认 5
└────────┬─────────────┘
         │
         ▼
  注入 LLM context，生成回答（带 KnowledgePanel 引用展示）
```

### 角色化 Collection 路由

```jsonc
// .env
ROLE_COLLECTIONS={"普兰": "pulan_*"}
```

服务端会自动将 `pulan-default`、`pulan default` 规范化到 `pulan_default`，
新增集合时**必须以 `pulan_` 为前缀**才能被 RAG 自动检索到。

---

## ⚡ 性能优化

| 项 | 数值 | 说明 |
|----|------|------|
| 流式首段延迟 | < 5s（建议目标） | 段落并行生成 + 立即推送第一段 |
| L1 HTTP 缓存 | `Cache-Control: public, max-age=31536000, immutable` | 切片 URL 携带 `?v=N` 版本号 |
| L2 IndexedDB 缓存 | 命中后 `URL.createObjectURL` | 弱网下段间停顿 < 200ms |
| FFmpeg 拼接 | stream copy（无重编码） | 音频混入时仅 libopus 编码 |
| 多会话隔离 | sessionStorage + 服务端独立上下文 | 关闭标签页即清除 |
| WebSocket 重连 | 指数退避（1s → 2s → 4s → 8s ≤ 30s） | 自动恢复同一会话 |

---

## 🛠️ 故障排查

| 现象 | 可能原因 | 解决 |
|------|----------|------|
| 形象不显示 / 黑屏 | 浏览器不支持 WebM VP9 Alpha | 改用 Chrome / Edge / Firefox 最新版 |
| 段间停顿 1-3s | L2 缓存未命中 | 检查 IndexedDB 配额；微信浏览器可能受限 |
| TTS 无声音 | `DASHSCOPE_API_KEY` 无效 | 验证 `.env` 配置 |
| 502 Bad Gateway | Nginx 无法访问 `real-time-talk_server` | 检查 docker 网络 / 服务名 |
| ARM64 `exec format error` | 构建时未指定 `--platform linux/arm64` | 重新构建并指定平台 |
| RAG 检索为空 | collection 名不以 `pulan_` 开头 | 修改集合名或调整 `ROLE_COLLECTIONS` |

---

## 📦 部署

### 本地开发

```bash
docker compose up -d
```

### 生产环境（Docker Swarm）

完整发布流程见 [doc/deploy-manual.md](doc/deploy-manual.md)，关键步骤：

```powershell
# 1. 构建前端
cd client; npm install; npm run build; cd ..

# 2. 构建镜像（ECS 为 ARM64）
docker build --platform linux/arm64 -t real-time-talk-predeploy:latest .

# 3. 导出 → 上传 → 加载
docker save -o deploy\predeploy.tar real-time-talk-predeploy:latest
scp deploy\predeploy.tar root@<ECS_IP>:/root/
ssh root@<ECS_IP> "docker load -i /root/predeploy.tar"

# 4. 上传配置并部署 Stack
scp .env config.json root@<ECS_IP>:/root/real-time-talk/
scp deploy\config\docker-stack.yml root@<ECS_IP>:/root/real-time-talk-stack.yml
ssh root@<ECS_IP> "docker stack deploy -c /root/real-time-talk-stack.yml real-time-talk"
```

### 发布新切片

发布新切片后必须 bump `config.json` 中的 `avatar.clip_version`（同步服务端默认值），
客户端通过 `/api/clips/manifest` 自动获取新版本号，旧 IndexedDB 缓存因 `?v=N` 不匹配被丢弃重下。

---

## 📚 文档索引

| 文档 | 用途 |
|------|------|
| [doc/req-spec.md](doc/req-spec.md) | 需求规格说明书（v2.0） |
| [doc/tech-spec.md](doc/tech-spec.md) | 技术设计文档（v2.0） |
| [doc/test-spec.md](doc/test-spec.md) | 测试规范 |
| [doc/deploy-manual.md](doc/deploy-manual.md) | 生产环境发布指南 |
| [doc/Qdrant知识库操作指南.md](doc/Qdrant知识库操作指南.md) | Qdrant 知识库操作 |

---

## 🤝 角色映射

| 形象标识 | 切片库 | 角色名 | 默认音色 | Collection 前缀 |
|----------|--------|--------|----------|-----------------|
| `speaker-short-hair-teacher-girl` | `clips/short-hair-teacher-girl/` | 普兰 | Cherry | `pulan_*` |

---

## 📝 License

Internal / 内部项目
