# AiBidV3 后端

Phase C1 可运行的可靠 worker 纵向切片：项目创建、招标文件上传、S3 原件持久化、PostgreSQL outbox、Redis Streams 投递、独立 worker、要求查询与人工确认。运行时为 Node.js 24 LTS、TypeScript 和 Fastify 5。

> **能力边界**：当前的 `DevelopmentDocumentParser` 是开发适配器，只生成固定演示数据，**不会读取或解析 PDF/DOC/DOCX 内容**。它产生的要求和 `sourceLocator` 全部标记为 `development-fixture`，页码为 `null`，不能用于真实投标文件、准确性评估或生产决策。

## 快速开始

```bash
cd backend
cp .env.example .env
npm ci
npm run dev
```

默认监听 `http://localhost:3000`，无外部依赖时使用内存 Repository 和内存对象存储：

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/v1/projects \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant-demo' \
  -d '{"name":"示例投标项目"}'
```

`x-tenant-id` 只是便于开发联调的租户上下文。缺省值来自 `DEV_TENANT_ID`。**它不是登录、鉴权或可信身份凭证，生产环境不得沿用。**

## API 契约

成功响应统一使用 `{ "data": ... }`。错误响应使用 `application/problem+json`，包含 `type`、`title`、`status`、`detail`、`instance`、稳定的 `code` 和便于日志关联的 `requestId`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | API、Repository 与对象存储健康状态 |
| `GET` / `POST` | `/api/v1/projects` | 项目列表 / 创建项目 |
| `GET` | `/api/v1/projects/:projectId` | 项目详情 |
| `GET` / `POST` | `/api/v1/projects/:projectId/files` | 文件列表 / 上传；multipart 字段名为 `file` |
| `GET` | `/api/v1/projects/:projectId/tasks` | 项目任务列表 |
| `GET` | `/api/v1/tasks/:taskId` | 任务进度 |
| `POST` | `/api/v1/tasks/:taskId/retry` | 重试失败任务 |
| `GET` | `/api/v1/projects/:projectId/requirements` | 要求列表；支持 `confirmationStatus`、`priority` 筛选 |
| `PATCH` | `/api/v1/projects/:projectId/requirements/:requirementId/confirmation` | `{ "status":"confirmed|rejected", "note"?: string }` |

上传接受 `.pdf`、`.doc`、`.docx` 和便于开发夹具验证的 `.txt`，默认上限 25 MiB。上传响应为 `202 { data: { file, task } }`。PostgreSQL 模式下，API 在同一事务内创建任务与 outbox，独立 worker 随后将任务从 `queued` 推进到 `running`，最后成为 `succeeded` 或 `failed`；`attempt` 在每次成功领取任务租约时增加，人工重试后重置。默认内存模式仍在 API 进程内执行开发任务。

当前上传校验只检查文件名扩展名和大小，不验证 MIME 与文件头，也没有病毒扫描；它是开发入口，不是安全上传网关。

PostgreSQL 模式的 API 不连接 Redis，也不执行解析器。任务与 outbox 先在数据库事务中提交；worker 的 relay 再投递 Redis Stream，并由 consumer group 消费。消息允许重复交付，worker 使用 PostgreSQL lease token 对心跳、进度和终态写入做 fencing。系统提供 at-least-once delivery + fenced effects，**不宣称 exactly-once**。完整决策见 [`../docs/adr/0001-durable-task-delivery.md`](../docs/adr/0001-durable-task-delivery.md)。

## 持久化

### 内存模式

`.env.example` 默认 `REPOSITORY_DRIVER=memory`，用于测试和零依赖演示。内存 Repository 与内存对象存储都随进程退出而丢失，开发解析器仍在 API 进程内运行，不得作为持久化或 worker 恢复验收依据。

### PostgreSQL + S3 + Redis 模式

推荐直接使用 [`../deploy/docker-compose.yml`](../deploy/docker-compose.yml)，它会启动 PostgreSQL、Redis、初始化私有 MinIO bucket，并按健康依赖启动 API 与独立 worker。

若后端运行在宿主机，将 `.env.example` 复制为 `.env`，并设置 PostgreSQL、S3 与 worker 配置。两个进程会自动读取同一文件：

```dotenv
REPOSITORY_DRIVER=postgres
DATABASE_URL=postgresql://aibid:change-me-local-only@localhost:5432/aibid
OBJECT_STORAGE_DRIVER=s3
OBJECT_STORAGE_TIMEOUT_MS=10000
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=aibid-dev
S3_ACCESS_KEY=aibid-local
S3_SECRET_KEY=change-me-local-only
S3_FORCE_PATH_STYLE=true
REDIS_URL=redis://localhost:6379/0
REDIS_STREAM_KEY=aibid:parse-tasks
REDIS_CONSUMER_GROUP=aibid-parser
REDIS_CLAIM_IDLE_MS=60000
WORKER_ID=worker-local-1
WORKER_CONCURRENCY=2
TASK_LEASE_MS=30000
TASK_HEARTBEAT_MS=10000
TASK_MAX_ATTEMPTS=3
TASK_RETRY_BACKOFF_MS=1000
OUTBOX_POLL_INTERVAL_MS=250
OUTBOX_LEASE_MS=10000
OUTBOX_BATCH_SIZE=20
```

首次启动 API：

```bash
cd backend
npm ci
npm run db:migrate
npm run db:smoke
npm run dev
```

API 启动后，在另一个终端运行独立 worker：

```bash
cd backend
npm run worker
```

也可设置 `MIGRATE_ON_START=true`，让单实例开发环境在启动时执行带 advisory lock 的迁移。生产环境建议由独立发布任务执行 `npm run db:migrate:prod`。

迁移位于 `migrations/`，包含：

- `timestamptz` 审计时间与状态约束；
- 租户维度的组合外键和查询索引，数据库约束保证 task 与 file、requirement 与 task/file/project 的完整 lineage；
- `(tenant_id, status, created_at)` 任务索引；
- `object_key`、`object_version_id`、`object_etag`、`object_stored_at` 对象引用及部分唯一索引；
- 兼容旧 `bytea` 行的存储来源约束；`content` 已可空，但暂不删除以支持迁移和回滚；
- outbox 事件，以及任务 `attempt`、租约、fencing token、重试调度和终态约束。

S3 模式的新上传使用服务端生成的租户/项目/文件对象键，原件不写入 `content`。解析读取受记录大小的硬上限约束，并复核大小和 SHA-256。数据库写入明确失败时会补偿删除对象；若提交结果因连接中断无法确认，则先回查文件与任务，无法确认时保留对象等待后续对账，避免误删已提交记录所引用的原件。旧 `bytea` 行仍可读取，删除兼容列前必须完成对象回填、SHA-256 校验、备份和回滚演练。

为防止“PostgreSQL 持久化、文件却落在进程内存”的假持久化，配置层拒绝 `REPOSITORY_DRIVER=postgres` 与 `OBJECT_STORAGE_DRIVER=memory` 的组合。

当前所有 Repository 方法和 SQL 查询都显式携带 `tenantId`。迁移文件故意没有启用 RLS，并留有上线门禁说明：**生产前必须接入可信身份传播、启用并验证 RLS、防越权集成测试**。对象存储接入也不等于已具备生产上传安全能力。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | 监听地址 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `CORS_ORIGINS` | `http://localhost:4173` | 逗号分隔的允许来源 |
| `REPOSITORY_DRIVER` | `memory` | `memory` 或 `postgres` |
| `DATABASE_URL` | — | PostgreSQL 连接串 |
| `DATABASE_SSL` | `false` | 启用 PostgreSQL TLS（开发配置不校验证书） |
| `MIGRATE_ON_START` | `false` | 启动前执行迁移 |
| `DEV_TENANT_ID` | `tenant-demo` | 无请求头时的开发租户 |
| `MAX_UPLOAD_BYTES` | `26214400` | 单文件上限 |
| `DEV_PARSER_DELAY_MS` | `250` | 仅默认内存模式的进程内开发解析延迟 |
| `OBJECT_STORAGE_DRIVER` | `memory` | `memory` 或 `s3`；Compose 明确设置为 `s3` |
| `OBJECT_STORAGE_TIMEOUT_MS` | `10000` | 对象存储单次操作超时，单位毫秒 |
| `S3_ENDPOINT` | — | S3 兼容服务地址；本地宿主机使用 `http://localhost:9000` |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_BUCKET` | — | 私有原件 bucket |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | 服务端对象存储凭据，不得暴露给浏览器或提交到 Git |
| `S3_FORCE_PATH_STYLE` | `false` | MinIO 本地开发设为 `true` |
| `REDIS_URL` | — | worker 必填的 Redis 连接串；`.env.example` 使用本机 6379，API 不依赖 Redis |
| `REDIS_STREAM_KEY` | `aibid:parse-tasks` | 解析任务 Stream key |
| `REDIS_CONSUMER_GROUP` | `aibid-parser` | Redis consumer group |
| `REDIS_CLAIM_IDLE_MS` | `60000` | pending 消息允许接管前的 idle 时间；不得小于任务租约 |
| `WORKER_ID` | `hostname:pid` | 可显式覆盖的 worker 标识，多实例不得重复；Compose 固定本地值 |
| `WORKER_CONCURRENCY` | `2` | 单 worker 最大并发任务数 |
| `TASK_LEASE_MS` | `30000` | PostgreSQL 任务租约时长 |
| `TASK_HEARTBEAT_MS` | `10000` | 租约续期周期；必须小于租约时长 |
| `TASK_MAX_ATTEMPTS` | `3` | 自动领取/执行尝试上限 |
| `TASK_RETRY_BACKOFF_MS` | `1000` | 瞬态失败重试基础退避，单位毫秒 |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | 无待发布事件时的 relay 轮询间隔 |
| `OUTBOX_LEASE_MS` | `10000` | outbox relay 领取租约 |
| `OUTBOX_BATCH_SIZE` | `20` | 单轮 relay 最大事件数 |

## 工程检查

```bash
npm run typecheck
npm run lint
npm run test
npm run build
# 或一次执行
npm run check
```

真实 worker adapter smoke 需要已启动并完成迁移的 PostgreSQL、Redis 与 MinIO；它覆盖 outbox、pending 接管、重复消息和 fenced results：

```bash
npm run worker:smoke
```

CI 还会构建并启动 [`../deploy/docker-compose.yml`](../deploy/docker-compose.yml) 中的生产 API 与 `worker:prod`，再运行 [`../deploy/full-stack-smoke.mjs`](../deploy/full-stack-smoke.mjs) 通过 HTTP 验证独立进程链路。

生产容器：

```bash
docker build -t aibid-backend ./backend
docker run --rm -p 3000:3000 aibid-backend
# 使用相同镜像和持久化环境变量启动独立 worker
docker run --rm aibid-backend npm run worker:prod
```

## 目录

```text
src/
├── api/                  # HTTP 路由、租户上下文、响应 presenter
├── application/          # 上传、任务处理与开发解析适配器
├── domain/               # 领域模型和 Repository 抽象
├── infrastructure/
│   ├── memory/           # 零依赖 Repository 与对象存储
│   ├── postgres/         # PostgreSQL 实现与迁移执行器
│   ├── redis/            # Redis Streams delivery adapter
│   └── s3/               # S3 兼容对象存储适配器
├── app.ts                # Fastify 组合根
├── server.ts             # API 进程入口
└── worker.ts             # 独立 worker 进程入口
```

Phase C1 已把 PostgreSQL 模式的解析任务移到独立 worker，并提供 outbox、Redis pending 接管、数据库租约、心跳、最大尝试次数和 fencing。它仍使用 `DevelopmentDocumentParser`，没有真实 PDF/DOCX 文本提取、版面恢复或 locator；这些能力和解析基准集属于 Phase C2。认证授权、病毒扫描、HTTP 幂等、持久孤儿对象回收、审计以及生产级高可用仍是后续上线门禁。
