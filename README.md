# AiBidV3

企业版 AI 投标书协作平台。

产品围绕“招标文件导入 → 智能解析与人工确认 → 响应矩阵 → 目录规划 → 协同写作 → 评审与合规 → DOCX 导出”建立端到端闭环。

## 仓库结构

```text
AiBidV3/
├── frontend/   # Web 前端与当前高保真原型
├── backend/    # Fastify API、开发解析适配器与 PostgreSQL 数据层
├── deploy/     # 本地 Compose、基础设施与运维说明
└── docs/       # 产品、架构、接口与研发文档
```

业务代码按职责进入对应目录，仓库根目录仅保留项目级说明和通用配置。

## 当前状态

V0.1 高保真 Web 原型位于 [`frontend/`](frontend/)，默认仍使用 Mock 数据和 `localStorage`，核心演示流程不依赖后端。

第一阶段研发基线已经提供：

- Node.js 24 LTS + Fastify 5 API，覆盖项目、文件上传、开发解析任务、要求查询与人工确认；
- 内存和 PostgreSQL Repository，以及失败任务重试；
- PostgreSQL、Redis、MinIO 的本地 Compose 编排；
- OpenAPI 契约和 MVP 技术方案。

当前解析器只生成明确标记的固定开发数据，不读取真实文件；上传内容暂存 PostgreSQL `bytea`。前端已接通“项目创建 → 文件上传与任务轮询 → 解析结果 → 人工确认/驳回”的真实 API 纵向切片，默认仍使用 Mock 数据以保留完整演示流程。生产级认证授权、S3 文件存储、独立 worker、真实解析和正式 DOCX 渲染仍待后续阶段实现。

## 快速开始

运行高保真原型：

```bash
cd frontend
npm ci
npm run dev
```

默认地址：`http://localhost:4173`

如需验证真实 API 纵向切片，先启动后端，再复制 `frontend/.env.example` 为 `frontend/.env.local`，将 `VITE_DATA_SOURCE` 改为 `api` 后启动前端。API 模式目前只开放真实项目的“招标文件”和“智能解析”；`/projects/demo/*` 始终保留完整 Mock 演示。

运行第一阶段 API 与本地基础设施：

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

API 默认地址：`http://localhost:3000`。详细方式及数据清理说明见 [`deploy/README.md`](deploy/README.md)，零依赖内存模式见 [`backend/README.md`](backend/README.md)。

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
- [OpenAPI 接口契约](docs/api/openapi.yaml)
- [前端原型说明](frontend/README.md)
- [后端服务说明](backend/README.md)
- [本地部署说明](deploy/README.md)
