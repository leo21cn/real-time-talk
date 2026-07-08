# RealTimeTalk 技术设计文档

> **版本**: 2.0  
> **日期**: 2026-06-29  
> **状态**: 初稿  
> **对应需求**: [req-spec.md](./req-spec.md)

---

## 1. 技术概述

### 1.1 技术目标

构建一个 **Web 应用**，以 `speaker-short-hair-teacher-girl` 卡通形象为载体，用户通过浏览器与形象进行文字对话，形象以**语音+动画视频+打字机气泡**三种形式同步输出回复内容。服务端运行 Agent（对话 LLM）+ StreamingPipeline（分段/ TTS / 语义分析 / 视频拼接 / WebSocket 推送），多个浏览器 Session 之间对话完全隔离。通过 `docker compose up` 一键启动 Redis + MinIO + FastAPI + Nginx 全栈服务。

### 1.2 核心技术决策汇总

| 决策项 | 选型 |
|--------|------|
| 前端框架 | React + Vite |
| 透明视频渲染 | HTML `<video>` + WebM VP9 Alpha（stream copy 拼接，无运行时重编码） |
| 页面背景色 | 纯白 `#FFFFFF` |
| 通信协议 | WebSocket（全双工实时推送） |
| 后端运行时 | Python 3.10+ / FastAPI |
| Agent 架构 | Agent（纯对话 LLM）+ StreamingPipeline（服务端分段 + 并行生成 + 确认式推送） |
| 播放控制 | 服务端确认式控制（前端播放完毕发送 ack → 服务端推送下一段或 play_analysis） |
| 会话隔离 | Session Token（sessionStorage 存储）+ 服务端独立会话上下文 |
| 断线重连 | 自动重连恢复同一会话（同一 Session Token） |
| 状态存储 | Redis（对话历史）+ MinIO（生成视频/音频文件） |
| 切片来源 | 预转换脚本将技能 .mkv 切片转码为 WebM VP9 Alpha |
| 部署 | Docker Compose（FastAPI + Redis + MinIO + Nginx + FFmpeg） |
| 配置 | `config.json` + 环境变量覆盖（`.env`） |
| 启动方式 | 命令行 `docker compose up`，手动打开浏览器访问 |

---

## 2. 系统架构

### 2.1 架构总览

```
┌──────────────────────────────────────────────────────┐
│                    浏览器 (Browser)                    │
│  ┌────────────────────────────────────────────────┐  │
│  │              React SPA (Vite)                   │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────┐  │  │
│  │  │形象视频层 │  │  对话气泡层   │  │  输入框  │  │  │
│  │  │ <video>  │  │  (CSS动画)   │  │ (input)  │  │  │
│  │  │WebM VP9  │  │  打字机效果   │  │          │  │  │
│  │  │  Alpha   │  │              │  │          │  │  │
│  │  └────┬─────┘  └──────┬───────┘  └────┬─────┘  │  │
│  │       │               │               │        │  │
│  │  ┌────┴───────────────┴───────────────┴─────┐  │  │
│  │  │         WebSocket Client                 │  │  │
│  │  │  (send message / receive stream events)  │  │  │
│  │  └────────────────────┬─────────────────────┘  │  │
│  └───────────────────────┼────────────────────────┘  │
└──────────────────────────┼───────────────────────────┘
                           │  wss://
┌──────────────────────────┼───────────────────────────┐
│                    Docker Compose                      │
│                          │                            │
│  ┌───────────────────────┴─────────────────────────┐  │
│  │              Nginx (:80)                         │  │
│  │  ┌──────────────────────────────────────────┐   │  │
│  │  │  静态文件 serve (React dist/)             │   │  │
│  │  │  反向代理 /api/*, /ws → FastAPI           │   │  │
│  │  └──────────────────────────────────────────┘   │  │
│  └───────────────────────┬─────────────────────────┘  │
│                          │ proxy_pass                │
│  ┌───────────────────────┴─────────────────────────┐  │
│  │              FastAPI Server (:8000)              │  │
│  │                                                  │  │
│  │  ┌────────────────┐  ┌───────────────────────┐  │  │
│  │  │  Agent Engine   │  │  StreamingPipeline     │  │  │
│  │  │  (纯对话 LLM)   │  │  (分段→生成→确认推送)  │  │  │
│  │  └───────┬────────┘  └───────────┬───────────┘  │  │
│  │          │                       │               │  │
│  │  ┌───────┴───────────────────────┴───────────┐  │  │
│  │  │           Session Manager                 │  │  │
│  │  │  (会话创建/隔离/销毁，独立上下文)           │  │  │
│  │  └───────┬───────────────┬───────────────────┘  │  │
│  └──────────┼───────────────┼──────────────────────┘  │
│             │               │                          │
│  ┌──────────┴───┐  ┌───────┴──────────┐               │
│  │    Redis     │  │     MinIO        │               │
│  │  (:6379)     │  │  (:9000/:9001)   │               │
│  │  对话历史     │  │  视频/音频文件    │               │
│  │  Session状态  │  │  临时产物        │               │
│  └──────────────┘  └──────────────────┘               │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │              外部服务 API                        │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │   │
│  │  │ LLM API  │  │DashScope │  │   FFmpeg     │  │   │
│  │  │(OpenAI)  │  │TTS API   │  │(容器内进程)   │  │   │
│  │  └──────────┘  └──────────┘  └──────────────┘  │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

### 2.2 分层说明

| 层 | 职责 | 技术 |
|----|------|------|
| **前端 UI 层** | 形象视频播放、气泡打字机、输入交互、WebSocket 通信 | React + Vite |
| **WebSocket 层** | 全双工消息推送（用户输入→服务端，服务端→事件推送） | FastAPI WebSocket |
| **Agent 引擎层** | 纯文本对话生成、对话历史管理、智能摘要 | Python + LLM Chat API |
| **流式管道层** | 分段、TTS、语义分析、FFmpeg 拼接、播放推送 | Python asyncio + Task |
| **会话管理层** | Session Token 生成/校验、上下文隔离、资源生命周期 | Redis + Python |
| **存储层** | 对话历史持久化、视频/音频文件存储 | Redis + MinIO |
| **外部服务层** | HTTP API 调用、FFmpeg 本地进程 | httpx + subprocess |

---

## 3. 核心模块设计

### 3.1 会话隔离（Session Manager）

#### 3.1.1 会话生命周期

```
浏览器首次访问
  │
  ▼
