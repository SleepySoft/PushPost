# 内容仓库与 Metadata 设计

本文定义 PushPost 内容仓库协议 v1。这里描述的是**文章仓库**，不是 PushPost 应用自身的代码目录。当前状态为 Proposed；现有仓库通过显式迁移进入该协议。

## 设计目标

- 普通 Git 工具可以直接阅读和修改文章。
- 分类来自目录，文章正文与私有资源可以一起移动。
- 文章、分类和平台目标都有稳定标识，重命名不会丢失关联。
- 每篇文章的元数据只保存一次，不在 Front Matter 和中央文件中双写。
- Decap 与自研服务读取同一份配置，失败时给出可定位的校验错误。
- Git 中不出现平台密钥、远端文章 ID、任务日志等运行数据。

## 目录结构

```text
<content-repository>/
├── content/
│   ├── technology/
│   │   ├── docker-notes/
│   │   │   ├── index.md
│   │   │   └── assets/
│   │   │       ├── cover.png
│   │   │       └── network.png
│   │   └── kubernetes-notes/
│   │       └── index.md
│   └── life/
│       └── reading-2026/
│           ├── index.md
│           └── assets/
│               └── cover.jpg
└── metadata/
    ├── pushpost.yml
    ├── categories.yml
    ├── platforms.yml
    └── redirects.yml
```

### 规则

1. `content/<category>/<article>/index.md` 是唯一采用的文章形态。
2. v1 的 `<category>` 只有一级，不支持多级分类目录；跨分类检索使用标签。
3. 每篇文章一个目录，正文固定命名为 `index.md`，避免正文和图片分离。
4. 文章图片放在该目录的 `assets/` 中，正文和 Front Matter 使用 `./assets/...` 相对路径。
5. 文章目录名是人类可读标识，但不是文章 ID，也不是公开 URL 的唯一依据。
6. 分类必须登记在 `metadata/categories.yml`；未登记目录中的文章校验失败，不静默上线。
7. `metadata/` 下不保存第二份文章正文或逐篇文章元数据。
8. 首版不支持符号链接、Git 子模块、文章内容内的可执行脚本和绝对本地路径。
9. 路径按不区分大小写的方式检查冲突，避免 Windows、macOS 和 Linux 行为不同。
10. 非 `index.md` 的 Markdown、临时文件和编辑器备份文件不能被当作文章发布。

暂不支持多篇文章共享媒体库。确有共享资源时，后续增加独立协议，不使用 `../../other-article/assets/...` 跨文章引用。

## 职责划分

| 数据 | 保存位置 | 原因 |
| --- | --- | --- |
| 正文、标签、摘要、生命周期 | 文章 `index.md` | 与文章一起评审和迁移 |
| 文章图片 | 文章 `assets/` | 跟随文章移动和删除 |
| 协议版本、站点默认区域设置 | `metadata/pushpost.yml` | 仓库级公共配置 |
| 分类目录与展示信息 | `metadata/categories.yml` | 避免每篇文章重复分类配置 |
| 平台目标的非敏感配置 | `metadata/platforms.yml` | 多篇文章复用目标账号 |
| 历史 URL 重定向 | `metadata/redirects.yml` | URL 策略需要版本管理 |
| 部署结果、任务状态、远端 ID/URL | PushPost 状态存储 | 属于运行结果，不是作者意图 |
| 令牌、私钥、Cookie | 服务端密钥存储 | 防止进入 Git 历史 |

## `metadata/pushpost.yml`

仓库协议入口和默认值：

