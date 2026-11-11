# Popular Agent Web / Docker

简体中文 | [English](README.en-US.md)

把 Agent 部署在电脑、NAS 或服务器上，通过浏览器配置站点和下载器。关闭管理页面或在手机上使用 Popular 时，容器仍可处理请求与下载；容器必须保持运行。

## 开始前

需要 Docker 和 Docker Compose v2（`docker compose version` 可用）。无需安装 Git、Node.js 或 Rust。镜像支持 `linux/amd64` 和 `linux/arm64`：macOS、Windows 使用 Docker Desktop 的 Linux 容器环境；Linux 使用 Docker Engine；群晖需机型支持 Container Manager/Docker。32 位 ARM 和 MIPS 不在本镜像支持范围内。

下面默认使用固定版本 `0.1.1-beta.1-647526a803ef`，Docker 自动选择架构。`edge` 是最近一次成功发布的滚动版本；当前没有 `latest` 标签。

## 快速部署

### 1. 保存 Compose 文件

新建一个 `popular-agent` 文件夹，在其中保存以下内容为 **`compose.yaml`**。此文件直接拉取已构建镜像，不需要克隆项目或本地编译。

```yaml
services:
  agent:
    image: ${AGENT_IMAGE:-ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef}
    ports:
      - '${AGENT_PUBLISH_ADDRESS:-127.0.0.1}:${AGENT_WEB_PORT:-1423}:1423'
    environment:
      AGENT_WEB_ORIGIN: ${AGENT_WEB_ORIGIN:-http://127.0.0.1:1423}
      AGENT_SESSION_TTL_SECONDS: ${AGENT_SESSION_TTL_SECONDS:-28800}
      VERBOSE: ${VERBOSE:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    volumes:
      - agent-data:/var/lib/popular-agent
      - agent-secrets:/run/agent-secrets:ro
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 128
    stop_grace_period: 15s
    restart: unless-stopped
  init-secrets:
    profiles: [setup]
    image: ${AGENT_IMAGE:-ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef}
    command: ['--init-secrets', '/run/agent-secrets']
    volumes:
      - agent-secrets:/run/agent-secrets
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
volumes:
  agent-data:
  agent-secrets:
```

### 2. 选择访问地址

**只在部署机器上使用：** 保留默认设置，浏览器访问 `http://127.0.0.1:1423`。

**从局域网电脑、手机或 NAS 访问：** 在同一文件夹新建 **`.env`**，填写：

```dotenv
AGENT_PUBLISH_ADDRESS=0.0.0.0
AGENT_WEB_PORT=1423
AGENT_WEB_ORIGIN=http://192.168.1.10:1423
```

将 `192.168.1.10` 改成运行 Docker 的机器/NAS 的局域网 IP。以后始终从这个完整地址访问；`localhost`、IP、域名、HTTP/HTTPS 和端口不能混用。不要把 `.env` 保存成 `.env.txt`。

如果 1423 端口被占用，同时将 `AGENT_WEB_PORT` 和 `AGENT_WEB_ORIGIN` 的端口改为同一个新端口。无需修改容器内端口。

### 3. 拉取、初始化并启动

在 `compose.yaml` 所在文件夹打开终端，依次执行：

```sh
docker compose pull agent
docker compose --profile setup run --rm --no-deps init-secrets
docker compose up -d --no-build agent
```

运行 `docker compose ps` 查看服务状态；若健康状态仍为 `starting`，30 秒后再次检查。

**`init-secrets` 只在全新安装时执行一次。** 它创建管理密码和加密主密钥，不会覆盖已有密钥。已有安装请直接启动，不要重新初始化。