GET /api/session/create
  → 服务端生成 UUID session_token
  → 返回 { session_token: "abc123..." }
  │
  ▼
前端存储到 sessionStorage.setItem("rt_session", token)
  │
  ▼
建立 WebSocket: ws://host:8000/ws?token=abc123...
  │
  ▼
服务端校验 token → 创建独立会话上下文:
  - ConversationManager 实例（独立对话历史）
  - StreamingPipeline 实例（独立生成任务）
  - _work/{session_id}/ 工作目录（MinIO bucket前缀）
  │
  ▼
用户发送消息 → WebSocket 携带 token
  │
  ▼
会话关闭（浏览器关闭 / 主动断开）
  → WebSocket 断开
  → 保留 Redis 对话历史（可配置 TTL）
  → 清理 MinIO 临时文件
```

#### 3.1.2 实现要点

- **Token 生成**：`uuid4()` 随机生成，服务端存储 `token → session_context` 映射
- **Token 传输**：前端存储在 `sessionStorage`（关闭标签页即清除），WebSocket 连接 URL 参数携带
- **上下文隔离**：每个 Session 拥有独立 `ConversationManager` 和 `StreamingPipeline` 实例，存放在服务端字典 `sessions: Dict[str, SessionContext]` 中
- **Redis 备份**：对话历史以 `session:{token}:history` 为 key 存入 Redis，TTL 默认 24 小时
- **资源清理**：WebSocket 断开后，异步清理该 Session 的 MinIO 临时文件和内存上下文

### 3.2 Agent 引擎

与上一版设计一致，Agent 仅负责**纯对话生成**，不使用 function calling。

```
用户输入 (通过 WebSocket)
  │
  ▼
