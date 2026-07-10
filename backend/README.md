# AiBidV3 后端

阶段 B 可运行的纵向切片：项目创建、招标文件上传、S3 原件持久化、异步任务、要求查询与人工确认。运行时为 Node.js 24 LTS、TypeScript 和 Fastify 5。

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

上传接受 `.pdf`、`.doc`、`.docx` 和便于开发夹具验证的 `.txt`，默认上限 25 MiB。上传响应为 `202 { data: { file, task } }`，开发任务随后在 API 进程内从 `queued` 进入 `running`，最后成为 `succeeded` 或 `failed`。

当前上传校验只检查文件名扩展名和大小，不验证 MIME 与文件头，也没有病毒扫描；它是开发入口，不是安全上传网关。

单实例启动时会恢复未完成任务：PostgreSQL Repository 将遗留的 `running` 重置为 `queued`，返回全部 `queued` 任务并重新入队；任务处理器会阻止同一租户、同一任务在本进程中重复入队。内存 Repository 只返回仍在内存中的 `queued` 任务。该处理器仍运行在 API 进程内，不是独立 worker。

## 持久化

### 内存模式

`.env.example` 默认 `REPOSITORY_DRIVER=memory`，用于测试和零依赖演示。内存 Repository 与内存对象存储都随进程退出而丢失，不得作为持久化验收依据。

### PostgreSQL + S3 模式

推荐直接使用 [`../deploy/docker-compose.yml`](../deploy/docker-compose.yml)，它会启动 PostgreSQL、初始化私有 MinIO bucket，并在 bucket 可用后启动 API。

若后端运行在宿主机，需要同时显式启用 PostgreSQL 和 S3：

```bash
export REPOSITORY_DRIVER=postgres
export DATABASE_URL=postgresql://aibid:aibid@localhost:5432/aibid
export OBJECT_STORAGE_DRIVER=s3
export OBJECT_STORAGE_TIMEOUT_MS=10000
export S3_ENDPOINT=http://localhost:9000
export S3_REGION=us-east-1
export S3_BUCKET=aibid-dev
export S3_ACCESS_KEY=aibid-local
export S3_SECRET_KEY=change-me-local-only
export S3_FORCE_PATH_STYLE=true
npm run db:migrate
npm run db:smoke
npm run dev
```

也可设置 `MIGRATE_ON_START=true`，让单实例开发环境在启动时执行带 advisory lock 的迁移。生产环境建议由独立发布任务执行 `npm run db:migrate:prod`。

迁移位于 `migrations/`，包含：

- `timestamptz` 审计时间与状态约束；
- 租户维度的组合外键和查询索引，数据库约束保证 task 与 file、requirement 与 task/file/project 的完整 lineage；
- `(tenant_id, status, created_at)` 任务索引；
- `object_key`、`object_version_id`、`object_etag`、`object_stored_at` 对象引用及部分唯一索引；
- 兼容旧 `bytea` 行的存储来源约束；`content` 已可空，但暂不删除以支持迁移和回滚。

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
| `DEV_PARSER_DELAY_MS` | `250` | 开发解析任务延迟 |
| `OBJECT_STORAGE_DRIVER` | `memory` | `memory` 或 `s3`；Compose 明确设置为 `s3` |
| `OBJECT_STORAGE_TIMEOUT_MS` | `10000` | 对象存储单次操作超时，单位毫秒 |
| `S3_ENDPOINT` | — | S3 兼容服务地址；本地宿主机使用 `http://localhost:9000` |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_BUCKET` | — | 私有原件 bucket |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | 服务端对象存储凭据，不得暴露给浏览器或提交到 Git |
| `S3_FORCE_PATH_STYLE` | `false` | MinIO 本地开发设为 `true` |

## 工程检查

```bash
npm run typecheck
npm run lint
npm run test
npm run build
# 或一次执行
npm run check
```

生产容器：

```bash
docker build -t aibid-backend ./backend
docker run --rm -p 3000:3000 aibid-backend
```

## 目录

```text
src/
├── api/                  # HTTP 路由、租户上下文、响应 presenter
├── application/          # 上传任务与开发解析适配器
├── domain/               # 领域模型和 Repository 抽象
├── infrastructure/
│   ├── memory/           # 零依赖 Repository 与对象存储
│   ├── postgres/         # PostgreSQL 实现与迁移执行器
│   └── s3/               # S3 兼容对象存储适配器
├── app.ts                # Fastify 组合根
└── server.ts             # 进程入口
```

当前恢复机制只适用于**单 API 实例开发**。它不提供多实例抢占、租约、心跳或 exactly-once 保证，不得在多副本或滚动发布环境启用。阶段 C 应单独将进程内任务替换为 outbox + durable queue + 带租约的独立 worker，再接入真实且可评测的文档解析器；认证授权、病毒扫描、HTTP 幂等、持久孤儿对象回收和审计仍是后续上线门禁。
