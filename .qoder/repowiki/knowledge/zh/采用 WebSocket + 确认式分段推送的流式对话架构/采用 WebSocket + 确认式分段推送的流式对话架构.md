---
kind: design
name: 采用 WebSocket + 确认式分段推送的流式对话架构
source: session
category: adr
---

# 采用 WebSocket + 确认式分段推送的流式对话架构

_来源：deaa7e6 → c578ccd 提交周期内记录的编码计划——内容为规划时意图，实现可能滞后或有出入。_

**状态：** accepted

## 背景
RealTimeTalk 需要实现实时虚拟形象对话，要求首段低延迟、多段并行生成、视频与气泡同步播放，且支持用户随时中断。REST 轮询无法满足实时性，纯 SSE 无法处理双向交互（ack_played/cancel）。

## 决策驱动
- 首段低延迟（segment_ready 即推）
- 双向控制（ack_played 确认播放完成）
- 并发生成效率（asyncio.gather 并行）
- 可中断性（cancel 事件）

## 备选方案
- **REST 长轮询 + 文件下载** _（已否决）_ — 优点：实现简单，兼容性好；缺点：首段延迟高；无法实现打字机效果；无双向控制能力
- **SSE (Server-Sent Events)** _（已否决）_ — 优点：服务端单向推送，实现比 WS 简单；缺点：客户端无法主动发送 ack_played/cancel；无法实现确认式分段推进
- **WebSocket + 确认式分段推送** — 优点：全双工通信；segment_ready 即时推送；ack_played 精确控制节奏；cancel 支持中断；天然适合状态机驱动；缺点：需维护连接状态；断线重连逻辑复杂；Nginx 需配置 WebSocket 代理

## 决策
后端 FastAPI + websockets 提供 ws://host/ws?token={session_token} 端点，前端 useWebSocket Hook 管理连接；服务端按 segment_ready → play_analysis(loop) → all_completed 序列推送，客户端通过 ack_played 确认每段播放完成后再推下一段，形成背压控制。

## 影响
实现了首段 <1s 的端到端延迟和流畅的打字机体验；但引入了连接管理复杂度（指数退避重连、token 过期刷新）、Nginx 反向代理配置、以及 MinIO presigned URL 的临时文件清理责任。