# Popular Agent

[English](README.md) | 简体中文

用于连接 Popular、资源站点和本地下载器的 Docker 镜像，提供 Web 管理界面。支持 `linux/amd64`、`linux/arm64`。

- [快速开始](#快速开始)
- [配置](#配置)
- [数据持久化](#数据持久化)
- [维护](#维护)

## 快速开始

### 安装

```sh
docker pull ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef
```

Docker 自动选择主机架构。`edge` 标签指向最近一次成功发布的构建。

### 启动

首次安装，生成管理密码和加密主密钥：

```sh
docker run --rm \
  --volume popular-agent-secrets:/run/agent-secrets \
  ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef \
  --init-secrets /run/agent-secrets
```

启动 Agent：

```sh
docker run --name popular-agent --detach \
  --restart unless-stopped \
  --publish 127.0.0.1:1423:1423 \
  --env AGENT_WEB_ORIGIN=http://127.0.0.1:1423 \
  --volume popular-agent-data:/var/lib/popular-agent \
  --volume popular-agent-secrets:/run/agent-secrets:ro \
  ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef
```

读取管理密码：

```sh
docker exec popular-agent cat /run/agent-secrets/admin-password
```

打开 <http://127.0.0.1:1423>，使用该密码登录。密钥初始化仅执行一次；重启、升级时复用原数据卷。

### Docker Compose

将 [compose.yaml](compose.yaml) 保存到空目录，执行：

```sh
docker compose --profile setup run --rm init-secrets
docker compose up -d agent
docker compose exec agent cat /run/agent-secrets/admin-password
```

默认使用发布镜像和 Docker 管理的数据卷，无需创建 `.env`。局域网/NAS 访问时，在同级 `.env` 中设置：

```dotenv
AGENT_PUBLISH_ADDRESS=0.0.0.0
AGENT_WEB_ORIGIN=http://192.168.1.10:1423
```

将 IP 替换为 Docker 宿主机地址。CLI 与 Compose 默认使用不同的数据卷名；同一安装应保持原部署方式和项目名。

## 自动初始化与环境变量登录（本次源码构建）

此功能需使用包含本次修改的新镜像；上面的旧发布标签尚未更新。先在仓库根目录构建：

```sh
docker build -f apps/helpers/agent/web/Dockerfile -t popular-agent-web:local .
```

使用本次源码中的 Compose 文件，在 `.env` 中设置：

```dotenv
AGENT_IMAGE=popular-agent-web:local
WEB_LOGIN_USER=admin
WEB_LOGIN_PASSWORD=replace-with-your-private-password
```

执行 `docker compose up -d agent` 即可，无需手动运行 `init-secrets`。secrets 卷需可写，新安装会自动生成并保存 `master.key`。已有数据缺少密钥时拒绝启动，必须恢复原密钥。重启或升级不会替换密钥。

两个登录变量必须同时设置：用户名为 1–128 字节、不含首尾空白或控制字符；密码为 8–4096 字节。环境变量登录优先于密码文件，且不会写入或覆盖 `admin-password`；更改后需重建容器。两项均为空或未设置时使用密码文件，不存在则自动生成，界面仅要求密码。恢复文件登录时，若无密码文件，需允许 secrets 卷写入以生成密码。已有完整文件可继续只读挂载；使用上面的旧 CLI 命令自动初始化时，需删除 secrets 挂载末尾的 `:ro`。

保留数据和 secrets 两个卷。环境变量密码变化不会更换加密密钥。

## 配置

### 连接 Popular 和下载器

1. 在 **Popular → 设置 → Agent Key** 生成或复制 Agent Key。
2. 在 **Agent → 设置 → Gateway** 填写 Gateway HTTPS 基础地址和 Agent Key，点击「连接」。
3. 在 **Agent → 下载器** 选择 qBittorrent 或 Transmission，填写地址和凭据，点击「连接」。
4. 在 **Agent → 资源站点** 配置、验证并启用站点。M-Team：API Key；HDArea：Cookie + Passkey；HDWing：Cookie。
5. 在 **Popular → 设置 → Resources（站点）** 开启 Agent 资源请求，选择设备及默认站点。

Gateway 地址由 Popular 部署者提供。管理密码用于 Web 登录，Agent Key 用于账号绑定。下载器地址需从容器内可达，例如 `http://192.168.1.10:8080`；`127.0.0.1` 指向 Agent 容器自身。

### 局域网访问

将启动命令的端口映射和 Origin 替换为：

```sh
--publish 1423:1423 \
--env AGENT_WEB_ORIGIN=http://192.168.1.10:1423
```

将 IP 替换为 Docker 宿主机/NAS 地址。浏览器访问地址必须与 `AGENT_WEB_ORIGIN` 一致；修改环境变量需重建容器。公网访问使用 HTTPS 反向代理。

### 环境变量

通过 `docker run --env` 设置：

| 变量                        | 默认值                  | 说明                                  |
| --------------------------- | ----------------------- | ------------------------------------- |
| `AGENT_WEB_ORIGIN`          | `http://127.0.0.1:1423` | Web 访问地址，包含协议和端口          |
| `AGENT_SESSION_TTL_SECONDS` | `28800`                 | 登录有效期，单位秒，范围 `60`–`86400` |
| `VERBOSE`                   | `false`                 | 诊断日志开关                          |
| `LOG_LEVEL`                 | `info`                  | 日志级别                              |

Compose 可覆盖参数见 [.env.example](.env.example)。`AGENT_WEB_PORT` 会同步更新默认本机访问地址；局域网或反向代理需显式设置 `AGENT_WEB_ORIGIN`。

## 数据持久化

| 挂载路径                 | 内容                                 |
| ------------------------ | ------------------------------------ |
| `/var/lib/popular-agent` | 配置、设备身份、任务记录、加密凭据   |
| `/run/agent-secrets`     | 加密主密钥、可选管理密码；自动初始化时需可写挂载 |

启动命令已挂载 `popular-agent-data` 和 `popular-agent-secrets` 两个命名卷。备份时停止容器并同时备份两个卷，恢复时使用同一组数据与密钥。

Compose 绑定宿主机目录时，在 `.env` 中用 `AGENT_DATA_MOUNT`、`AGENT_SECRETS_MOUNT` 指定绝对路径。启动前创建目录，所有者设为 `10001:10001`，权限设为 `700`。已有安装需同时迁移数据与密钥。

## 维护

### 日志

```sh
docker logs --tail 100 --follow popular-agent
```

HTTP 403：检查浏览器地址是否匹配 `AGENT_WEB_ORIGIN`。镜像拉取失败：检查标签、GHCR 包可见性和登录权限。

### 升级

拉取目标版本后停止并删除旧容器：

```sh
docker pull ghcr.io/yeast-io/popular-agent:0.1.1-beta.1-647526a803ef
docker stop popular-agent
docker rm popular-agent
```

使用上方启动命令重新创建容器，镜像标签替换为目标版本，保留原数据卷。不要重新初始化密钥或删除卷。Compose 部署使用 `docker compose pull agent` 和 `docker compose up -d --no-build agent` 更新。

### Shell

```sh
docker exec -it popular-agent sh
```

[高级配置](../../../../docs/agent-web.md) · [镜像发布](../../../../docs/agent-image-release.md)