```yaml
schema_version: 1
site:
  default_lang: zh-CN
  timezone: Asia/Shanghai
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `schema_version` | 是 | v1 固定为整数 `1`；不支持的版本必须拒绝处理 |
| `site.default_lang` | 是 | BCP 47 语言标签，文章可通过 `lang` 覆盖 |
| `site.timezone` | 是 | IANA 时区名，用于界面展示；存储时间仍使用带偏移量的时间戳 |

仓库地址、发布分支、构建命令和部署目录属于服务端环境配置，不写在这里，避免内容编辑者改变部署目标。

## `metadata/categories.yml`

```yaml
categories:
  - id: technology
    directory: technology
    name: 技术
    slug: tech
    description: 技术与工程实践
    order: 10
    hidden: false
  - id: life
    directory: life
    name: 生活
    slug: life
    description: 阅读与生活记录
    order: 20
    hidden: false
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 分类稳定 ID，全仓库唯一，重命名目录时保持不变 |
| `directory` | 是 | `content/` 下的单级目录名，全仓库唯一 |
| `name` | 是 | 展示名称 |
| `slug` | 是 | 分类 URL 片段，全站唯一，不与其他路由冲突 |
| `description` | 否 | 分类介绍和默认 SEO 描述 |
| `order` | 否 | 非负整数，默认 `0`；同值时按名称排序 |
| `hidden` | 否 | 默认 `false`；仅隐藏分类导航，不直接隐藏其中文章 |

文章的分类由其父目录决定，不在 Front Matter 再写 `category`。移动文章到另一个已登记目录即完成改分类，文章 `id` 不变。

`hidden: true` 不是访问控制。若分类内文章仍允许公开，知道 URL 的读者仍能访问。

## `metadata/platforms.yml`

这里定义“可以同步到哪里”，文章 Front Matter 定义“这篇文章是否使用它”。

```yaml
targets:
  wechat-main:
    type: wechat
    enabled: true
    credential_ref: pushpost/wechat-main
    defaults:
      mode: draft
      trigger: auto
  wordpress-main:
    type: wordpress
    enabled: true
    credential_ref: pushpost/wordpress-main
    defaults:
      mode: published
      trigger: manual
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| 目标别名，如 `wechat-main` | 是 | 稳定且全仓库唯一；文章通过别名引用目标 |
| `type` | 是 | 已注册适配器类型，不等于目标别名 |
| `enabled` | 否 | 默认 `true`；`false` 禁止创建新任务，不删除历史记录 |
| `credential_ref` | 视适配器而定 | 服务端密钥的逻辑引用，不是令牌本身 |
| `defaults.mode` | 否 | `draft` 或 `published`，文章可覆盖 |
| `defaults.trigger` | 否 | `auto` 或 `manual`，文章可覆盖 |

适配器的额外非敏感配置放在对应目标的 `options` 下，并由该适配器的 schema 校验。目标别名一旦投入使用不应修改；显示名称可以放在 `options` 或服务端账号配置中。

禁用目标后，已有远端文章保持不变。凭据轮换只修改服务端密钥，不需要提交内容仓库。

## `metadata/redirects.yml`

```yaml
redirects:
  - from: /blog/old-docker-notes/
    article_id: 01J8K2M7Q4N6V8R0T2W4Y6Z8A0
    status: 301
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `from` | 是 | 旧站内绝对路径，必须以 `/` 开头，全表唯一 |
| `article_id` | 是 | 指向现有文章稳定 ID，始终跳转其当前 slug |
| `status` | 否 | v1 仅允许 `301` 或 `302`，默认 `301` |

不允许重定向到任意外部 URL，避免该文件被利用为开放重定向配置。形成循环、与现有文章路由冲突或指向不存在文章的配置必须校验失败。

修改 slug 时，应在同一提交中添加旧路径。v1 是否采用“文章 URL 含分类”由路由实现决定，但重定向必须记录完整旧路径，不能仅保存旧 slug。

## 文章 Front Matter

### 完整示例

`content/technology/docker-notes/index.md`：

```markdown
---
id: 01J8K2M7Q4N6V8R0T2W4Y6Z8A0
title: Docker 笔记
slug: docker-notes
summary: 容器构建、网络与日常使用经验
status: published
published_at: 2026-10-26T09:00:00+08:00
lang: zh-CN
tags:
  - docker
  - devops
cover: ./assets/cover.png
canonical_url: null
distribution:
  - target: wechat-main
  - target: wordpress-main
    mode: draft
    trigger: manual
---

正文从一级标题以下的内容开始，图片使用相对路径：

![网络结构](./assets/network.png)
```