┌─────────────────────────────────────────────┐
│  Step 1: 从 Redis 加载该 Session 的对话历史   │
│  Step 2: 组装 Messages                       │
│   [system_prompt, history..., user_input]    │
├─────────────────────────────────────────────┤
│  Step 3: 调用 LLM (stream = false)           │
│   返回: 纯文本回复                           │
├─────────────────────────────────────────────┤
│  Step 4: 保存本轮对话到 Redis                 │
│  Step 5: 将回复文本传递给 StreamingPipeline   │
└─────────────────────────────────────────────┘
```

### 3.3 StreamingPipeline（流式分段引擎）

```python
class StreamingPipeline:
    """接收完整回复文本，异步完成分段生成并通过 WebSocket 推送"""

    def __init__(self, session_id: str, ws: WebSocket, config: AppConfig):
        self.session_id = session_id
        self.ws = ws
        self.work_dir = f"_work/{session_id}"
        self.minio_prefix = f"sessions/{session_id}"
        self._cancel = asyncio.Event()
        self._ack_queue = asyncio.Queue()  # 接收前端播放确认

    async def run(self, full_reply_text: str) -> None:
        # 1. 分句切段
        segments = self._split_into_segments(full_reply_text, threshold=50)

        # 2. 并行生成所有段 (TTS + 语义分析 + FFmpeg + MinIO)
        tasks = [self._generate_segment(seg) for seg in segments]
        generated = await asyncio.gather(*tasks, return_exceptions=True)

        # 3. 推送首段
        await self._push_segment(0, generated[0])

        # 4. 逐段确认式推送后续
        for i in range(1, len(generated)):
            if self._cancel.is_set():
                break

            # 等待前端播放完毕确认 (ack_played)
            ack = await self._wait_for_ack(timeout=None)
            if ack == "cancel" or self._cancel.is_set():
                break

            result = generated[i]
            if isinstance(result, Exception):
                await self._push_error(str(result))
                break

            await self._push_segment(i, result)

        # 全部完成
        if not self._cancel.is_set():
            await self._push_event({"type": "all_completed"})
            await self._push_event({"type": "return_to_idle"})

    async def _push_segment(self, index: int, result: SegmentResult) -> None:
        if isinstance(result, Exception):
            await self._push_error(str(result))
            return
        await self._push_event({
            "type": "segment_ready",
            "index": index,
            "video_url": await self._get_presigned_url(result.video_path),
            "duration_ms": result.duration_ms,
            "text": result.text
        })
        # 打字机气泡逐字推送
        await self._push_typing_bubble(result.text, result.duration_ms)

    async def _wait_for_ack(self, timeout: int = None) -> str:
        """等待前端 ack_played，超时时返回 play_analysis 令前端播衔接动画"""
        try:
            ack = await asyncio.wait_for(self._ack_queue.get(), timeout=timeout)
            return ack
        except asyncio.TimeoutError:
            # 下一段尚未就绪 → 让前端播 analysis 循环
            await self._push_event({"type": "play_analysis", "loop": True})
            # 继续等待
            return await self._ack_queue.get()

    def cancel(self):
        self._cancel.set()
```

**说明**：所有段在开始时**并行生成**，但**逐段确认式推送**。前端每播完一段发送 `ack_played`，服务端收到后推送下一段；如下一段尚未生成完毕，推送 `play_analysis` 事件令前端循环播放分析动画。

#### 3.3.1 分段策略

1. 以中文标点 `。！？；` 为分割点将全文拆分为句子
2. 累加句子直到字符数 ≥ 50（阈值），形成一个片段
3. 最后不足 50 字的尾部单独成段
4. 保证每段以完整句子结尾

> **≤ 50 字符的短回复**：不触发多段并行，仅生成 1 个片段，同样经过 TTS → 语义分析 → FFmpeg 拼接 → MinIO 上传 → 推送的完整流程，不跳过任何环节。

#### 3.3.2 单段生成流程

```python
async def _generate_segment(self, seg: Segment) -> SegmentResult:
    # 1. TTS 语音合成 (DashScope API)
    audio_path, duration_ms = await self.tts.synthesize(seg.text)

    # 2. 语义分析 (LLM)
    labels = await self.semantic.analyze(seg.text)

    # 3. FFmpeg 切片拼接
    video_path = await self.concat.concat(labels, audio_path, duration_ms)

    # 4. 上传到 MinIO
    minio_key = f"{self.minio_prefix}/segment_{seg.index}.webm"
    await self.minio.upload(video_path, minio_key)

    return SegmentResult(
        index=seg.index,
        text=seg.text,
        video_path=minio_key,
        duration_ms=duration_ms,
        labels=labels
    )