如果拉取返回 `unauthorized` / `denied`，先确认 [GHCR 包](https://github.com/orgs/yeast-io/packages/container/package/popular-agent) 已设为 Public；使用私有镜像时，需要有权限的账号登录 `ghcr.io`。登录凭据不应写进 Compose 或 `.env`。

### 4. 获取密码并登录

```sh
docker compose exec agent cat /run/agent-secrets/admin-password
```

将终端显示的密码输入管理页面。默认地址是 `http://127.0.0.1:1423`；局域网部署使用第 2 步的地址。登录页可切换中文/English。

这是 **Agent 本地管理密码**，不是 Popular 账号密码或 Agent Key。请只在你自己的终端查看，不要分享输出。

### 5. 完成首次配置

按下方顺序配置后，到 Popular 选择资源并添加一次下载。成功标准：Agent 显示已连接/已绑定，下载器验证通过，站点已验证且启用，下载任务出现在配置的下载器中。

## 在界面中配置 Agent

| 顺序 | 在哪里                             | 填写与操作                                                                                                                              |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Popular → 设置 → Agent Key         | 生成或复制你的 Agent Key；Gateway 地址由 Popular 部署者提供。                                                                           |
| 2    | Agent → 设置 → Gateway             | 填写 Gateway 的 HTTPS 基础地址及 Agent Key，点击「连接」。首次连接会绑定设备。不要填写 Popular 网站地址或自行追加 `/client/v1/socket`。 |
| 3    | Agent → 下载器                     | 选择 qBittorrent 或 Transmission，填写地址与验证凭据，点击「连接」。成功后自动保存。                                                    |
| 4    | Agent → 资源站点                   | 配置站点地址及凭据，验证并保存，确认该站点已启用。                                                                                      |
| 5    | Popular → 设置 → Resources（站点） | 打开「Agent 资源请求」，选择当前 Agent，设置参与搜索的站点和默认站点。                                                                  |

Popular 服务端和 Gateway 需要支持 Agent 资源模式；旧服务端没有对应开关时，需要由部署者升级。站点和下载器配置在本地 Agent 中管理，不需要再把同一份凭据填到云端。Agent 离线时会明确失败，不会自动回退到云端凭据。

### 三类密码/密钥分别用在哪里？

| 凭据            | 用途                             | 填写位置                  |
| --------------- | -------------------------------- | ------------------------- |
| 管理密码        | 登录当前 Agent 管理页面          | Agent 登录页              |
| Agent Key       | 授权 Agent 绑定你的 Popular 账号 | Agent → 设置 → Gateway    |
| 站点/下载器凭据 | 访问你的 PT 站点、连接下载器     | Agent → 资源站点 / 下载器 |

### 站点凭据

| 站点   | 必填凭据                     |
| ------ | ---------------------------- |
| M-Team | API Key                      |
| HDArea | Cookie + Passkey             |
| HDWing | Cookie；无需单独填写 Passkey |

站点地址使用该站点当前有效的 HTTPS 地址。Cookie 过期后在 Agent 中更新并重新验证。凭据由 Agent 的本地加密存储保管，真实种子地址由 Agent 本地准备并提交给下载器。

### 下载器地址：按容器的视角填写

| 下载器位置                            | 地址示例                                               |
| ------------------------------------- | ------------------------------------------------------ |
| NAS/局域网中的 qBittorrent            | `http://192.168.1.10:8080`                             |
| NAS/局域网中的 Transmission           | `http://192.168.1.10:9091/transmission/rpc`            |
| Docker Desktop 宿主机上的 qBittorrent | `http://host.docker.internal:8080`，端口按实际配置调整 |

**不要使用 `127.0.0.1` 访问容器外的下载器**，它指向 Agent 容器本身。Linux Docker Engine 可使用宿主机的可达局域网地址；不要假设默认存在 `host.docker.internal`。只有加入同一个 Docker 网络时，才可通过其他容器的服务名访问下载器。

### 群晖 Container Manager

在 Container Manager 中新建项目，将上面的 Compose 内容保存到项目目录。先按 NAS 的 IP 配置 `.env`，再启动服务。`init-secrets` 是带 `setup` profile 的一次性初始化服务，**不能省略**：如果图形界面无法运行 profile，请 SSH 到 NAS，在该项目目录执行快速部署第 3 步。保持相同项目名和数据卷，避免重建成另一套空数据。

## 常用操作

在原来的 Compose 文件夹执行：

```sh
# 查看服务与健康状态
docker compose ps

# 查看最近日志
docker compose logs --tail=100 agent

# 修改 .env 后重新应用配置
docker compose up -d --no-build agent

# 停止服务，保留配置和密钥
docker compose stop agent

# 再次启动
docker compose up -d --no-build agent
```

日志正常情况下不会显示凭据，但分享日志前仍应检查、隐藏自己的地址与身份信息。仅排障时在 `.env` 中设置 `VERBOSE=true`；完成后改回 `false` 并重新应用配置。

### 升级或回滚

先备份两个数据卷，再在 `.env` 中将 `AGENT_IMAGE` 设置为目标固定版本，或使用 `edge`：

```dotenv
AGENT_IMAGE=ghcr.io/yeast-io/popular-agent:edge
```

```sh
docker compose pull agent
docker compose up -d --no-build agent
```

**升级不运行 `init-secrets`。** 保留原 Compose 项目和数据卷。回滚时将 `AGENT_IMAGE` 改为之前的固定版本后重复上述两条命令；跨版本数据格式是否兼容需查看该版本说明。

### 数据和备份

| 数据卷          | 内容                                               |
| --------------- | -------------------------------------------------- |
| `agent-data`    | 配置、设备身份、任务记录、加密后的站点和下载器凭据 |
| `agent-secrets` | 加密主密钥和管理密码                               |

实际卷名通常带 Compose 项目名前缀。停止 Agent 后，通过你的 Docker/NAS 备份工具**同时备份两个卷**，恢复到同一套卷后再启动。仅备份 `agent-data` 无法解密凭据。不要执行 `docker compose down -v` 或删除这些卷，除非确实要清空安装。

## 常见问题

| 现象                            | 检查与处理                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `no matching manifest`          | 确认 Docker 使用 Linux 容器，架构为 amd64 或 arm64；优先使用不带架构后缀的镜像标签。                           |
| `unauthorized` / `denied`       | 检查包是否公开、标签是否存在；私有包需要有读取权限的登录账号。                                                 |
| 页面打不开或 403                | 检查容器健康状态、端口映射、防火墙；浏览器地址必须与 `AGENT_WEB_ORIGIN` 完全一致。修改 `.env` 后重新应用配置。 |
| 初始化失败 / 容器因密钥错误退出 | 查看日志；已有卷不重复初始化。确认同时挂载原数据卷和原密钥卷，不要删除旧密钥“修复”。                           |
| Gateway、下载器或站点验证失败   | 分别检查地址、凭据有效期、HTTPS 证书和容器的网络连通性。更换下载器目标后重新填写凭据。                         |

默认仅监听宿主机回环地址。局域网 HTTP 不加密登录与配置请求，只用于可信网络；跨不可信网络请使用可信 VPN 或 HTTPS 反向代理，不要直接暴露 HTTP 管理端口到公网。反向代理需保留原始 Host/Origin，并关闭 SSE 缓冲。

## 更多说明

[架构与高级配置](../../../../docs/agent-web.md) · [Agent 资源模式](../../../../docs/agent-resource-routing.md) · [镜像标签与发布](../../../../docs/agent-image-release.md) · [验证范围](../VALIDATION.md)
