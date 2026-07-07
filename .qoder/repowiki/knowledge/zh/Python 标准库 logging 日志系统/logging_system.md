## 1. 使用的系统与框架
- 采用 Python 标准库 `logging`，未引入第三方日志框架（如 loguru、structlog）。
- 通过 FastAPI 入口 `server/main.py` 中的 `logging.basicConfig()` 完成全局根记录器配置。

## 2. 核心文件与位置
- 日志初始化：`server/main.py`（第 28–32 行）
- 各模块日志使用：`server/agent/*`、`server/api/*`、`server/pipeline/*`、`server/services/*` 等子包中均按统一模式获取 logger。

## 3. 架构与约定
- **全局配置**：在应用启动时调用 `logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")`，所有子模块共享该根记录器。
- **命名空间策略**：每个模块通过 `logger = logging.getLogger(__name__)` 获取以自身模块路径为名的 logger，便于按模块过滤输出。
- **日志级别使用**：
  - `info`：常规业务事件（服务启停、连接成功、会话创建、RAG 注入等）。
  - `warning`：可恢复异常或降级场景（Qdrant 不可用、RAG 无结果、MinIO presigned URL 失败等）。
  - `error`：不可恢复错误（LLM 调用失败、Redis 写入失败、集合操作异常等）。
  - `critical`：致命错误导致进程退出（Redis 不可用时直接 `SystemExit`）。
- **结构化字段**：当前日志为纯文本格式，未使用 JSON 结构化输出；关键上下文（如 session token、模型名、集合数等）通过 f-string 拼入消息体。
- **异常堆栈**：部分关键错误使用 `exc_info=True` 输出完整 traceback（如 RAG 检索失败），其余错误仅记录异常信息字符串。
- **无独立日志路由/Handler**：未自定义 StreamHandler/FileHandler/RotatingFileHandler，默认输出到 stderr，依赖容器或进程管理器收集 stdout/stderr。

## 4. 开发者应遵循的规则
1. 在新模块中统一使用 `import logging; logger = logging.getLogger(__name__)` 获取 logger。
2. 优先使用 `logger.info/warning/error/critical`，避免裸 `print`。
3. 对可能影响流程的异常使用 `error` 并附带必要上下文；仅在真正致命时使用 `critical`。
4. 需要堆栈跟踪时显式传入 `exc_info=True`。
5. 如需调整日志级别或输出格式，修改 `server/main.py` 中的 `logging.basicConfig` 参数，而非在各模块单独配置。
6. 生产环境建议将日志输出重定向至文件或使用外部采集器（stdout/stderr → 日志聚合平台）。