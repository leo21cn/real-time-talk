---
kind: error_handling
name: 错误处理体系：领域异常 + FastAPI HTTPException + WebSocket 事件化错误
category: error_handling
scope:
    - '**'
source_files:
    - server/services/llm_client.py
    - server/services/minio_client.py
    - server/api/ws_handler.py
    - server/api/routes_knowledge.py
    - server/api/routes_clips.py
---

## 1. 整体方案概述
本仓库采用「分层异常 + 协议内错误消息」的混合模式：
- 外部 REST API 通过 FastAPI 的 `HTTPException` 返回标准 HTTP 错误码与 detail。
- 内部服务层（LLM、MinIO 等）定义领域异常类，向上抛出，由调用方统一捕获并转换为对外响应或日志。
- WebSocket 实时通道不依赖 HTTP 状态码，而是通过 JSON 事件 `{type: "error", message: ...}` 将错误推送给前端。
- 无全局中间件统一捕获；各路由/处理器在自身 try/except 中记录日志并转换错误。未使用 panic/recover（Python 无此概念），也未发现自定义全局异常处理器。