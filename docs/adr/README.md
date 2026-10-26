# 架构决策记录

ADR 用于记录影响系统边界、数据一致性、安全或长期演进的关键决定。当前 0001–0011 均为 `Accepted`，后续决策先以 `Proposed` 评审。

## 索引

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-git-as-content-source-of-truth.md) | 以 Git 作为内容事实源 | Accepted |
| [0002](0002-decap-with-custom-publishing-services.md) | 采用 Decap 与自研发布服务的组合 | Accepted |
| [0003](0003-separate-desired-and-observed-state.md) | 分离期望状态与运行状态 | Accepted |
| [0004](0004-webhook-with-scheduled-reconciliation.md) | Webhook 与定时校准双通道同步 | Accepted |
| [0005](0005-stable-identity-and-lifecycle-metadata.md) | 使用稳定文章 ID 和显式生命周期元数据 | Accepted |
| [0006](0006-idempotent-platform-adapters.md) | 通过异步任务和适配器实现幂等分发 | Accepted |
| [0007](0007-split-github-api-and-ssh-access.md) | 分离 GitHub API 编辑通道与 SSH 部署通道 | Accepted |
| [0008](0008-atomic-site-deployment-and-failure-isolation.md) | 主站原子部署并隔离外部分发失败 | Accepted |
| [0009](0009-versioned-content-repository-layout.md) | 采用版本化的文章目录与元数据协议 | Accepted |
| [0010](0010-typescript-modular-monolith.md) | 采用 TypeScript 模块化单体 | Accepted |
| [0011](0011-static-routes-and-release-pointer.md) | 固定文章路由并使用原子 release 指针 | Accepted |

## 新 ADR 格式

```markdown
# ADR-xxxx：标题

- 日期：YYYY-MM-DD
- 状态：Proposed | Accepted | Deprecated | Superseded by ADR-yyyy

## 背景
## 决策
## 后果
## 备选方案
```

一条 ADR 只解决一个主要问题。决策变化时新增 ADR，不删除历史记录。
