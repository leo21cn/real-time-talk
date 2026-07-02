# RealTimeTalk 生产环境发布指南

> **版本**: 1.0
> **日期**: 2026-07-01
> **目标环境**: 阿里云 ECS (121.199.53.233) Docker Swarm

---

## 1. 目标架构总览

```
互联网 (pulan.smartmoves.com.cn)
       │
       ▼
┌──────────────────────────────────────────────┐
│  nginx-gateway Stack（已有）                   │
│  ┌────────────────────────────────────────┐  │
│  │  server_name pulan.smartmoves.com.cn   │  │
│  │  ├─ location /     → server:8000       │  │
│  │  ├─ location /api/ → server:8000       │  │
│  │  ├─ location /ws   → server:8000 (WS)  │  │
│  │  └─ SSL: Let's Encrypt certbot         │  │
│  └────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────┘
                       │ docker_default (overlay)
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ qdrant Stack │ │ redis Stack  │ │ real-time-talk Stack │
│ (已有)        │ │ (已有)        │ │ (新建)                │
│              │ │              │ │                      │
│ qdrant_qdrant│ │ redis_redis  │ │  ├─ minio (新)       │
│ :6333        │ │ :6379        │ │  └─ server (新)      │
│ qdrant-net   │ │ redis-net    │ │     :8000            │
└──────────────┘ └──────────────┘ │ docker_default+      │
                                  │ qdrant-net+          │
                                  │ redis-net            │
                                  └──────────────────────┘
```

### 关键设计决策

| 决策项 | 说明 |
|--------|------|
| 复用 qdrant/redis | 已有独立 Stack，避免端口冲突，保留现有数据 |
| server 同时服务静态文件 | 不单独部署 Nginx 容器，FastAPI 挂载 StaticFiles 于 `/` |
| 跨 Stack 通信 | server 连接 `docker_default` + `qdrant-net` + `redis-net` |
| nginx-gateway 增量配置 | 在现有 nginx.conf 末尾追加 pulan 域名 server block |
| 镜像构建方式 | 本地 `docker build` → `docker save` tar → scp 上传 → `docker load` |

---

## 2. 前置准备

### 2.1 本地环境要求

- Docker Desktop (已安装)
- PowerShell（构建前端 + 镜像）
- SSH 客户端（连接 ECS）

### 2.2 ECS 信息

| 项目 | 值 |
|------|-----|
| 公网 IP | `121.199.53.233` |
| 用户 | `root` |
| 架构 | **ARM64 (aarch64)** |
| Swarm 节点 | `iZbp1ayes5wp11dvu9irdjZ`（单节点，Leader） |

---

## 3. 部署步骤

### 步骤 0：创建部署工作目录

每次构建产生的中间文件（镜像 tar 等）统一放置于 `deploy/{ecs-ip}_{日期}_{时间}/` 目录下：

```powershell
# 在项目根目录 real-time-talk/ 执行
cd D:\szp\work\real-time-talk

# 生成时间戳目录名，例如: deploy\121.199.53.233_20260701_143000
$deployDir = "deploy\121.199.53.233_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Force -Path $deployDir
Write-Host "部署目录: $deployDir"
```

> 后续步骤中所有中间产物（`real-time-talk-predeploy.tar` 等）均输出到此目录。
> 生产配置文件已汇集在 `deploy/config/`，无需每次构建时重新准备。

> **架构说明**：ECS 节点为 **ARM64 (aarch64)** 架构，本地交叉编译需指定 `--platform linux/arm64`。

### 步骤 1：构建前端静态文件

```powershell
# 在项目根目录 real-time-talk/ 执行
cd D:\szp\work\real-time-talk\client

# 安装依赖（如果 node_modules 不存在）
npm install

# 构建生产包
npm run build
```

产物位于 `client/dist/`，将在步骤 3 中打包进 Docker 镜像。

### 步骤 2：确认 ECS 连接

```powershell
# 测试 SSH 连接
ssh root@121.199.53.233 "docker node ls"
```

预期输出包含节点 `iZbp1ayes5wp11dvu9irdjZ`，状态 `Ready`。