```

### 3.4 WebSocket 通信协议

#### 3.4.1 连接建立

```
客户端 → 服务端: ws://host:8000/ws?token={session_token}
服务端 → 客户端: { "type": "connected", "session_token": "..." }
```

#### 3.4.2 消息格式

**客户端 → 服务端（用户输入）**：
```json
{
  "type": "user_message",
  "text": "请解释一下什么是机器学习"
}
```

**服务端 → 客户端（事件推送）**：

| 事件类型 | 说明 | 携带数据 |
|----------|------|----------|
| `state_change` | 状态变更（服务端确认，前端用于同步） | `state`: "thinking" / "speaking" / "bridging" / "idle" |
| `segment_ready` | 某段视频生成完毕 | `index`, `video_url`, `duration_ms`, `text` |
| `bubble_char` | 打字机逐字推送 | `char`, `segment_index` |
| `bubble_dismiss` | 气泡消失 | `segment_index` |
| `play_analysis` | 服务端令前端播放 analysis 衔接 | `loop`: true/false |
| `all_completed` | 全部段落播放完毕 | — |
| `return_to_idle` | 回到待机状态 | — |
| `error` | 错误提示 | `message`: 错误气泡文本 |

> **Thinking 事件说明**：服务端收到 `user_message` 后立即推送 `state_change: "thinking"` 用于状态同步。前端在此事件到达前已自行播放 analysis（零延迟），收到后忽略即可——该事件主要用于日志/调试和状态一致性确认。

**客户端 → 服务端（播放确认）**：
```json
{
  "type": "ack_played",
  "segment_index": 0
}
```

**客户端 → 服务端（中断）**：
```json
{
  "type": "cancel"
}
```

#### 3.4.3 中断处理

```
客户端 → 服务端: { "type": "cancel" }
  → 服务端调用 StreamingPipeline.cancel()
  → 取消正在进行的 TTS/语义分析/FFmpeg 任务
  → 清理该 Session 的临时文件
  → 推送 { "type": "state_change", "state": "idle" }
  → 前端回到待机状态，弹出输入框
```

#### 3.4.4 断线重连

- 前端 WebSocket 断开后自动重连（exponential backoff: 1s → 2s → 4s → 8s，最大 30s）
- 重连使用同一 Session Token（取自 `sessionStorage`）
- 服务端识别已有 Session，恢复上下文
- 如在重连期间在进行的回复中断，前端发送 `cancel` 后重新开始
- 如 Session Token 已过期（Redis TTL 到期），前端重新调用 `/api/session/create`

### 3.5 前端模块

#### 3.5.1 组件树

```
App
├── AvatarView              # 形象视频 + 待机动画
│   ├── <video>             # 当前播放的视频片段（WebM VP9 Alpha）
│   └── <video> (待机)      # 待机呼吸动画（idle_breathing.webm）
│
├── SpeechBubble            # 对话气泡
│   └── <div> 打字机动画    # CSS @keyframes typing
│
├── InputBox                # 文字输入框
│   ├── <input>             # 单行输入
│   └── <button>            # 发送按钮
│
├── ErrorBubble             # 错误提示气泡
│
└── useWebSocket            # WebSocket 连接管理 Hook
    ├── connect(token)
    ├── sendMessage(text)
    ├── cancel()
    └── onEvent(callback)
```

#### 3.5.2 状态机（前端）

```
        启动 ──→ Idle（待机动画 loop）
                     │
                用户点击形象
                     │
                  Input（输入框显示）
                     │
                用户回车发送
                     │
       前端立即切换到 analysis 循环
                     │
              segment_ready 事件（首段）
                     │
                Speaking（播放视频 + 打字机气泡）
                     │
              video ended → 发送 ack_played
                     │
              服务端推送下段或 play_analysis
                     ├── segment_ready ──→ Speaking（播下一段）
                     └── play_analysis ──→ Bridging（analysis loop → 等待下段）

        段全部播完 ──→ Idle

        用户点击(Thinking/Speaking/Bridging) → 发送 cancel → Idle
```

**说明**：用户回车发送后，前端**不等服务端确认**立即播放 analysis 循环动画，确保"思考中"反馈零延迟。收到首段 `segment_ready` 后，**等待当前 analysis 循环自然结束**（不在半帧处打断），然后切换到首段视频播放，避免突兀的硬切换。

#### 3.5.3 气泡 UI 参数

| 参数 | 值 |
|------|-----|
| 字号 | 16px |
| 背景 | `rgba(255, 255, 255, 0.85)` 半透明白色 |
| 圆角 | 12px |
| 阴影 | `0 4px 16px rgba(0, 0, 0, 0.12)` |
| 显示方式 | 打字机逐字出现 |
| 消失方式 | 播放完后延迟 2s，再 0.5s fade-out 淡出 |

- 切片视频格式：**WebM VP9 Alpha**（`-c:v libvpx-vp9 -pix_fmt yuva420p`）
- 编码方式：预转换阶段使用 CPU 软件编码（libvpx-vp9），运行时无需重编码
- **循环平滑性约束**：所有视频切片**首帧与尾帧必须画面完全一致**，确保循环播放时无缝衔接（无跳变、无闪烁）。此要求适用于：
  - 待机动画 idle_breathing.webm
  - analysis 思考动画
  - 所有 11 种语义切片
- 前端使用 `<video>` 标签直接播放，CSS 设置背景透明
- 页面背景为 `#FFFFFF`，形象视频通过 alpha 通道叠加
- 视频切换：监听 `ended` 事件，切换 `<video>` 的 `src` 属性

