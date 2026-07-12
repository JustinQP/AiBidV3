# AiBidV3 Web 高保真原型

企业版 AI 投标书协作平台（Web 端）。

产品围绕“招标文件导入 → 智能解析与人工确认 → 响应矩阵 → 目录规划 → 协同写作 → 评审与合规 → DOCX 导出”建立端到端闭环，重点解决要求漏项、内容无依据、多人协作混乱和正式交付不可控等问题。

## 高保真原型

本目录包含可运行、可点击的高保真 Web 原型，已覆盖：

- 项目中心与三步新建项目向导
- 项目驾驶舱、截止提醒与风险待办
- 文件上传、解析进度、异常重试和原文预览
- 智能解析、低置信度筛选、原文定位与人工确认
- 响应矩阵筛选、批量分配和章节映射
- 目录规划、章节分工与冻结门禁
- 三栏式写作工作台、AI 候选、来源追溯和提交审核
- 自动合规检查、人工评审问题和章节批准
- 正式导出门禁、导出任务和历史记录
- 1440px / 1280px 桌面适配，以及移动端只读视图

原型默认使用本地 Mock 数据和 `localStorage` 保存演示状态，不依赖真实后端。DOCX 下载用于演示交互，正式文档渲染能力需在后续研发阶段接入。

> **上传口径说明**：Mock 演示界面展示目标产品能力（含更宽的文件格式与 200 MB 级上限）；真实 API 模式仅接受数字 PDF、DOCX 和严格 UTF-8 TXT，legacy `.doc` 不支持，25 MiB 硬上限只能由服务端收紧。

默认数据源仍为 `mock`，因此后端未启动时全部演示交互保持可用。设置 `VITE_DATA_SOURCE=api` 后，项目中心、新建项目、招标文件和智能解析页面会接入 C2.1 API，覆盖：

- 获取及创建真实项目；
- 上传文件、展示实际任务进度、自动轮询和失败重试；
- 展示 `deterministic-rules-v1` 结果、置信度、精确 quote 和 PDF/DOCX/TXT locator，并逐条确认或驳回；
- 兼容历史/内存模式的 `development-fixture`，且不会把 fixture 呈现为真实证据。

真实项目暂不开放响应矩阵、目录、写作、评审和导出，以免把 Mock 能力误呈现为已经落库。`/projects/demo/*` 始终使用 Mock 数据并保留完整可点击流程。

真实 locator 当前是可校验的证据元数据；API 尚未提供原件下载，前端也没有原件 viewer 或“已验证”高亮。扫描 PDF/OCR、生产准确率语料与量化 SLO 仍属于后续能力。

## 技术栈

- React + TypeScript + Vite
- React Router
- Tailwind CSS 4 + 项目设计令牌
- Lucide React 图标
- Vitest

## 本地运行

```bash
npm install
npm run dev
```

默认地址：`http://localhost:4173`

如需联调后端，先复制环境变量示例并按本机端口调整：

```bash
cp .env.example .env.local
```

- `VITE_DATA_SOURCE=mock`：默认值，继续使用本地原型数据。
- `VITE_DATA_SOURCE=api`：启用项目、上传、解析和确认的真实 API 纵向切片。
- `VITE_API_BASE_URL`：业务 API 根路径，默认约定为 `http://localhost:3000/api/v1`。
- `VITE_API_HEALTH_URL`：不带 `/api/v1` 的健康检查端点。
- `VITE_API_TIMEOUT_MS`：请求超时毫秒数。
- `VITE_API_POLL_INTERVAL_MS`：活动解析任务的轮询间隔，默认 1500 毫秒。
- `VITE_API_TENANT_ID`：仅用于本地开发的租户上下文请求头，不等同于生产鉴权。

工程检查：

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## 建议演示路径

1. 从项目中心进入“智慧园区数字化平台建设项目”。
2. 在招标文件页重试失败文件。
3. 在智能解析页确认低置信度要求。
4. 在响应矩阵中为未映射要求分配负责人和章节。
5. 冻结目录，进入 `3.2 总体技术方案`。
6. 将 AI 候选插入正文并提交审核。
7. 关闭阻断问题并批准章节。
8. 在导出中心确认 6 项门禁全部通过，生成正式版记录。

左侧“重置演示”可以恢复初始状态。

## 相关文档

- [仓库说明](../README.md)
- [企业版 AI 投标书软件产品设计方案](../docs/PRODUCT_DESIGN.md)
