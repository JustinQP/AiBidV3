# AiBidV3 后端

第一阶段可运行的纵向切片：项目创建、招标文件上传、异步任务、要求查询与人工确认。运行时为 Node.js 24 LTS、TypeScript 和 Fastify 5。

> **能力边界**：当前的 `DevelopmentDocumentParser` 是开发适配器，只生成固定演示数据，**不会读取或解析 PDF/DOC/DOCX 内容**。它产生的要求和 `sourceLocator` 全部标记为 `development-fixture`，页码为 `null`，不能用于真实投标文件、准确性评估或生产决策。

## 快速开始

```bash
cd backend
cp .env.example .env
npm ci
npm run dev
```

默认监听 `http://localhost:3000`，无外部依赖时使用内存 Repository：

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
| `GET` | `/health` | API 与 Repository 健康状态 |
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

单实例启动时会恢复未完成任务：PostgreSQL Repository 将遗留的 `running` 重置为 `queued`，返回全部 `queued` 任务并重新入队；任务处理器会阻止同一租户、同一任务在本进程中重复入队。内存 Repository 只返回仍在内存中的 `queued` 任务。

## 持久化

### 内存模式

`.env.example` 默认 `REPOSITORY_DRIVER=memory`，用于测试和零依赖演示。进程退出后数据丢失。

### PostgreSQL 模式

```bash
export REPOSITORY_DRIVER=postgres
export DATABASE_URL=postgresql://aibid:aibid@localhost:5432/aibid
npm run db:migrate
npm run db:smoke
npm run dev
```

也可设置 `MIGRATE_ON_START=true`，让单实例开发环境在启动时执行带 advisory lock 的迁移。生产环境建议由独立发布任务执行 `npm run db:migrate:prod`。

迁移位于 `migrations/`，包含：

- `timestamptz` 审计时间与状态约束；
- 租户维度的组合外键和查询索引，数据库约束保证 task 与 file、requirement 与 task/file/project 的完整 lineage；
- `(tenant_id, status, created_at)` 任务索引；
- 文件内容的开发期 `bytea` 持久化。

当前所有 Repository 方法和 SQL 查询都显式携带 `tenantId`。迁移文件故意没有启用 RLS，并留有上线门禁说明：**生产前必须接入可信身份传播、启用并验证 RLS、防越权集成测试**。同时应把文件正文迁移到对象存储，不应长期保存在数据库 `bytea` 中。

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
│   ├── memory/           # 零依赖实现
│   └── postgres/         # PostgreSQL 实现与迁移执行器
├── app.ts                # Fastify 组合根
└── server.ts             # 进程入口
```

当前恢复机制只适用于**单 API 实例开发**。它不提供多实例抢占、租约、心跳或 exactly-once 保证，不得在多副本或滚动发布环境启用。下一阶段应将进程内任务替换为带租约的 durable queue/独立 worker，接入真实且可评测的文档解析器，并补充认证授权、病毒扫描、对象存储、幂等、重试和审计链路。
