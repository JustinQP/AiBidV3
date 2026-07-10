# 本地部署与基础设施

`deploy/` 提供 AiBidV3 的本地开发编排。当前 Compose 启动 Fastify API、PostgreSQL、Redis 和 MinIO；前端仍建议在宿主机运行，以保留 Vite 热更新。

第一阶段的文件内容和解析仍由 API 内的开发适配器处理。上传内容暂存 PostgreSQL `project_files.content bytea`，默认上限 25 MiB；此路径只允许本机开发，禁止用于共享环境或生产。Redis、MinIO 现阶段用于提前固定基础设施边界，尚未被 API 使用，也不代表真实 parser worker 已经接入。

## 前置条件

- Docker Engine 24+ 和 Docker Compose v2
- 前端本地开发需要 Node.js 24 LTS
- 确保本机 `3000`、`5432`、`6379`、`9000`、`9001` 未被占用，或在 `.env` 修改宿主机端口

## 启动

从仓库根目录执行：

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

服务地址：

| 服务 | 地址 | 用途 |
|---|---|---|
| API | `http://localhost:3000` | Fastify REST API |
| API 健康检查 | `http://localhost:3000/health` | 进程状态 |
| PostgreSQL | `localhost:5432` | 业务与任务事实 |
| Redis | `localhost:6379` | 后续 parser 队列/锁 |
| MinIO S3 | `http://localhost:9000` | S3 兼容接口 |
| MinIO Console | `http://localhost:9001` | 本地对象查看 |

`minio-init` 会创建私有 bucket（默认 `aibid-dev`）后退出，退出码为 0 属于正常状态。

## 启动前端

另开终端：

```bash
cd frontend
npm ci
npm run dev
```

前端默认地址为 `http://localhost:4173`。当前高保真原型仍以 Mock 数据为主；接入 API 时应以 [`../docs/api/openapi.yaml`](../docs/api/openapi.yaml) 为契约。

## 常用命令

查看服务状态：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

查看 API 日志：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f api
```

仅启动基础设施、在宿主机运行后端：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d postgres redis minio minio-init
```

随后将 `backend/.env.example` 复制为 `backend/.env`，并确认以下配置；宿主机连接数据库时必须使用 `localhost`，同时显式切换到 PostgreSQL Repository：

```dotenv
REPOSITORY_DRIVER=postgres
DATABASE_URL=postgresql://aibid:change-me-local-only@localhost:5432/aibid
MIGRATE_ON_START=false
```

首次启动先执行迁移，再运行 API：

```bash
cd backend
npm ci
npm run db:migrate
npm run dev
```

后端脚本使用 Node.js 24 的 `--env-file-if-exists=.env` 加载该文件；没有 `.env` 时仍可用默认内存模式启动。

停止容器但保留数据：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down
```

清空本地数据库、队列和对象存储：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down --volumes
```

最后一条命令会不可逆删除本地开发数据，请勿用于共享或生产环境。

## 配置说明

- Compose 的后端构建上下文是 `../backend`，不要把 `Dockerfile` 或依赖复制到 `deploy/`。
- API 在 Compose 中固定使用 `REPOSITORY_DRIVER=postgres` 和 `MIGRATE_ON_START=true`，用于本地持久化验证。
- `MAX_UPLOAD_BYTES` 默认 25 MiB；服务端限制始终优先于前端提示。
- `DEV_TENANT_ID` 只是本地租户上下文，不是认证。不得将此模式部署到生产。
- `x-tenant-id` 可在开发请求中临时覆盖租户以验证隔离；它不是身份凭证，生产环境必须禁用。
- `REDIS_URL` 与 `S3_*` 已预留给真实 worker 阶段；当前 API 忽略未使用的变量。
- `project_files.content bytea` 是临时实现；下一阶段完成 S3 校验迁移后必须删除，不能因 Compose 启动了 MinIO 就认为文件已进入对象存储。

## 密钥与生产边界

- `.env`、私钥、云访问密钥和数据库备份不得提交。仓库只保留 `.env.example`。
- 示例密码仅为本地占位符；共享环境必须由部署平台的密钥管理能力注入高强度凭据。
- 本 Compose 没有 TLS、高可用、备份、网络隔离、监控或滚动升级能力，不可直接作为生产部署方案。
- 生产数据库迁移应作为受控发布步骤执行，不建议使用 `MIGRATE_ON_START=true`。

## 配置校验

无需启动容器即可展开并校验 Compose：

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet
```

完整架构、任务状态机、租户隔离和后续 worker 计划见 [`../docs/MVP_TECHNICAL_DESIGN.md`](../docs/MVP_TECHNICAL_DESIGN.md)。
