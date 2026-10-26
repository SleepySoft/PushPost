# PushPost 设计文档

PushPost 是一个以 GitHub 私有仓库为内容事实源的文章发布系统，提供公开内容站、基于 Decap CMS 的在线编辑，以及自研的构建部署和多平台同步能力。

## 文档导航

- [Why：背景、目标与设计原则](why.md)
- [What：范围、需求与验收标准](what.md)
- [How：架构、核心流程与实施方案](how.md)
- [内容仓库与 Metadata 设计](content-repository.md)
- [ADR：架构决策记录](adr/README.md)

## 当前设计基线

- 文章正文及其发布配置保存在 Git 仓库中。
- 自研系统负责内容同步、网站发布、运行状态、任务调度和多平台分发。
- Decap 负责第一版在线内容管理，通过 GitHub API 读写私有仓库。
- 自研编辑器作为后续演进方向，与 Decap 共用仓库协议，不改变文章格式。
- Webhook 驱动同步，定时校准补偿事件丢失。
- 主站发布与外部平台分发相互解耦，单平台失败不影响其他发布目标。

## 文档状态

当前 ADR 0001–0011 已接受并进入实现。技术基线为 Node.js 20、TypeScript、Astro、Fastify、SQLite 和 Decap，首个官方 API 适配器为 WordPress；安装和运行方式见根目录 [README](../README.md)。

真实 GitHub OAuth、生产部署目标和其他平台账号仍属于环境验收事项，不将本地实现等同于已经完成外部验收。

## 文档维护规则

1. 修改系统行为时，同步更新 Why、What 或 How 中受影响的描述。
2. 重要且难以逆转的架构变化通过新增 ADR 记录；已接受的 ADR 不被静默改写。
3. ADR 被替代时保留原文，将状态改为 `Superseded by ADR-xxxx`，并链接新决策。
4. 文档中的“必须”是验收约束，“可以”是可选能力，“暂不支持”是明确边界。
