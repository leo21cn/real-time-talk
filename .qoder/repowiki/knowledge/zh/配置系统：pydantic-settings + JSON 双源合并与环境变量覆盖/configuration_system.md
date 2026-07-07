## 1. 采用的框架与工具
- pydantic-settings（BaseSettings）：用于环境变量到强类型配置的解析，提供字段别名、默认值与类型校验。
- JSON 配置文件 config.json：作为可提交的默认/共享配置基线。
- .env 文件族：.env.example（模板）、.env.production（生产示例）、deploy/config/.env（部署包内副本）。
- TOML 片段配置：clips/short-hair-teacher-girl/clips.toml 描述头像切片库元数据，由视频生成管线读取，不属于运行时服务配置，但体现项目对多格式配置的采用。

## 2. 核心文件与入口
- server/config.py：唯一配置加载器，定义 AppConfig(BaseSettings) 及扁平化合并逻辑，暴露 load_config() / get_config() / reload_config()。
- config.json：根级 JSON 默认配置，包含 llm/tts/avatar/redis/minio/server/ffmpeg 等键。
- .env.example / .env.production / deploy/config/.env：环境变量清单与生产示例。
- server/main.py：在 FastAPI lifespan 中调用 get_config() 完成启动期配置消费，并在 __main__ 分支用 cfg['server'] 驱动 uvicorn。
- 各模块通过 from server.config import get_config 按需获取配置，无全局注入容器。

## 3. 架构与约定
### 3.1 加载优先级
环境变量 > config.json > 代码默认值
- AppConfig 通过 Field(alias=...) 将 Python 属性名映射到 UPPER_SNAKE_CASE 环境变量名；当环境变量非空时覆盖 JSON 同路径值。
- _load_json_config() 仅从仓库根目录 config.json 读取；若不存在则返回空字典。
- load_config() 内部使用 _get(key_parts, json_data, env_value, default) 按嵌套路径取值并做覆盖判断。

### 3.2 配置结构（扁平化输出）
get_config() 返回一个扁平 dict，顶层键包括：llm、tts、avatar、system_prompt、redis、minio、server、ffmpeg、qdrant、embedding、rag、knowledge_admin_token。子键与 config.json 保持一致，便于直接透传给下游客户端（如 LlmClient、MinioClient、QdrantClient 等）。

### 3.3 懒加载与热重载
- 全局 _config 缓存，首次访问 get_config() 时才执行合并。
- 提供 reload_config() 重置缓存，当前未在运行时代码中调用，为未来热重载预留接口。

### 3.4 特殊配置项
- system_prompt：优先取 config.json.system_prompt，为空时回退到 server/resources/default_system_prompt.txt 或 resources/default_system_prompt.txt（兼容 Docker 挂载路径）。
- role_collections：以 JSON 字符串形式存放角色到集合映射，支持字符串或数组两种值形态（见 .env.production 中的 ROLE_COLLECTIONS）。
- knowledge_admin_token：知识管理 API 的静态鉴权 token，空表示跳过鉴权。

### 3.5 前端配置
前端（client/）未实现独立配置加载层，依赖 Vite 构建产物与后端 /api/* 路由；运行时行为完全由后端配置驱动。

## 4. 开发者应遵循的规则
1. 新增配置字段：在 AppConfig 中以 Field(default=..., alias="ENV_NAME") 声明，保持 UPPER_SNAKE_CASE 环境变量命名；同步更新 load_config() 的合并映射，确保 JSON 路径与 pydantic 属性一致；在 .env.example 中添加注释说明，必要时在 config.json 给出合理默认值。
2. 敏感信息：API Key、密码等必须通过环境变量传入，禁止硬编码进 config.json；.env.production 与 deploy/config/.env 仅为示例，不应随源码提交真实密钥。
3. 读取方式：所有模块统一通过 get_config() 获取，不要自行重复解析 .env 或 config.json。
4. 类型安全：利用 pydantic 的类型注解与默认值，避免在业务代码中再做字符串拼接/转换。
5. Docker/Compose 环境：服务间通信地址（如 redis://redis:6379/0、minio:9000）应在 compose 环境变量中注入，而非写死于 config.json。
6. TOML 片段配置：头像切片库的 clips.toml 属于资源元数据，不在运行时配置合并范围内，修改后需重启相关生成任务生效。