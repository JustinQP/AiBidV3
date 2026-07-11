# 本地部署与基础设施

`deploy/` 提供 AiBidV3 的本地开发编排。当前 Compose 启动 Fastify API、独立 worker、PostgreSQL、Redis 和 MinIO；前端仍建议在宿主机运行，以保留 Vite 热更新。

Phase C1/C2.1 中，新上传原件由 API 写入 MinIO 私有 bucket，文件、任务与 outbox 事件在 PostgreSQL 中持久化。API 不连接 Redis；独立 worker 将 outbox 投递到 Redis Streams，再通过 consumer group、PostgreSQL 任务租约和 fencing token 执行任务。交付语义是 at-least-once，系统不宣称 exactly-once。

PostgreSQL 新上传创建 `document-parse-v1`：worker 在 60 秒与 256 MiB old-generation 默认边界内启动隔离 Worker thread，解析数字 PDF、DOCX 和严格 UTF-8 TXT，并持久化 `deterministic-rules-v1` 与版本化 locator。默认内存模式和历史任务继续使用 `development-fixture`。扫描件/OCR、legacy `.doc`、原件 viewer/download、已验证高亮以及生产准确率语料/SLO 仍未交付。

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
| Redis | `localhost:6379` | outbox 投递后的 Redis Stream 和 consumer group |
| MinIO S3 | `http://localhost:9000` | S3 兼容接口 |
| MinIO Console | `http://localhost:9001` | 本地对象查看 |

`minio-init` 会创建私有 bucket（默认 `aibid-dev`）后退出，退出码为 0 属于正常状态。API 等待 PostgreSQL 与 bucket 就绪；worker 再等待 API 健康、Redis 健康和 bucket 初始化成功。Redis 使用 AOF `everysec` 和持久卷覆盖本地容器重启，但这不构成生产灾难恢复承诺。

整套服务启动后，可从仓库根目录执行 `node deploy/full-stack-smoke.mjs`，通过 HTTP 验证 API、outbox、Redis、独立 `worker:prod`、S3、PostgreSQL，以及真实 TXT 确定性证据的完整链路。

## 启动前端

另开终端：

```bash
cd frontend
npm ci
npm run dev
```

前端默认地址为 `http://localhost:4173`。默认数据源仍是 Mock 和 `localStorage`；设置 `VITE_DATA_SOURCE=api` 后可联调项目、上传、任务轮询、真实证据展示与人工确认，契约见 [`../docs/api/openapi.yaml`](../docs/api/openapi.yaml)。

## 常用命令

查看服务状态：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