### 步骤 3：构建 Docker 镜像

```powershell
# 回到项目根目录
cd D:\szp\work\real-time-talk

# 构建镜像（ECS 为 ARM64，必须指定 --platform linux/arm64）
docker build --platform linux/arm64 -t real-time-talk-predeploy:latest .
```

**构建说明**：
- 基础镜像：`python:3.11-slim`
- 包含：server 代码 + clips 切片库 + client/dist 静态文件 + FFmpeg
- 暴露端口：8000

### 步骤 4：导出并上传镜像

```powershell
# 导出镜像为 tar（输出到步骤 0 创建的部署目录）
docker save -o $deployDir\real-time-talk-predeploy.tar real-time-talk-predeploy:latest

# 上传到 ECS
scp $deployDir\real-time-talk-predeploy.tar root@121.199.53.233:/root/

# 在 ECS 上加载镜像
ssh root@121.199.53.233 "docker load -i /root/real-time-talk-predeploy.tar"

# 验证镜像已加载
ssh root@121.199.53.233 "docker images real-time-talk-predeploy"
```

### 步骤 5：上传配置文件到 ECS

所有生产配置已汇集在 `deploy/config/` 目录下：

```powershell
# 创建 ECS 上的配置目录
ssh root@121.199.53.233 "mkdir -p /root/real-time-talk"

# 上传生产环境变量文件
scp deploy\config\.env root@121.199.53.233:/root/real-time-talk/.env

# 上传业务配置文件
scp deploy\config\config.json root@121.199.53.233:/root/real-time-talk/config.json

# 验证文件
ssh root@121.199.53.233 "ls -la /root/real-time-talk/"
```

> **注意**：`deploy/config/.env` 中的 API Key 为当前开发环境的 Key，请确认它们在生产环境同样有效。如有专用的生产环境 Key，请在上传前修改 `deploy/config/.env` 文件。

### 步骤 6：上传 Stack 配置文件

```powershell
# 上传 docker-stack.yml 到 ECS
scp deploy\config\docker-stack.yml root@121.199.53.233:/root/real-time-talk-stack.yml
```

### 步骤 7：部署 Stack

```powershell
ssh root@121.199.53.233 "docker stack deploy -c /root/real-time-talk-stack.yml real-time-talk"
```

**验证部署状态**：

```powershell
ssh root@121.199.53.233 "docker stack services real-time-talk"
```

预期输出：

```
ID   NAME                       MODE        REPLICAS   IMAGE
...  real-time-talk_minio       replicated  1/1        minio/minio:latest
...  real-time-talk_server      replicated  1/1        real-time-talk-predeploy:latest
```

**查看日志**：

```powershell
ssh root@121.199.53.233 "docker service logs real-time-talk_server --tail 50"
```

关键日志行：
- `Redis 连接成功`
- `Qdrant 连接成功，现有 N 个集合`
- `RealTimeTalk 服务已启动`

#### 7.1 创建默认知识库 Collection

部署后需要创建默认的 Qdrant collection `pulan-default`（向量维度 1024，Cosine 距离）：

```powershell
# 方式一：通过 RealTimeTalk 知识库 API 创建（需要先配置 admin token）
curl -k -X POST https://pulan.smartmoves.com.cn/api/knowledge/collections \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: km-tk-111111" \
  -d '{"name": "pulan-default", "vector_size": 1024}'

# 方式二：直接通过 Qdrant API 创建（Qdrant 容器内部）
ssh root@121.199.53.233 "docker exec \$(docker ps --filter name=qdrant -q) curl -X PUT http://localhost:6333/collections/pulan-default -H 'Content-Type: application/json' -d '{\"vectors\":{\"size\":1024,\"distance\":\"Cosine\"}}'"
```

验证 collection 已创建：

```powershell
ssh root@121.199.53.233 "docker exec \$(docker ps --filter name=qdrant -q) curl http://localhost:6333/collections/pulan-default"
```

> 生产环境 `.env.production` 中 `ROLE_COLLECTIONS` 已配置为 `{"普兰": ["pulan-default"]}`，RAG 检索将限定在该 collection 内。