### 3.6 输入校验

- 空消息：前端拦截，不允许发送（WebSocket 不发送 user_message）
- 超长输入（> 2000 字）：前端截断至前 2000 字后发送
- 特殊字符：不拦截，作为普通文本透传给 LLM

### 3.7 TTS 模块

```python
class TtsEngine:
    def __init__(self, config: TtsConfig):
        self.api_key = config.api_key or os.environ.get("DASHSCOPE_API_KEY")
        self.voice = config.voice  # "Cherry"
        self.speed = config.speed  # 1.0

    async def synthesize(self, text: str) -> tuple[str, int]:
        """返回 (mp3_file_path, duration_ms)"""
        # 调用 DashScope TTS API，返回 MP3 格式音频
        # 响应写入 _work/{session_id}/segment_{n}.mp3
        # 返回文件路径和时长
```

### 3.8 语义分析模块

```python
class SemanticAnalyzer:
    def __init__(self, llm_client: LlmClient):
        self.llm = llm_client

    async def analyze(self, text: str) -> list[str]:
        """返回标签序列，如 ["introduction", "explaining", "emphasis"]"""
        prompt = f"""分析以下文本的语义结构，输出对应的标签序列（仅标签名，逗号分隔）。
可选标签：greeting, introduction, explaining, listing, emphasis,
         example, analysis, comparison, transition, conclusion, thanks
文本：{text}"""
        response = await self.llm.chat(prompt)
        return self._parse_labels(response)
```

### 3.9 视频拼接模块

```python
class VideoClipConcat:
    def __init__(self, clips_dir: str, ffmpeg_path: str = "ffmpeg"):
        self.clips_dir = Path(clips_dir)
        self.clips_toml = self._load_clips_toml()  # 加载过渡规则

    async def concat(
        self, labels: list[str], audio_path: str, target_duration_ms: int
    ) -> str:
        """返回 output_video_path (.webm)"""
        # 1. 根据 labels 选择切片文件: {clips_dir}/.webm/{label}.webm
        # 2. 按 clips.toml 过渡规则过滤/重排标签序列
        # 3. 时长对齐：仅通过循环播放末尾切片（looping）填充时长差，不做变速
        # 4. FFmpeg concat demuxer（stream copy）：
        #    - 视频流：-c:v copy（流拷贝，无重编码）
        #    - 音频流：混入 TTS MP3 → 编码为 libopus
        #    ffmpeg -f concat -i filelist.txt -i audio.mp3
        #           -c:v copy -c:a libopus output.webm
```

**说明**：运行时拼接采用 stream copy（流拷贝），视频不经过重编码，大幅降低延迟。切片已在预转换阶段（`convert_clips.py`）转码为统一的 WebM VP9 Alpha 格式。时长对齐仅通过末尾切片循环填充，不使用变速滤镜。

### 3.11 ASR 语音识别模块（v2.1）

客户端语音输入 → 文字，服务端调用 DashScope `qwen3-asr-flash` 转写。

#### 3.11.1 交互数据流

```
[浏览器]                              [FastAPI Server]                   [DashScope]
   │                                        │                                │
   │ 1. mousedown → getUserMedia + MediaRecorder.start                       │
   │ 2. AnalyserNode → 实时音量 + 倒计时                                     │
   │ 3. mouseup → recorder.stop() → Blob(base64)                             │
   │ 4. POST /api/asr/transcribe ─────────────────> │ 5. POST chat/completions ──────>│
   │    {audio: "...", format: "webm"}          │    model: qwen3-asr-flash         │
   │                                              │    input_audio.data = base64     │
   │                                              │                                │
   │                                              │<── {content: "转写结果"}  ─────│
   │<─ 6. {text: "..."}  ────────────────────   │                                │
   │ 7. 填入 ChatPanel textarea（不自动发送）     │                                │
```

#### 3.11.2 REST 接口

```
POST /api/asr/transcribe
Request:  { "audio": "<base64>", "format": "webm|mp4|wav|ogg", "language": "zh" }
Response: { "text": "转写结果", "duration_ms": 1234 }

错误码：
  400 - audio 为空 / 格式不支持 / API Key 未配置
  502 - DashScope 调用失败 / 鉴权失败
  504 - 调用超时
```

#### 3.11.3 实现要点