查看 API 与 worker 日志：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f api worker
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
REDIS_URL=redis://localhost:6379/0
REDIS_STREAM_KEY=aibid:parse-tasks
REDIS_CONSUMER_GROUP=aibid-parser
REDIS_CLAIM_IDLE_MS=60000
WORKER_ID=worker-local-1
WORKER_CONCURRENCY=2
PARSER_TIMEOUT_MS=60000
PARSER_MAX_OLD_GENERATION_SIZE_MB=256
TASK_LEASE_MS=30000
TASK_HEARTBEAT_MS=10000
TASK_MAX_ATTEMPTS=3
TASK_RETRY_BACKOFF_MS=1000
OUTBOX_POLL_INTERVAL_MS=250
OUTBOX_LEASE_MS=10000
OUTBOX_BATCH_SIZE=20
```

首次启动先执行迁移。一个终端运行 API，另一个终端运行 worker：

```bash
cd backend
npm ci
npm run db:migrate
npm run dev
```

```bash
cd backend
npm run worker
```

后端脚本使用 Node.js 24 的 `--env-file-if-exists=.env` 加载该文件。没有 `.env` 时 API 仍可用默认内存模式启动并在进程内执行开发解析器；独立 worker 只用于 PostgreSQL + S3 + Redis 模式。

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

`0003_durable_worker.sql` 增加 outbox、任务尝试次数、租约、fencing token 和重试调度字段，并为升级前的 `queued` 任务回填事件。旧版本应用不会发布新 outbox；若需要应用回滚，应先停止 API 与 worker、等待或人工处置运行中任务，再回滚应用。迁移字段和 outbox 记录应保留，不能通过删除表或列回滚。

`0004_real_document_parser.sql` 扩展任务类型和 requirement 证据约束，增加 confidence，同时保留历史 `development-document-parse` / `development-fixture` 行。应用回滚不得删除真实证据列或放宽 lineage；旧应用若不能读取新任务类型，应先停止新上传并完成兼容性评估。

S3 模式的新行不再保存 `content`，因此已有新上传后不能直接降级到只认识 `bytea` 的旧版本。共享环境若需回滚，必须先暂停上传并选择其一：使用经校验的工具把 S3 原件回填到 `content`，或恢复升级前数据库与对象存储的一致快照。当前尚未提供自动回填工具，所以这套 Compose 仍只定位为本地开发环境，不能声称具备生产级回滚能力。

## 配置说明

- Compose 的后端构建上下文是 `../backend`，不要把 `Dockerfile` 或依赖复制到 `deploy/`。
- API 在 Compose 中固定使用 `REPOSITORY_DRIVER=postgres`、`OBJECT_STORAGE_DRIVER=s3` 和 `MIGRATE_ON_START=true`，用于本地持久化验证；S3 故障不会静默回退到数据库字节或内存。
- API 只在数据库事务内创建任务与 outbox，不配置 `REDIS_URL`，因此 Redis 故障不会破坏已提交上传。Redis 恢复后由 worker 继续 relay。
- worker 同时运行 outbox relay 与 Redis consumer。消息可能重复投递；业务结果必须由任务状态和 lease token 的数据库条件写保护。
- `MAX_UPLOAD_BYTES` 默认且最多为 25 MiB；部署只能收紧，服务端限制始终优先于前端提示。
- `DEV_TENANT_ID` 只是本地租户上下文，不是认证。不得将此模式部署到生产。
- `x-tenant-id` 可在开发请求中临时覆盖租户以验证隔离；它不是身份凭证，生产环境必须禁用。
- `S3_*` 由 API 用于新上传原件；对象键由服务端按租户、项目和文件 ID 生成，不包含原文件名。
- `TASK_HEARTBEAT_MS` 必须小于 `TASK_LEASE_MS`，`REDIS_CLAIM_IDLE_MS` 必须大于或等于 `TASK_LEASE_MS`；同时运行多个 worker 时 `WORKER_ID` 必须唯一。
- `WORKER_CONCURRENCY` 控制单进程并发；`TASK_MAX_ATTEMPTS` 与 `TASK_RETRY_BACKOFF_MS` 控制自动重试；outbox 的 poll、lease 和 batch 参数控制 relay 吞吐与接管窗口。
- `PARSER_TIMEOUT_MS` 与 `PARSER_MAX_OLD_GENERATION_SIZE_MB` 是 worker-only 配置；超时、资源上限、格式损坏、加密 PDF 和 OCR-required 均按永久解析错误持久化。
- `project_files.content bytea` 只兼容迁移前旧行。删除该列前必须完成对象回填、SHA-256 校验、备份与回滚演练。
- API 当前仍将最多 25 MiB 的 multipart 文件读入内存后写 S3；这完成了持久化边界切换，不代表已支持大文件流式或分片上传。

## 密钥与生产边界

- `.env`、私钥、云访问密钥和数据库备份不得提交。仓库只保留 `.env.example`。
- 示例密码仅为本地占位符；共享环境必须由部署平台的密钥管理能力注入高强度凭据。
- Bucket 保持私有，浏览器不接触永久 S3 凭据；日志不得记录原件内容、凭据或带签名的 URL。
- API 上传入口完成扩展名、非空、大小和 SHA-256 校验；隔离解析器进一步校验扩展名/MIME 配对与格式结构。恶意文件扫描和保留策略完成前不可作为生产上传网关。
- 真实 locator 可证明提取结果对应规范化文本及格式锚点，但当前没有原件 viewer/download 或已验证高亮，也没有生产语料阈值；不得把一次任务成功解释为生产准确率证明。
- 本 Compose 没有 TLS、高可用、备份、网络隔离、监控或滚动升级能力，不可直接作为生产部署方案。
- 生产数据库迁移应作为受控发布步骤执行，不建议使用 `MIGRATE_ON_START=true`。

## 配置校验

无需启动容器即可展开并校验 Compose：

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet
```

完整架构、任务状态机与阶段边界见 [`../docs/MVP_TECHNICAL_DESIGN.md`](../docs/MVP_TECHNICAL_DESIGN.md)，可靠交付决策见 [`../docs/adr/0001-durable-task-delivery.md`](../docs/adr/0001-durable-task-delivery.md)。
