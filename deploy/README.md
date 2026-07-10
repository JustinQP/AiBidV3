# 本地部署与基础设施

`deploy/` 提供 AiBidV3 的本地开发编排。当前 Compose 启动 Fastify API、PostgreSQL、Redis 和 MinIO；前端仍建议在宿主机运行，以保留 Vite 热更新。

阶段 B 的新上传原件由 API 写入 MinIO 私有 bucket，PostgreSQL 保存对象引用、任务与业务事实；迁移前的 `project_files.content bytea` 行仍可兼容读取。解析仍由 API 进程内的开发适配器完成，只生成固定开发数据。Redis 尚未进入请求链路，留待阶段 C 的 outbox、持久队列和独立 worker。

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
| API 健康检查 | `http://localhost:3000/health` | Repository 与对象存储就绪状态 |
| PostgreSQL | `localhost:5432` | 业务与任务事实 |
| Redis | `localhost:6379` | 后续 parser 队列/锁 |
| MinIO S3 | `http://localhost:9000` | S3 兼容接口 |
| MinIO Console | `http://localhost:9001` | 本地对象查看 |

`minio-init` 会创建私有 bucket（默认 `aibid-dev`）后退出，退出码为 0 属于正常状态。API 依赖该一次性任务成功完成，避免在 bucket 尚未创建时接受上传。

## 启动前端

另开终端：

```bash
cd frontend
npm ci
npm run dev
```

前端默认地址为 `http://localhost:4173`。当前高保真原型默认使用 Mock 数据；切换到 API 模式后，项目、上传、任务轮询和要求确认以 [`../docs/api/openapi.yaml`](../docs/api/openapi.yaml) 为契约。

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
OBJECT_STORAGE_DRIVER=s3
OBJECT_STORAGE_TIMEOUT_MS=10000
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=aibid-dev
S3_ACCESS_KEY=aibid-local
S3_SECRET_KEY=change-me-local-only
S3_FORCE_PATH_STYLE=true
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

## 迁移与回滚

`0002_object_storage.sql` 是增量迁移：保留旧 `content` 列，将其改为可空，并增加对象引用字段和存储来源约束。数据库迁移不应在应用回滚时反向删除。

S3 模式的新行不再保存 `content`，因此已有新上传后不能直接降级到只认识 `bytea` 的旧版本。共享环境若需回滚，必须先暂停上传并选择其一：使用经校验的工具把 S3 原件回填到 `content`，或恢复升级前数据库与对象存储的一致快照。当前尚未提供自动回填工具，所以这套 Compose 仍只定位为本地开发环境，不能声称具备生产级回滚能力。

## 配置说明

- Compose 的后端构建上下文是 `../backend`，不要把 `Dockerfile` 或依赖复制到 `deploy/`。
- API 在 Compose 中固定使用 `REPOSITORY_DRIVER=postgres`、`OBJECT_STORAGE_DRIVER=s3` 和 `MIGRATE_ON_START=true`，用于本地持久化验证；S3 故障不会静默回退到数据库字节或内存。
- `MAX_UPLOAD_BYTES` 默认 25 MiB；服务端限制始终优先于前端提示。
- `DEV_TENANT_ID` 只是本地租户上下文，不是认证。不得将此模式部署到生产。
- `x-tenant-id` 可在开发请求中临时覆盖租户以验证隔离；它不是身份凭证，生产环境必须禁用。
- `S3_*` 由 API 用于新上传原件；对象键由服务端按租户、项目和文件 ID 生成，不包含原文件名。
- `REDIS_URL` 仍只是阶段 C 预留配置；Compose 启动 Redis 不代表真实 parser worker 已接入。
- `project_files.content bytea` 只兼容迁移前旧行。删除该列前必须完成对象回填、SHA-256 校验、备份与回滚演练。
- API 当前仍将最多 25 MiB 的 multipart 文件读入内存后写 S3；这完成了持久化边界切换，不代表已支持大文件流式或分片上传。

## 密钥与生产边界

- `.env`、私钥、云访问密钥和数据库备份不得提交。仓库只保留 `.env.example`。
- 示例密码仅为本地占位符；共享环境必须由部署平台的密钥管理能力注入高强度凭据。
- Bucket 保持私有，浏览器不接触永久 S3 凭据；日志不得记录原件内容、凭据或带签名的 URL。
- 当前上传只完成扩展名、非空、大小和 SHA-256 校验；MIME、文件头、恶意文件扫描和保留策略完成前不可作为生产上传网关。
- 本 Compose 没有 TLS、高可用、备份、网络隔离、监控或滚动升级能力，不可直接作为生产部署方案。
- 生产数据库迁移应作为受控发布步骤执行，不建议使用 `MIGRATE_ON_START=true`。

## 配置校验

无需启动容器即可展开并校验 Compose：

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet
```

完整架构、任务状态机、租户隔离和后续 worker 计划见 [`../docs/MVP_TECHNICAL_DESIGN.md`](../docs/MVP_TECHNICAL_DESIGN.md)。