- 服务端懒加载 `AsrEngine`（复用 `httpx.AsyncClient`）
- API Key 复用 `DASHSCOPE_API_KEY`（与 TTS/LLM 同号）
- 重试 1 次（限流 / 服务端错误 / 超时）
- 客户端使用浏览器原生 `MediaRecorder`，无额外依赖
- 音频传输：客户端 base64 → HTTP 请求体（60s 上限下可控）
- 取消仅支持 ESC 键（不提供上滑取消手势）

### 3.10 配置模块

#### 3.10.1 配置加载优先级

```
环境变量 > config.json
```

#### 3.10.2 配置结构

```json
{
  "llm": {
    "endpoint": "https://api.example.com/v1",
    "api_key": "",
    "model": "gpt-4o",
    "max_tokens": 2048
  },
  "tts": {
    "api_key": "",
    "voice": "Cherry",
    "speed": 1.0
  },
  "avatar": {
    "speaker": "short-hair-teacher-girl",
    "clips_dir": "clips/short-hair-teacher-girl",
    "idle_animation": "clips/short-hair-teacher-girl/idle/idle_breathing.webm"
  },
  "system_prompt": "你是一个名叫普兰的知识助手...",
  "redis": {
    "url": "redis://redis:6379/0",
    "session_ttl_hours": 24
  },
  "minio": {
    "endpoint": "minio:9000",
    "access_key": "minioadmin",
    "secret_key": "minioadmin",
    "bucket": "realtimetalk",
    "presigned_url_ttl_seconds": 600
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8000
  },
  "ffmpeg": {
    "path": "ffmpeg",
    "gpu_encoder": "auto"
  }
}
```

> **system_prompt 优先级**：config.json 中的 `system_prompt` 字段 > `server/resources/default_system_prompt.txt`（出厂默认值，仅在 config.json 未配置时使用）。

| 配置项 | 说明 | 环境变量覆盖 |
|--------|------|-------------|
| `llm.api_key` | LLM API Key | `LLM_API_KEY` |
| `tts.api_key` | DashScope API Key | `DASHSCOPE_API_KEY` |
| `redis.url` | Redis 连接地址 | `REDIS_URL` |
| `minio.access_key` | MinIO Access Key | `MINIO_ACCESS_KEY` |
| `minio.secret_key` | MinIO Secret Key | `MINIO_SECRET_KEY` |
| `ffmpeg.gpu_encoder` | GPU 编码器选择 | `"auto"` 自动检测（Intel QSV / NVIDIA NVENC），不可用时回退 CPU；设为 `null` 强制 CPU |

> **Redis 持久化**：使用默认 RDB 快照持久化（`save 900 1 300 10 60 10000`），服务重启后可恢复最近对话历史。

> **MinIO Bucket**：服务启动时自动检测并创建配置的 bucket（默认 `realtimetalk`），无需手动操作。

---

### 4.1 单次对话完整数据流

```
浏览器                          服务端
  │                               │
  ├─ WebSocket ── user_message ──→│
  │                               ├─ 加载 Redis 对话历史
  │                               ├─ LLM 生成回复文本
  │                               ├─ 保存对话历史到 Redis
  │                               ├─ 推送 state_change: "thinking"
  │←──────── state_change ────────┤
  │  (前端播 analysis loop)       │
  │                               ├─ 分句切段
  │                               ├─ 并行生成段1/段2/段3
  │                               │   (TTS → 语义分析 → FFmpeg → MinIO)
  │                               │
  │←──── segment_ready(段1) ──────┤ 段1就绪
  │  (前端播段1视频+打字机气泡)    │
  │                               │
  │←──── segment_ready(段2) ──────┤ 段2就绪
  │                               │
  │  段1播完, 段2就绪              │
  │  (前端直接切换播段2)           │
  │                               │
  │←──── segment_ready(段3) ──────┤ 段3就绪（但段2还在播）
  │                               │
  │  段2播完, 段3就绪              │
  │  (前端切换播段3)               │
  │                               │
  │←──── all_completed ───────────┤
  │←──── return_to_idle ──────────┤
  │  (前端回到待机动画)            │
```

### 4.2 分段生成并行模型（服务端）

```
asyncio.gather() 并行启动:

段1: [==TTS==][=语义=][====FFmpeg拼接====] → MinIO上传 → 推送 segment_ready
段2: [==TTS==][=语义=][===FFmpeg拼接===]   → MinIO上传 → 推送 segment_ready
段3: [==TTS==][=语义=][==FFmpeg拼接==]     → MinIO上传 → 推送 segment_ready

主协程: 推送 thinking → 等待段1就绪 → 推送段1 → ...
```

---

## 5. 接口定义

