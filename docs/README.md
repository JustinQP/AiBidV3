# AiBidV3 文档索引

`docs/` 存放跨前端、后端和部署边界的产品与研发文档。应用自身的启动说明保留在各应用目录中。

## 核心文档

- [MVP 技术方案](MVP_TECHNICAL_DESIGN.md)：技术基线、系统边界、数据与租户模型、任务状态机、原文 locator、阶段计划与验收标准。
- [OpenAPI 接口契约](api/openapi.yaml)：第一阶段项目、文件上传、解析任务、提取要求和人工确认接口。
- [企业版 AI 投标书软件产品设计方案](PRODUCT_DESIGN.md)：产品范围、用户流程和高保真原型依据。
- [本地部署说明](../deploy/README.md)：Fastify API、PostgreSQL、Redis 和 MinIO 的本地编排。
- [前端原型说明](../frontend/README.md)：当前高保真原型的启动与验证。
- [后端服务说明](../backend/README.md)：API 工程、配置与开发方式。

## 文档职责

```text
docs/
├── README.md                 # 文档导航
├── PRODUCT_DESIGN.md         # 产品设计事实
├── MVP_TECHNICAL_DESIGN.md   # 跨模块技术决策与路线
└── api/
    └── openapi.yaml          # 可执行接口契约
```

后续文档按主题扩展：

- `architecture/`：架构决策记录（ADR）、模块边界和关键技术选型。
- `api/`：OpenAPI、错误码、事件和兼容策略。
- `development/`：本地开发、编码规范、测试与 fixture。
- `operations/`：发布、监控、备份、恢复和故障处理。

## 更新规则

- 接口实现变更必须同时更新 `api/openapi.yaml` 和契约测试。
- 数据边界、任务状态机、租户权限或基础设施发生变化时，更新技术方案或补充 ADR。
- 文档示例不得包含真实客户材料、生产域名、访问令牌或密钥。
- 文档中的命令应从标明的工作目录执行；前后端依赖不得安装到仓库根目录。