### 步骤 8：申请 SSL 证书

ECS 上已有 certbot，为 `pulan.smartmoves.com.cn` 申请新证书：

```bash
# SSH 到 ECS
ssh root@121.199.53.233

# 申请证书（standalone 模式，需要临时占用 80 端口）
# 注意：执行前确保 nginx-gateway 不占用 80 端口，或使用 webroot 模式
certbot certonly --webroot -w /var/www/html -d pulan.smartmoves.com.cn

# 验证证书文件
ls -la /etc/letsencrypt/live/pulan.smartmoves.com.cn/
```

> **备选方案**：如果 80 端口被占用，可先用 `docker service scale nginx-gateway_nginx=0` 暂停，申请完后恢复。

### 步骤 9：更新 nginx-gateway 配置

#### 8.1 更新 Nginx 挂载的证书

```bash
# SSH 到 ECS
ssh root@121.199.53.233

# 确认当前 nginx-gateway 的证书挂载列表
docker service inspect nginx-gateway_nginx --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{.Source}} -> {{.Target}}{{"\n"}}{{end}}'
```

**通过 `docker service update` 增加证书挂载**：

```bash
docker service update \
  --mount-add type=bind,source=/etc/letsencrypt/live/pulan.smartmoves.com.cn/fullchain.pem,target=/etc/nginx/certs/pulan.smartmoves.com.cn.crt,readonly=true \
  --mount-add type=bind,source=/etc/letsencrypt/live/pulan.smartmoves.com.cn/privkey.pem,target=/etc/nginx/certs/pulan.smartmoves.com.cn.key,readonly=true \
  nginx-gateway_nginx
```

#### 8.2 追加 server block 到 nginx.conf

编辑 `/root/nginx-smartmoves/nginx.conf`，在文件末尾的 `}`（http 块结束）**之前**插入以下内容
（完整文件见 `deploy/config/nginx-pulan.conf`）：

```nginx
    # ============================================================
    # pulan.smartmoves.com.cn — RealTimeTalk
    # ============================================================

    # ── HTTP → HTTPS redirect ──────────────────────────────────
    server {
        listen 80;
        server_name pulan.smartmoves.com.cn;
        location /.well-known/acme-challenge/ { root /var/www/html; }
        location / { return 301 https://$host$request_uri; }
    }

    # ── HTTPS ──────────────────────────────────────────────────
    server {
        listen 443 ssl;
        http2 on;
        server_name pulan.smartmoves.com.cn;

        ssl_certificate     /etc/nginx/certs/pulan.smartmoves.com.cn.crt;
        ssl_certificate_key /etc/nginx/certs/pulan.smartmoves.com.cn.key;

        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options DENY;
        add_header X-XSS-Protection "1; mode=block";

        charset utf-8;

        client_max_body_size 100m;
        client_body_timeout 120s;

        # ── 前端静态文件 + API 统一代理到 FastAPI ──────────────
        location / {
            proxy_pass http://real-time-talk_server:8000;

            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Connection "";

            proxy_read_timeout 120s;
            proxy_connect_timeout 10s;
        }

        # ── WebSocket 代理 ─────────────────────────────────────
        location /ws {
            proxy_pass http://real-time-talk_server:8000;

            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            proxy_read_timeout 86400s;
            proxy_send_timeout 300s;
        }
    }
```

**保存后重载 Nginx**：

```bash
docker service update --force nginx-gateway_nginx
```

> --force 会触发服务重新调度，Nginx 容器将使用更新后的配置文件重启。

### 步骤 10：访问验证

1. 浏览器访问：**https://pulan.smartmoves.com.cn**
2. 预期看到 RealTimeTalk 对话界面
3. 测试对话功能：输入消息 → 卡通形象播放视频 + 气泡打字机效果

### 步骤 11：健康检查

```powershell
# API 健康检查（通过 nginx 代理）
curl -k https://pulan.smartmoves.com.cn/api/health

# 预期返回：
# {"status":"ok","redis":true,"sessions":0}
```

---