### 字段定义

| 字段 | 必填 | 类型与默认值 | 语义 |
| --- | --- | --- | --- |
| `id` | 是 | 字符串，无默认值 | 永久文章 ID，推荐 ULID/UUID；全仓库唯一，创建后不可修改 |
| `title` | 是 | 非空字符串 | 展示标题和默认平台标题 |
| `slug` | 是 | 字符串 | 主站文章 URL 片段，全站唯一 |
| `summary` | 否 | 字符串，默认空 | 摘要；平台可要求必填或长度限制 |
| `status` | 是 | 枚举 | `draft`、`published` 或 `archived` |
| `published_at` | 否 | RFC 3339 时间或 `null` | 立即/计划发布时间及声明的首次发布时间 |
| `lang` | 否 | 字符串，继承站点默认值 | 文章语言 |
| `tags` | 否 | 字符串数组，默认 `[]` | 跨分类标签，去重且忽略首尾空白 |
| `cover` | 否 | 相对路径或 `null` | 封面，必须指向当前文章 `assets/` 内的已允许资源 |
| `canonical_url` | 否 | 绝对 HTTP(S) URL 或 `null` | 原文规范地址；空时由主站生成自身 canonical |
| `distribution` | 否 | 目标配置数组，默认 `[]` | 外部分发意图，不包含执行结果 |

### 命名约束

- `slug`、分类 `directory`、分类 `slug` 使用小写 ASCII 字母、数字和连字符，必须以字母或数字开头和结尾。
- 平台目标别名使用同样的安全字符集。
- `id` 不由路径计算，不在重命名时重新生成。
- 标题和标签允许 Unicode；slug 不直接使用中文拼音自动覆盖作者已设置的值。
- 所有数组禁止含义不明的重复项；`distribution` 中同一目标只能出现一次。

### 时间语义

`status` 与 `published_at` 共同决定主站可见性：

| 条件 | 主站行为 | 自动外部分发 |
| --- | --- | --- |
| `draft` | 不公开 | 不自动执行 |
| `published` + `published_at: null` | 可立即公开 | 主站成功后可执行 |
| `published` + 过去/当前时间 | 可立即公开 | 主站成功后可执行 |
| `published` + 未来时间 | 到点前不公开 | 到点前不执行 |
| `archived` | 下架 | 不自动执行，也不自动删除远端文章 |

`published_at` 必须带 `Z` 或 UTC 偏移量，禁止没有时区的本地时间。普通内容更新不自动修改它；实际部署时间和平台发布时间以运行记录为准。

计划发布到点不需要新增 commit。定时校准必须扫描已到期的内容快照并触发构建，不能仅依赖 push。

### 分发项

每个分发项支持：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `target` | 是 | 必须引用 `metadata/platforms.yml` 中已定义目标 |
| `mode` | 否 | 覆盖目标默认值；`draft` 或 `published` |
| `trigger` | 否 | 覆盖目标默认值；`auto` 或 `manual` |

- `auto`：文章满足公开条件且主站部署成功后，为新增或变化内容创建同步任务。
- `manual`：只声明可用目标，由发布者在管理界面显式创建任务。
- `mode: draft`：在远端创建或更新草稿，不代表远端公开。
- `mode: published`：请求远端公开；平台不支持直接发布时按适配器能力降级为草稿或人工处理，并明确记录。
- 删除分发项表示以后不再自动同步该目标，不表示删除已经发布的远端文章。

## 正文和资源约束

