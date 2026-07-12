# AiBidV3

企业版 AI 投标书协作平台。

产品围绕“招标文件导入 → 智能解析与人工确认 → 响应矩阵 → 目录规划 → 协同写作 → 评审与合规 → DOCX 导出”建立端到端闭环。

## 仓库结构

```text
AiBidV3/
├── frontend/   # Web 前端与当前高保真原型
├── backend/    # Fastify API、独立 worker、隔离文档解析器与数据层
├── deploy/     # 本地 Compose、基础设施与运维说明
└── docs/       # 产品、架构、接口与研发文档
```

业务代码按职责进入对应目录，仓库根目录仅保留项目级说明和通用配置。

## 当前状态

V0.1 高保真 Web 原型位于 [`frontend/`](frontend/)，默认仍使用 Mock 数据和 `localStorage`，核心演示流程不依赖后端。

阶段 C1 可靠 worker 与 C2.1 数字文档解析纵向切片已经提供：

- Node.js 24 LTS + Fastify 5 API，覆盖项目、文件上传、异步解析任务、要求查询与人工确认；
- 内存和 PostgreSQL Repository，以及失败任务重试；
- PostgreSQL outbox、Redis Streams consumer group、数据库任务租约与 fencing token；
- 与 API 分离的 durable worker；PostgreSQL 新上传使用 `document-parse-v1`，并在受限 Worker thread 中解析数字 PDF、DOCX 和严格 UTF-8 TXT；
- `deterministic-rules-v1` 要求提取，以及带版本、源文件哈希、引用哈希和格式锚点的 PDF/DOCX/TXT locator；
- 默认内存模式与历史任务继续使用明确标记的 `development-fixture`，保持零依赖联调和旧数据兼容；
- PostgreSQL、MinIO、Redis、API 和 worker 的本地 Compose 编排；
- OpenAPI 契约和 MVP 技术方案。

C2.1 只覆盖带文本层的数字 PDF、DOCX 和严格 UTF-8 TXT，不包含扫描件/OCR、legacy `.doc` 或模型判定。S3 模式的新上传原件进入对象存储，PostgreSQL 保存对象引用、任务和业务事实，旧 `bytea` 行仅作迁移兼容。高保真前端默认仍使用 Mock 数据和 `localStorage`，设置 API 数据源后可联调项目、上传、真实证据展示与人工确认。

当前 locator 是可校验的证据元数据，不等于已经提供原件下载、原件 viewer 或“已验证”高亮；这些交互以及生产准确率语料、量化 SLO、生产级认证授权和正式 DOCX 渲染仍属于后续门禁。

## 快速开始

运行高保真原型：

```bash
cd frontend
npm ci
npm run dev
```

默认地址：`http://localhost:4173`

运行 Phase C2.1 API、worker 与本地基础设施：

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

API 默认地址：`http://localhost:3000`。可按 [`backend/README.md`](backend/README.md) 的示例独立验证 API；前端需要显式设置 `VITE_DATA_SOURCE=api`，不会自动切换数据源。详细方式及数据清理说明见 [`deploy/README.md`](deploy/README.md)。

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