### 5.1 REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/session/create` | 创建新会话，返回 `session_token` |
| `GET` | `/api/session/{token}/history` | 获取会话对话历史 |
| `DELETE` | `/api/session/{token}` | 销毁会话，清理资源 |
| `GET` | `/api/clips/{name}` | 获取切片文件（analysis.webm 等，前端播放所需） |
| `GET` | `/api/media/{session_token}/{filename}` | 获取生成的视频/音频文件（MinIO presigned URL 代理） |

### 5.2 WebSocket

| 端点 | 说明 |
|------|------|
| `ws://host:8000/ws?token={session_token}` | 实时通信 |

### 5.3 MinIO Presigned URL

| 端点 | 说明 |
|------|------|
| `GET /api/media/{session_token}/{filename}` | 获取视频/音频文件（带签名的临时 URL） |

---

## 6. 工程结构

### 6.1 目录结构

```
real-time-talk/
├── docker-compose.yml                  # 服务编排
├── Dockerfile                          # FastAPI 服务镜像
├── nginx.conf                          # Nginx 反向代理配置
├── config.json                         # 默认配置
├── .env.example                        # 环境变量模板
├── convert_clips.py                    # 预转换脚本：.mkv → .webm (VP9 Alpha)
│
├── server/                             # Python 服务端
│   ├── requirements.txt
│   ├── main.py                         # FastAPI 入口
│   ├── config.py                       # 配置加载
│   │
│   ├── agent/                          # Agent 引擎
│   │   ├── agent_engine.py             # 对话引擎
│   │   └── conversation_manager.py     # 对话历史 + Redis 持久化
│   │
│   ├── pipeline/                       # 流式分段引擎
│   │   ├── streaming_pipeline.py       # 分段→生成→确认推送编排
│   │   ├── segment_splitter.py         # 文本切段
│   │   └── segment_generator.py        # 单段生成
│   │
│   ├── services/                       # 服务模块
│   │   ├── tts_engine.py               # DashScope TTS
│   │   ├── semantic_analyzer.py        # LLM 语义分析（共用对话 LLM 配置）
│   │   ├── video_concat.py             # FFmpeg 切片拼接（读 .webm）
│   │   ├── llm_client.py               # OpenAI 兼容 API 客户端
│   │   ├── redis_client.py             # Redis 操作封装
│   │   └── minio_client.py             # MinIO 操作封装
│   │
│   ├── api/                            # 接口层
│   │   ├── routes_session.py           # Session REST API
│   │   ├── routes_media.py             # 媒体文件代理（MinIO presigned URL）
│   │   ├── routes_clips.py             # 切片文件代理
│   │   └── ws_handler.py               # WebSocket 处理
│   │
│   ├── models/                         # 数据模型
│   │   ├── message.py                  # 对话消息
│   │   ├── semantic_label.py           # 语义标签枚举
│   │   └── session.py                  # Session 状态
│   │
│   └── resources/
│       └── default_system_prompt.txt   # 出厂默认角色人设（被 config.json 覆盖）
│
├── client/                             # React 前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   │
│   ├── src/
│   │   ├── main.tsx                    # 入口
│   │   ├── App.tsx                     # 根组件 + 状态机
│   │   │
│   │   ├── components/
│   │   │   ├── AvatarView.tsx          # 形象视频播放
│   │   │   ├── SpeechBubble.tsx        # 打字机气泡
│   │   │   ├── InputBox.tsx            # 输入框
│   │   │   └── ErrorBubble.tsx         # 错误气泡
│   │   │
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts         # WebSocket 连接管理（含自动重连）
│   │   │   └── useTypewriter.ts        # 打字机动画 Hook
│   │   │
│   │   ├── services/
│   │   │   └── api.ts                  # REST API 调用
│   │   │
│   │   └── types/
│   │       └── events.ts               # WebSocket 事件类型定义
│   │
│   └── public/                         # 无静态资源（idle 等均通过 API 代理获取）
│
├── clips/                              # 语义切片库
│   └── short-hair-teacher-girl/
│       ├── clips.toml                  # 切片描述 + 过渡规则（file 字段引用 .webm）
│       ├── greeting.mkv                # 原始切片（通过 convert_clips.py 转 .webm）
│       ├── introduction.mkv
│       ├── explaining.mkv
│       ├── listing.mkv
│       ├── emphasis.mkv
│       ├── example.mkv
│       ├── analysis.mkv
│       ├── comparison.mkv
│       ├── transition.mkv
│       ├── conclusion.mkv
│       ├── thanks.mkv
│       ├── .webm/                      # 转换产物目录（运行时读取，.gitignore）
│       │   ├── greeting.webm
│       │   ├── ...
│       │   └── thanks.webm
│       └── idle/
│           └── idle_breathing.webm     # HappyHorse API 生成
│
└── doc/
    ├── req-raw.md
    ├── req-spec.md
    └── tech-spec.md
```