- v1 以 GFM 为基础；公式、MDX 和自定义短代码只有声明启用后才能使用。
- 标题层级、摘要截断和平台转换规则由渲染器统一实现。
- 图片路径必须是文章内相对路径，解析后不能越过文章目录。
- 图片必须实际存在，扩展名、MIME 和文件大小符合配置限制。
- 首版允许常见静态图片；SVG、视频和附件需单独安全评审后启用。
- 不允许正文或元数据引用 `file://`、本地绝对路径或仓库外文件。
- 外部图片 URL 是否允许由平台适配器决定；主站资源策略应明确是否代理和缓存。

## 校验规则

每次候选构建必须在公开前完成全量结构校验：

1. 四个仓库级 metadata 文件符合各自 schema，YAML 无重复键。
2. 所有已发现文章都能关联到一个已登记分类。
3. 文章 `id`、文章 `slug`、分类 `id`、分类 `directory` 和分类 `slug` 分别满足唯一性。
4. `status`、时间、路径和分发字段合法。
5. `distribution.target` 存在且其适配器已注册。
6. 封面、正文图片和重定向目标存在，路由无冲突或循环。
7. 不允许未知 Front Matter 字段；需要扩展时先升级协议，避免拼写错误被静默忽略。
8. 校验错误至少包含源文件路径、字段、原因和源 commit。

校验失败时整次候选构建不上线，继续保留上一成功版本。不能只跳过一篇坏文章而让其他文章悄悄上线，否则删除、分类和重定向可能形成不一致版本。

## 新建、修改与删除

### 新建

Decap 或自研编辑器生成文章 ID 和目录，写入 `index.md`。`status` 默认 `draft`，`distribution` 默认空，避免创建文章即外发。

### 重命名或移动

保持 `id` 不变。修改 slug 时同步添加重定向；移动分类目录只改变主分类。资源随文章目录整体移动，相对链接无需改写。

### 删除

Git 删除文章表示从后续主站候选版本移除。数据库保留文章 tombstone、历史部署和远端映射，防止未来误重发。平台文章默认保留，远端下架必须单独操作。

### 恢复

从 Git 历史恢复文章时优先恢复原 `id`。若该 ID 已被人为分配给另一篇文章，校验失败并要求人工处理，不能自动换 ID 静默创建新内容。

## 旧仓库迁移

现有 metadata 尚未提供，因此不声称可以直接兼容。迁移采用一次显式、可审查的过程：

1. 备份仓库并扫描目录、文章、资源和现有 metadata。
2. 输出字段映射和异常报告，确认旧“发布”字段对应生命周期还是实际执行状态。
3. 保留已有稳定 ID；没有 ID 的文章生成一次并写回。
4. 将文章转换为文章目录 + `index.md`，资源移动到对应 `assets/` 并更新链接。
5. 将文章级字段集中到 Front Matter，将分类和平台公共配置拆到中央文件。
6. 旧中央文章 metadata 在迁移完成后退出读取路径，不保留长期双写。
7. 冲突项阻断迁移，由人工选择；不按“新覆盖旧”或“旧覆盖新”隐式处理。
8. 在测试分支完成全量校验和预览，再合并迁移提交。

迁移工具应可重复运行并生成相同结果，但已人工修复的冲突不能被执行器再次覆盖。

## Decap 映射要求

- 每个已登记分类对应一个 folder collection，`folder` 指向该分类目录。
- 条目路径采用 `<article>/index` 形式，不能只生成散落的 `<article>.md`。
- 新建条目的默认状态为 `draft`，ID 自动生成且编辑界面不可随意修改。
- slug、标签、封面、发布时间和分发字段与本文 schema 一致。
- 媒体保存到当前文章 `assets/`，插入相对路径。
- 分类新增、协议字段变化和 Decap 配置更新必须在同一提交中完成。
- Decap 无法表达的校验仍由 Content Pipeline 执行；后台显示“可保存”不等于“可发布”。

实现时需要用真实私有测试仓库验证 Decap 的嵌套 entry path 与媒体路径行为；若其媒体能力不能满足文章 bundle，优先增加受控定制，不改为把令牌或部署私钥暴露给浏览器。
