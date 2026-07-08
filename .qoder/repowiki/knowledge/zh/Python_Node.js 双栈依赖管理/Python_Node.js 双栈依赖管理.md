---
kind: dependency_management
name: Python/Node.js 双栈依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - server/requirements.txt
    - client/package.json
    - client/package-lock.json
    - Dockerfile
---

本项目采用 Python + Node.js 双技术栈，分别使用 pip 与 npm 进行依赖声明与安装，并通过 Dockerfile 在构建期完成依赖解析。

- 后端（Python）：依赖清单位于 server/requirements.txt，使用 >= 宽松版本约束声明 FastAPI、uvicorn、websockets、httpx、redis[hiredis]、minio、pydantic、qdrant-client 等运行时库；未使用 pip-tools、poetry 或 Pipfile，也未生成 requirements.lock 类锁定文件。
- 前端（Node.js）：依赖清单位于 client/package.json，以 ^ 语义化版本约束声明 react、react-dom、marked 及 vite、typescript 等开发依赖；配套的 client/package-lock.json（lockfileVersion 3）由 npm 自动生成并随仓库提交，用于锁定精确子依赖树。
- Docker 构建集成：根目录 Dockerfile 通过 pip install -r server/requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com 指定阿里云 PyPI 镜像源加速安装，并将 client/dist/ 预构建产物直接 COPY 进镜像，不在此阶段执行 npm install。
- 缺失项：未发现私有 PyPI 源配置、setup.py/pyproject.toml、go.mod、vendor/ 或 pnpm-lock.yaml 等机制；前后端均无独立的 CI 依赖缓存策略。

开发者约定：
1. 新增后端依赖时同步更新 server/requirements.txt，并在本地用阿里云镜像验证可安装。
2. 前端依赖变更需提交 client/package-lock.json，确保团队与 CI 复现一致。
3. 生产镜像依赖固定于 Dockerfile 中的 -i 镜像参数，修改镜像源需同时更新该处。