### 6.2 Python 依赖

| 包名 | 用途 |
|------|------|
| `fastapi` | Web 框架 |
| `uvicorn[standard]` | ASGI 服务器 |
| `websockets` | WebSocket 支持 |
| `httpx` | 异步 HTTP 客户端（LLM/TTS API） |
| `redis[hiredis]` | Redis 客户端 |
| `minio` | MinIO 客户端 |
| `pydantic` | 数据校验 |
| `pydantic-settings` | 配置管理（环境变量加载） |
| `python-dotenv` | .env 文件加载 |
| `aiofiles` | 异步文件操作 |

### 6.3 前端依赖

| 包名 | 用途 |
|------|------|
| `react` / `react-dom` | UI 框架 |
| `vite` | 构建工具 |
| `typescript` | 类型安全 |

---

## 7. Docker Compose

### 7.1 服务编排

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  minio:
    image: minio/minio:latest
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data

  server:
    build: .
    ports:
      - "8000:8000"
    environment:
      REDIS_URL: redis://redis:6379/0
      MINIO_ENDPOINT: minio:9000
    env_file:
      - .env
    volumes:
      - ./config.json:/app/config.json
      - ./clips:/app/clips
    depends_on:
      - redis
      - minio

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./client/dist:/usr/share/nginx/html:ro
    depends_on:
      - server

volumes:
  redis_data:
  minio_data:
```

### 7.2 Nginx 配置

```nginx
# nginx.conf
events { worker_connections 1024; }

http {
    include /etc/nginx/mime.types;

    server {
        listen 80;

        # 前端静态文件
        location / {
            root /usr/share/nginx/html;
            try_files $uri /index.html;
        }

        # API 反向代理到 FastAPI
        location /api/ {
            proxy_pass http://server:8000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        # WebSocket 代理
        location /ws {
            proxy_pass http://server:8000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 86400s;
        }
    }
}
```

> **开发环境**：同样使用 Nginx（`docker compose up` 即包含 Nginx），Vite dev server 构建产物通过 volume 挂载到 Nginx 容器，始终同源访问，无需 CORS 配置。

### 7.3 Dockerfile

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ .
COPY clips/ ./clips/

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## 8. 错误处理

| 模块 | 错误场景 | 处理策略 |
|------|----------|----------|
| LLM Client | 网络超时/500错误 | 重试1次 → WebSocket 推送 error 事件 → 前端气泡提示 |
| LLM Client | 401/403 鉴权失败 | WebSocket 推送 error → 前端气泡提示 "API Key 无效" |
| TTS Engine | API 调用失败 | 重试1次 → 推送 error → 回退到纯文字气泡 |
| FFmpeg | 不可用/执行失败 | 推送 error "视频组件异常" |
| Redis | 连接失败 | 服务启动时检查，不可用则拒绝启动 |
| MinIO | 上传失败 | 回退到本地文件存储 + 本地 URL |
| WebSocket | 连接断开 | 前端自动重连（exponential backoff 1s→2s→4s→8s，最大 30s），恢复同一 Session；进行中的回复中断" |

---

## 9. 预转换脚本（convert_clips.py）

在首次 `docker compose up` 之前，需要运行一次预转换脚本，将原始 `.mkv` 切片转码为 WebM VP9 Alpha：

```python
# convert_clips.py
"""将 clips/ 目录下的 .mkv 切片转码为 WebM VP9 Alpha (.webm)"""
import subprocess
from pathlib import Path

CLIPS_ROOT = Path("clips/short-hair-teacher-girl")
WEBM_DIR = CLIPS_ROOT / ".webm"

def convert():
    WEBM_DIR.mkdir(exist_ok=True)
    for mkv_file in CLIPS_ROOT.glob("*.mkv"):
        output = WEBM_DIR / f"{mkv_file.stem}.webm"
        if output.exists():
            print(f"跳过已存在: {output.name}")
            continue
        print(f"转换: {mkv_file.name} → {output.name}")
        subprocess.run([
            "ffmpeg", "-i", str(mkv_file),
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
            "-crf", "30", "-b:v", "0", "-an",
            str(output)
        ], check=True)
    print("转换完成。")

if __name__ == "__main__":
    convert()
```

---

## 10. 待后续明确（TBD）

无。所有设计要素已闭环。
