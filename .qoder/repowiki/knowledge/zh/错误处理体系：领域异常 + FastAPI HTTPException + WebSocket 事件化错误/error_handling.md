## 1. 整体方案概述
本仓库采用「分层异常 + 协议内错误消息」的混合模式：
- 外部 REST API 通过 FastAPI 的 `HTTPException` 返回标准 HTTP 错误码与 detail。
- 内部服务层（LLM、MinIO 等）定义领域异常类，向上抛出，由调用方统一捕获并转换为对外响应或日志。
- WebSocket 实时通道不依赖 HTTP 状态码，而是通过 JSON 事件 `{type: "error", message: ...}` 将错误推送给前端。
- 无全局中间件统一捕获；各路由/处理器在自身 try/except 中记录日志并转换错误。未使用 panic/recover（Python 无此概念），也未发现自定义全局异常处理器。