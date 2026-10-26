# 开发与本地运行

[返回项目首页](../README.md) · [English overview](README.en.md)

本指南面向运行源码的开发者。产品介绍和用户准备项见项目首页；PLA 和 Gateway 需要独立配置。

## 1. 环境与依赖

- Node.js 与 Corepack；pnpm 版本以根目录 `package.json` 的 `packageManager` 为准。
- MongoDB 和 Redis：由当前开发环境提供可访问的实例。
- MinIO：用于头像对象存储，提前创建配置的 bucket。
- TMDB 访问凭据：用于电影与剧集元数据。
- 编译 PLA 时额外安装 Tauri 所需的系统工具链与 Rust，见 [Agent README](../apps/helpers/agent/README.md)。

本仓库不提供一条命令自动部署全部基础设施的 Compose 配置。

## 2. 配置应用

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

至少配置以下分组。完整字段、默认值和校验以 [环境样例](../.env.example) 及 [API 配置 Schema](../apps/api/src/config/env.schema.ts) 为准。

| 分组 | 主要配置 |
| --- | --- |
| 数据库 | `MONGODB_URI`、`MONGODB_DB_NAME` |
| Redis | `REDIS_URL`、可选的 `REDIS_KEY_PREFIX` |
| 会话 | `SESSION_TOKEN_PEPPER`，至少 32 字符的随机值 |
| 集成凭据加密 | `INTEGRATION_SECRET_KEY`，独立随机值，至少 32 字符 |
| 对象存储 | `MINIO_ENDPOINT`、`MINIO_PORT`、`MINIO_USE_SSL`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET` |
| 元数据 | `TMDB_READ_ACCESS_TOKEN` |
| 网站地址 | `WEB_ORIGIN`；默认开发地址为 `http://localhost:5173` |

`MINIO_ENDPOINT` 只填写主机名或 IP，端口和 TLS 分别配置。应用不自动创建 bucket；缺少必需配置或基础设施连接失败时，启动会失败。

不要复用会话随机值作为集成加密密钥。已有数据使用的 `INTEGRATION_SECRET_KEY` 变更后，原凭据将无法解密；不要在已有环境随意替换。

若需要完整的注册验证邮件流程，还需填写 `MAILGUN_*` 相关配置。OpenAI API Key、资源站和下载器凭据由用户登录后在设置中配置。

## 3. 启动网站与 API

```bash
corepack pnpm --filter @movie-hub/contract build
corepack pnpm --parallel --filter @movie-hub/api --filter @movie-hub/web dev
```

| 服务 | 默认地址 |
| --- | --- |
| Web | `http://localhost:5173` |
| API | `http://localhost:3000/api/v1` |
| 存活检查 | `http://localhost:3000/api/v1/health/live` |
| 就绪检查 | `http://localhost:3000/api/v1/health/ready` |

Vite 将 `/api` 转发到 `http://localhost:3000`。可用 `VITE_API_PROXY_TARGET` 覆盖开发代理目标。Web 开发服务器绑定 `0.0.0.0`；如从其他设备访问，需要让站点来源与 API 的 `WEB_ORIGIN` 配置匹配。

## 4. 可选连接

### 公网直连下载器

确保 Popular API 能访问目标下载器的 Web API，登录后添加下载器地址与认证信息。资源下载仍需要自己配置受支持的资源站账号。

### 本地设备与 PLA

先按 [Gateway 指南](../apps/helpers/gateway/README.md) 配置 Gateway，再在应用 `.env` 配置：

- `REMOTE_GATEWAY_BASE_URL`：Gateway 对外提供的服务地址。
- `REMOTE_GATEWAY_SERVICE_TOKEN`：与 Gateway 的 `INTERNAL_INBOUND_TOKEN` 一致的服务凭据。

服务凭据与用户设备 API Key 是不同用途，不能混用。Gateway 有独立的环境文件和签名密钥配置，不能只填写应用 `.env` 就视为完成部署。

然后按 [PLA 指南](../apps/helpers/agent/README.md) 构建或运行客户端，填写 Gateway 地址和用户 API Key 完成设备绑定，再配置下载器。

根目录的 `pnpm dev` 会同时启动 Gateway、API 和 Web；只有在 Gateway 环境也配置完成后才使用该命令。

### 消息与智能助手

| 功能 | 配置位置与条件 |
| --- | --- |
| Telegram | 部署端配置 `TELEGRAM_BOT_TOKEN`，用户在网站完成绑定；Bot 不应被其他轮询程序或 webhook 同时占用。 |
| WhatsApp | 用户通过网站设置完成 WhatsApp 连接与绑定。 |
| 智能助手 | 用户配置自己的 OpenAI API Key 与模型；消息渠道需要另外完成绑定。 |
| Web 助手页面 | 由 `PAGE_AI_ASSISTANT_ENABLED` 控制，且只在开发、测试等允许环境开放；生产环境关闭该实验页面。 |
| 资源可用通知 | `RESOURCE_NOTIFICATION_INTERVAL_MS` 默认 `10800000`，即 3 小时；不是资源发布后的即时推送。 |

## 5. 验证与诊断

```bash
corepack pnpm check
corepack pnpm test
corepack pnpm build
```

这些命令覆盖整个工作区。测试所需的工具链和基础设施取决于对应包；PLA 的 Rust 测试与真实下载器联调不是一回事。请区分单元测试、模拟联调和真实外部服务验证。

如遇到 Node 24 实验性 Web Storage 与 DOM 测试环境冲突，可单独运行：

```bash
NODE_OPTIONS=--no-experimental-webstorage corepack pnpm --filter @movie-hub/web test
```

常用诊断设置：

| 配置 | 用途 |
| --- | --- |
| `LOG_LEVEL` | 应用日志等级。 |
| `ACCESS_LOG_ENABLED` | HTTP 访问日志。 |
| `VERBOSE=false` | 默认关闭 API / Workflow 详细跟踪；排查时设为 `true`，并结合日志等级。 |

提交日志前请移除账号凭据、Cookie、会话信息、对话内容及包含密钥的 URL。

## 6. 工作区

```text
apps/
  api/                 Fastify API、业务模块与基础设施
  web/                 Vue 网站、产品首页与 PLA 介绍页
  helpers/
    agent/             Tauri / Rust 本地设备代理
    gateway/           独立设备通信服务
  docs/                静态文档构建入口
packages/
  contract/            共享运行时契约与派生类型
docs/                  产品与开发文档
```

HTTP 契约放在 `packages/contract`；数据库 schema、索引和模型工厂放在对应的基础设施 schema 模块。具体编码规则以 [项目 Agent 约定](../AGENTS.md) 为准。

## 7. 独立静态文档

```bash
corepack pnpm docs:dev
```

打开 `http://127.0.0.1:5175`。该站点独立于 API 和主网站，展示 `.archify` 中已有的图解项目；运行 `pnpm docs:build` 可生成静态输出。
