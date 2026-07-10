# AiBidV3

企业版 AI 投标书协作平台。

产品围绕“招标文件导入 → 智能解析与人工确认 → 响应矩阵 → 目录规划 → 协同写作 → 评审与合规 → DOCX 导出”建立端到端闭环。

## 仓库结构

```text
AiBidV3/
├── frontend/   # Web 前端与当前高保真原型
├── backend/    # 后端服务、任务与数据层（预留）
├── deploy/     # 部署配置、基础设施与运维说明（预留）
└── docs/       # 产品、架构、接口与研发文档
```

业务代码按职责进入对应目录，仓库根目录仅保留项目级说明和通用配置。

## 当前状态

V0.1 高保真 Web 原型已迁移至 [`frontend/`](frontend/)，使用本地 Mock 数据和 `localStorage` 保存演示状态，不依赖真实后端。后端接口、异步任务、权限、解析服务和正式 DOCX 渲染将在后续研发阶段接入。

## 快速开始

```bash
cd frontend
npm install
npm run dev
```

默认地址：`http://localhost:4173`

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
- [前端原型说明](frontend/README.md)
- [后端目录说明](backend/README.md)
- [部署目录说明](deploy/README.md)

