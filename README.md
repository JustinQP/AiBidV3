# AiBidV3

企业版 AI 投标书协作平台。

产品围绕“招标文件导入 → 智能解析与人工确认 → 响应矩阵 → 目录规划 → 协同写作 → 评审与合规 → DOCX 导出”建立端到端闭环。

## 仓库结构

```text
AiBidV3/
├── frontend/   # Web 前端与当前高保真原型
├── backend/    # Fastify API、独立 worker、开发解析适配器与数据层
├── deploy/     # 本地 Compose、基础设施与运维说明
└── docs/       # 产品、架构、接口与研发文档
```

业务代码按职责进入对应目录，仓库根目录仅保留项目级说明和通用配置。

## 当前状态

V0.1 高保真 Web 原型位于 [`frontend/`](frontend/)，默认仍使用 Mock 数据和 `localStorage`，核心演示流程不依赖后端。

阶段 C1 可靠 worker 纵向切片已经提供：

- Node.js 24 LTS + Fastify 5 API，覆盖项目、文件上传、开发解析任务、要求查询与人工确认；
- 内存和 PostgreSQL Repository，以及失败任务重试；
- PostgreSQL outbox、Redis Streams consumer group、数据库任务租约与 fencing token；
- 与 API 分离的 parser worker；PostgreSQL 模式由 worker 可靠执行，默认内存模式仍可进程内联调；
- PostgreSQL、MinIO、Redis、API 和 worker 的本地 Compose 编排；
- OpenAPI 契约和 MVP 技术方案。

当前 worker 仍调用只生成明确标记固定数据的 `DevelopmentDocumentParser`，不进行真实 PDF/DOCX 内容提取；这次交付验证的是任务可靠性，不是解析准确率。S3 模式的新上传原件进入对象存储，PostgreSQL 保存对象引用、任务和业务事实，旧 `bytea` 行仅作迁移兼容。高保真前端目前仍完全使用 Mock 数据和 `localStorage`，尚未接入这套真实 API；前后端联调是后续独立步骤。真实解析、locator、生产级认证授权和正式 DOCX 渲染也仍待后续阶段实现。

## 快速开始

运行高保真原型：

```bash
cd frontend
npm ci
npm run dev
```

默认地址：`http://localhost:4173`

运行 Phase C1 API、worker 与本地基础设施：

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

API 默认地址：`http://localhost:3000`。可按 [`backend/README.md`](backend/README.md) 的 `curl` 示例独立验证 API；当前前端不会自动切换到该数据源。详细方式及数据清理说明见 [`deploy/README.md`](deploy/README.md)。

工程检查：

```bash
cd frontend
npm run typecheck
npm run lint
npm run test
npm run build
```

## 文档导航

- [文档索引](docs/README.md)
- [产品设计方案](docs/PRODUCT_DESIGN.md)
- [MVP 技术方案](docs/MVP_TECHNICAL_DESIGN.md)
- [可靠任务交付 ADR](docs/adr/0001-durable-task-delivery.md)
- [OpenAPI 接口契约](docs/api/openapi.yaml)
- [前端原型说明](frontend/README.md)
- [后端服务说明](backend/README.md)
- [本地部署说明](deploy/README.md)
