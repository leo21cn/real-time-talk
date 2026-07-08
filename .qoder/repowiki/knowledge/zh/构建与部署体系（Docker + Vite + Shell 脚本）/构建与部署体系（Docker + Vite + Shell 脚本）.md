---
kind: build_system
name: 构建与部署体系（Docker + Vite + Shell 脚本）
category: build_system
scope:
    - '**'
source_files:
    - Dockerfile
    - docker-compose.yml
    - docker-stack.yml
    - client/package.json
    - client/vite.config.ts
    - server/requirements.txt
    - deploy/test_suite.sh
    - deploy/compress.ps1
    - deploy/config/docker-stack.yml
---

## 1. 使用的系统与方法
- **后端容器化**：基于 `python:3.11-slim` 的 Dockerfile，使用 uvicorn 启动 FastAPI 服务；依赖通过 `requirements.txt` 锁定。
- **前端构建**：React + TypeScript + Vite，`client/package.json` 中定义 `dev/build/preview` 脚本，输出产物到 `client/dist`。
- **本地编排**：`docker-compose.yml` 一键拉起 qdrant、redis、minio、server、nginx 五类服务，用于开发与联调。
- **生产编排**：`docker-stack.yml` 面向 Docker Swarm 集群，以预构建镜像 `real-time-talk-predeploy:latest` 运行，外部挂载 `.env` 与 `config.json`。
- **测试与发布脚本**：`deploy/` 下集中了端到端测试套件（`test_suite.sh`、`master_test.sh`）、静态资源更新、SSL 配置、压缩打包等运维脚本。

## 2. 关键文件与位置
- 容器与编排
  - `Dockerfile`：后端镜像构建，安装 ffmpeg、拷贝 server/clips/client/dist。
  - `docker-compose.yml`：本地开发环境编排。
  - `docker-stack.yml`：Swarm 生产编排（网络复用外部 docker_default / qdrant-net / redis-net）。
  - `deploy/config/docker-stack.yml`：Swarm 模板（环境变量为空，由运行时注入）。
- 前端构建
  - `client/package.json`：Vite 入口与依赖声明。
  - `client/vite.config.ts`：多入口（main/admin），开发代理 `/api`、`/ws` 到 8000。
- 依赖清单
  - `server/requirements.txt`：FastAPI、uvicorn、websockets、redis、minio、pydantic、qdrant-client 等。
- 测试与发布
  - `deploy/test_suite.sh`：覆盖会话、clip、知识库、配置优先级等生产用例。
  - `deploy/compress.ps1`：将 tar 包 gzip 压缩并清理源文件。
  - `deploy/*.sh`、`deploy/*.py`：路由检查、WebSocket 连通性、Nginx 修复、Prompt 同步等辅助工具。

## 3. 架构与约定
- **镜像分层与缓存优化**：先拷贝 `requirements.txt` 再 `pip install`，利用 Docker 层缓存加速重复构建。
- **静态资源内嵌策略**：生产镜像直接拷贝 `client/dist` 到 `/app/static`，由 FastAPI 或 Nginx 提供，避免运行时再次构建前端。
- **配置外置**：敏感信息（`.env`）与业务配置（`config.json`）通过 volume 只读挂载进容器，不进入镜像，支持热更新。
- **多环境网络模型**：
  - 本地 compose：所有服务在同一默认网络，端口直曝。
  - Swarm 生产：server 加入多个外部网络（default/docker_default/qdrant-net/redis-net），仅暴露给上层 nginx-gateway。
- **构建产物命名**：Swarm 镜像固定为 `real-time-talk-predeploy:latest`，发布目录按 `deploy/<IP>_<timestamp>/` 归档 tar/tar.gz。

## 4. 开发者应遵循的规则
- **新增 Python 依赖**：同步更新 `server/requirements.txt`，并在本地 `docker-compose up --build` 验证。
- **修改前端代码**：在 `client/` 下执行 `npm run build`，确保产物写入 `client/dist`，否则生产镜像不会包含新页面。
- **环境变量管理**：新增配置项优先走 `.env`（由 `pydantic-settings` 加载），不要硬编码到代码或镜像中。
- **Swarm 部署前检查**：确认 `docker_stack.yml` 中的网络名与宿主机一致，且 `/root/real-time-talk/.env`、`config.json` 已就绪。
- **发布流程**：先在本地 `docker build -t real-time-talk-predeploy .`，再用 `deploy/compress.ps1` 生成 tar.gz，上传后 `docker load` 并通过 `docker stack deploy` 滚动更新。
- **回归测试**：变更 API 或 clip 资源后，在目标环境执行 `deploy/test_suite.sh` 或对应 phase 脚本，确保 HTTP/WS 行为符合预期。