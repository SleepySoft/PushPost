# PushPost

PushPost 将 Git 仓库中的单文件 Markdown 文章发布为静态网站，并通过 Decap、持久任务和平台适配器完成在线编辑与多平台分发。

## 已实现

- 一级目录机械分类，文章为 `content/<category>/<article>.md`。
- 严格 Front Matter/metadata 校验、GFM、安全 HTML、图片检查和稳定文章 ID。
- Git clone/fetch/checkout、签名 Webhook、定时校准和计划发布。
- Astro 文章、分类、标签、归档、RSS、SEO 和重定向页面。
- 候选版本构建、原子切换、失败保留旧站和回滚。
- SQLite 内容索引、快照、部署、任务、远端映射、用户会话和审计。
- 登录、角色、CSRF 防护和管理界面。
- Decap 本地 Git/GitHub backend 配置。
- WordPress REST 与通用 ZIP 导出适配器，持久租约、重试、幂等和人工登记。
- 快照资源缓存，旧任务不会因后续 checkout 读到新图片。

设计文档入口：[docs/README.md](docs/README.md)。仓库协议：[docs/content-repository.md](docs/content-repository.md)。

## 环境要求

- Node.js 20 或兼容的更新 LTS。
- npm 10+。
- Git。
- 生产 Git 同步可使用 GitHub SSH Deploy Key；Decap 使用独立 GitHub API 认证。
- 真实 WordPress 分发需要启用 REST API 和应用密码。

## 安装与检查

```bash
npm install
npm run build
npm run typecheck
npm run lint
```

`npm run build` 未指定内容快照时会构建空 Astro 站；服务实际部署始终传入已校验快照。

## 本地启动

```bash
export PUSHPOST_CONTENT_ROOT="$PWD/examples/content-repository"
export PUSHPOST_DATA_DIR="$PWD/var/dev"
export PUSHPOST_ADMIN_EMAIL="admin@example.com"
export PUSHPOST_ADMIN_PASSWORD="local-only-change-me"
export PUSHPOST_SESSION_SECRET="local-only-session-secret-change-me-32-chars"

npm run build
npm start
```

打开：

- 公开站：`http://127.0.0.1:3000/`
- 管理后台：`http://127.0.0.1:3000/admin`
- Decap：`http://127.0.0.1:3000/admin/decap`

示例管理员密码只用于本地，必须替换。服务不自动读取 `.env`；可通过环境管理工具加载 `.env.example` 中的配置，不要将真实 `.env` 提交到 Git。

启动时自动执行一次同步，之后按 `PUSHPOST_RECONCILE_INTERVAL_MS` 校准。示例文章声明了自动 `export` 目标，worker 会生成 ZIP，后台可下载并登记人工发布结果。

## 连接 Git 内容仓库

不要设置 `PUSHPOST_CONTENT_ROOT`，改为：

```bash
export PUSHPOST_REMOTE_URL="git@github.com:SleepySoft/your-content.git"
export PUSHPOST_BRANCH="main"
export PUSHPOST_REPOSITORY_ID="your-content"
export PUSHPOST_WORK_DIR="$PWD/var/repository"
export PUSHPOST_DATA_DIR="$PWD/var/production"
```

远端 HEAD 是同步依据。Webhook 只是触发通知，定时校准会补偿漏事件和到期的计划发布。

GitHub Webhook 配置：

```text
Payload URL: https://your-host/api/webhooks/github
Content type: application/json
Secret: PUSHPOST_WEBHOOK_SECRET
Events: push
PUSHPOST_WEBHOOK_REPOSITORY: SleepySoft/your-content
```

服务验证原始请求体的 `X-Hub-Signature-256`，并检查事件 GUID、仓库和分支。

## Decap

本地开发使用 Decap local backend，需要在实际 Git 内容仓库目录启动 `decap-server`，再访问 `/admin/decap`。生产配置：

```bash
export PUSHPOST_DECAP_GITHUB_REPO="SleepySoft/your-content"
export PUSHPOST_DECAP_GITHUB_BRANCH="main"
export PUSHPOST_DECAP_BASE_URL="https://your-oauth-provider"
```

Decap 的 GitHub 用户仍需符合所选 OAuth/backend 的仓库权限模型。SSH 私钥不会提供给浏览器。新增目录会自动成为主站分类；需要 Decap 编辑时，在同步后生成对应 collection。

## 内容协议

最小配置：

```yaml
# metadata/pushpost.yml
schema_version: 1
site:
  default_lang: zh-CN
  timezone: Asia/Shanghai
```

```yaml
# metadata/platforms.yml
targets:
  manual-export:
    type: export
    defaults: { mode: draft, trigger: auto }
```

```yaml
# metadata/redirects.yml
redirects: []
```

文章状态为 `draft`、`published` 或 `archived`。`published_at: null` 表示可立即公开，未来时间表示计划发布。文章 `id` 不应改变；slug 全站唯一。

## WordPress

内容仓库只保存非敏感配置：

```yaml
targets:
  wordpress-main:
    type: wordpress
    credential_ref: pushpost/wordpress-main
    options:
      baseUrl: https://wordpress.example.com
    defaults:
      mode: draft
      trigger: auto
```

对应服务端凭据：

```bash
export PUSHPOST_PUSHPOST_WORDPRESS_MAIN_USERNAME="editor"
export PUSHPOST_PUSHPOST_WORDPRESS_MAIN_APP_PASSWORD="application-password"
```

`baseUrl` 也可通过 `PUSHPOST_PUSHPOST_WORDPRESS_MAIN_BASE_URL` 提供。平台创建超时且结果未知时进入人工核对，不会盲目重复创建文章。

## 常用管理 API

所有 `/api/admin/*`（登录除外）需要会话；修改操作还需要 CSRF token 和相应角色。

- `POST /api/admin/sync`：立即同步。
- `POST /api/admin/rollback`：回滚到指定或上一成功版本。
- `GET/POST /api/admin/tasks`：查询或创建分发任务。
- `POST /api/admin/tasks/:id/retry|cancel`：重试或取消。
- `GET /api/admin/exports/:taskId/download`：下载导出包。
- `POST /api/admin/exports/:taskId/result`：登记人工远端结果。
- `GET /api/admin/deployments|audit|metrics`：部署、审计和指标。

## 数据与恢复

`PUSHPOST_DATA_DIR` 包含 SQLite、快照资源、release、导出包和临时文件。公开站只读取当前成功 release。

- Git 可以重建正文索引，但不能恢复远端文章映射、任务或审计。
- 备份时使用 SQLite 在线备份或同时安全复制数据库及 WAL，不要只复制正在写入的主 db 文件。
- 回滚不会删除外部平台文章；远端下架是独立操作。
- 生产环境应使用 HTTPS、独立密钥管理和受限构建进程。

## 当前外部验收边界

仓库内的本地内容、真实 Git 进程、HTTP 服务、SQLite、Astro 和导出流程可以离线验收。真实 GitHub 私有仓库、Decap OAuth、生产 SSH/部署环境及 hosted WordPress 仍需对应凭据和测试账号，不能由本地验证替代。
