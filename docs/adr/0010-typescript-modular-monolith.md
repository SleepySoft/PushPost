# ADR-0010：采用 TypeScript 模块化单体

- 日期：2026-10-26
- 状态：Accepted

## 背景

PushPost 需要共享内容协议、Markdown 转换、任务和 API 类型，同时集成 Decap、Astro 与平台 REST API。首版拆分为多个网络服务会增加部署和故障恢复成本。

## 决策

使用 Node.js 20、TypeScript 和 npm workspaces。Astro 负责静态公开站，Fastify 负责控制 API 与 worker，SQLite 负责运行状态，Decap 提供内容编辑。代码按 `apps/site`、`apps/server`、`packages/core`、`packages/adapters` 分模块，部署仍可作为单控制实例运行。

Git 子进程使用固定参数且 `shell: false`；Astro 只读取校验后的快照，不执行内容仓库脚本。SQLite 使用 WAL、显式 schema 版本和持久任务租约。

## 后果

- 共享类型和适配器接口简单，首版部署与本地验收成本较低。
- SQLite 与单 worker 组不宣称水平扩展；未来需要多实例时应重新评审任务协调和存储。
- 原生 SQLite 模块需要匹配 Node ABI。
- 公开站不依赖数据库或控制 API 才能响应静态请求。

## 备选方案

- **多语言微服务**：独立扩展能力强，但首版复杂度过高。
- **纯静态 CMS，无控制服务**：无法实现持久分发、审计和校准。
- **数据库作为正文事实源**：违背 ADR-0001。