## 4. 更新部署

当代码有更新时，执行以下步骤：

```powershell
# 0. 创建部署目录
$deployDir = "deploy\121.199.53.233_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Force -Path $deployDir

# 1. 重新构建前端（如有前端变更）
cd client; npm run build; cd ..

# 2. 重新构建镜像（ECS 为 ARM64，必须指定平台）
docker build --platform linux/arm64 -t real-time-talk-predeploy:latest .

# 3. 导出并上传
docker save -o $deployDir\real-time-talk-predeploy.tar real-time-talk-predeploy:latest
scp $deployDir\real-time-talk-predeploy.tar root@121.199.53.233:/root/

# 4. ECS 上加载新镜像并更新服务
ssh root@121.199.53.233 "docker load -i /root/real-time-talk-predeploy.tar; docker service update --force real-time-talk_server"
```

---

## 5. 回滚

```powershell
# 移除 real-time-talk stack
ssh root@121.199.53.233 "docker stack rm real-time-talk"

# 从 nginx-gateway 配置中移除 pulan server block
# 编辑 /root/nginx-smartmoves/nginx.conf，删除对应 server block
# 然后：
ssh root@121.199.53.233 "docker service update --force nginx-gateway_nginx"
```

---

## 6. 常见问题排查

### 6.1 server 服务启动失败

```powershell
# 查看详细日志
ssh root@121.199.53.233 "docker service logs real-time-talk_server --tail 100"

# 检查服务状态
ssh root@121.199.53.233 "docker service ps real-time-talk_server --no-trunc"
```

常见原因：
- **架构不匹配（exec format error）**：ECS 为 ARM64，必须构建时指定 `--platform linux/arm64`
- **Redis 不可用**：确认 `redis_redis` 正常运行，网络 `redis-net` 可通
- **Qdrant 不可用**：确认 `qdrant_qdrant` 正常运行
- **MinIO 端口冲突**：检查 9000/9001 端口是否被占用

### 6.2 Nginx 502 Bad Gateway

原因：nginx-gateway 无法访问 `real-time-talk_server:8000`

```powershell
# 确认 server 在 docker_default 网络上
ssh root@121.199.53.233 "docker network inspect docker_default --format '{{range .Containers}}{{.Name}} {{end}}'"

# 确认服务名称正确
ssh root@121.199.53.233 "docker service ls --filter name=real-time-talk"
```

### 6.3 域名 DNS 未解析

确保 `pulan.smartmoves.com.cn` 的 DNS A 记录指向 `121.199.53.233`。

### 6.4 SSL 证书过期

certbot 证书有效期为 90 天，ECS 上已有自动续期定时任务。确认：

```bash
ssh root@121.199.53.233 "systemctl status certbot.timer"
# 或
ssh root@121.199.53.233 "crontab -l | grep certbot"
```

---

## 7. 配置文件清单

| 文件 | 用途 | 位置 |
|------|------|------|
| `deploy/config/docker-stack.yml` | Swarm Stack 编排文件 | 项目 → ECS `/root/real-time-talk-stack.yml` |
| `Dockerfile` | server 镜像构建 | 项目根目录 |
| `deploy/config/.env` | 生产环境变量（API Key 等） | 项目 → ECS `/root/real-time-talk/.env`（bind mount） |
| `deploy/config/config.json` | 业务配置 | 项目 → ECS `/root/real-time-talk/config.json`（bind mount） |
| `deploy/config/nginx-pulan.conf` | nginx-gateway 增量配置片段 | 追加到 ECS `/root/nginx-smartmoves/nginx.conf` |

---

## 8. 安全注意事项

- `deploy/config/.env` 中的 API Key **不要提交到版本控制**，`deploy/` 已在 `.gitignore` 中排除
- MinIO 默认凭据 (`minioadmin/minioadmin`) 仅用于内网服务间通信，不对外暴露端口
- `KNOWLEDGE_ADMIN_TOKEN` 用于知识库管理接口鉴权，生产环境请修改为强密码
- Redis 和 Qdrant 不对外暴露端口（通过 overlay 网络内部通信）
