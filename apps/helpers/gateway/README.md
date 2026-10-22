# Popular Helper Gateway

独立 Node.js + TypeScript + Fastify 标准 WebSocket 服务，默认 HTTP/WS 共用 `127.0.0.1:4310`。生产部署为 **HTTPS/WSS → Nginx → HTTP/WS Gateway**。Gateway 仅连接 Redis；所有 MongoDB 查询、绑定、命令持久化和原下载更新通过 Popular 主动建立的双向 Socket 连接池执行。

## 启动

在仓库根目录执行：

```sh
pnpm --filter @movie-hub/contract build
node apps/helpers/gateway/tools/setup-env.mjs
pnpm --filter @movie-hub/helper-gateway build
pnpm --filter @movie-hub/helper-gateway start
```

配置脚本自动更新本目录 `.env`，生成 48 随机字节的独立服务凭据和 Ed25519 私钥；默认私钥位于源码仓库外 `~/.config/popular-helper-gateway/secrets`。目录 0700、私钥与 env 0600。重跑保留有效凭据与签名身份；丢失或损坏的私钥不会自动替换。输出不含凭据。脚本采用 `TLS_TERMINATION=proxy`，清除旧数据库/适配器/出站 Token/直连 TLS 配置，无需程序证书，也不修改 Nginx。

可指定 `--env-path /etc/popular/gateway.env --secrets-dir /etc/popular/gateway-secrets --locale en-US`。把生成的 `INTERNAL_INBOUND_TOKEN` 安全配置为 Popular 的 `REMOTE_GATEWAY_SERVICE_TOKEN`；Popular 还需配置 `REMOTE_GATEWAY_BASE_URL=https://gateway.example.com`。同一 Gateway 集群使用相同服务凭据及签名身份。用户 `remote_client_api_key` 只用于 Agent 握手，不能替代服务凭据或加密密码。

没有 `shared/storage`、`STORAGE_ADAPTER_MODULE` 或 Gateway MongoDB 目录。部署 Gateway 只需本服务、构建后的 `@movie-hub/contract` 及依赖，不需复制 Popular API 源码。独立进程部署后，需要可达 Redis 和至少一个健康 Popular 服务连接才能处理业务；`/health/live` 检查存活，`/health/ready` 检查 Redis 与可达 Popular，缺少连接返回 503。

## Nginx

```nginx
# 位于 http 块
map $http_upgrade $gateway_connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 443 ssl;
    server_name gateway.example.com;
    ssl_certificate /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $gateway_connection_upgrade;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }
}
```

代理模式只信任 loopback 转发头。跨主机代理需要明确可信地址及网络隔离，不应直接全信任 forwarded headers。程序直连 TLS 仍可显式设置 `TLS_TERMINATION=direct` 和 TLS_CERT_FILE/TLS_KEY_FILE。本地 HTTP/WS 必须显式 development + ALLOW_INSECURE_DEV，Popular 端另设 REMOTE_GATEWAY_ALLOW_INSECURE_DEV；生产不自动降级。

## 协议与保护

- Popular：[INTEGRATION.md](INTEGRATION.md)，包含双向 RPC、连接池、数据库所有权、去重与恢复规则。
- Agent：[PROTOCOL.md](PROTOCOL.md)，包含显式绑定、Ed25519 证明、RSA-OAEP-256/A256GCM、独立服务签名、任务证据及状态样例。
- 验证：[VALIDATION.md](VALIDATION.md)，明确模拟存储、真实网络/Redis和未验证范围。

添加请求原期限 60 秒，执行授权最长 30 秒且不超过原期限。响应未知不会重新授权执行。WebSocket Ping/Pong 检测失联，Redis 租约 45 秒，关键操作始终查询 Popular 当前授权和 Redis 当前 session。64 KiB 消息、1 MiB 发送缓冲、Agent 单连接最多 32 条待处理消息；认证 30/IP/分钟，公钥 120/IP/分钟，认证后消息 120/连接/秒。连接池每方向 64 在途请求，默认 4 条连接。没有全局在线设备或活跃任务产品额度。

Popular/Agent 连接、认证成功和断开默认记录 info 级生命周期日志，包含连接 ID、实例、Popular 池槽位或 Agent 设备/会话、断开码和耗时；不输出凭据、关闭原因正文或消息载荷。日志复用项目诊断脱敏，correlationId 贯穿 RPC 和业务调用。`VERBOSE=false` 默认关闭逐消息追踪（连接生命周期日志仍输出），错误仍按 LOG_LEVEL 输出；不记录消息正文、凭据、私钥或完整种子 URL。SIGINT/SIGTERM 关闭连接、等待在途处理、条件释放租约，10 秒退出上限。Redis/Popular 不可用时拒绝新操作。

## 本地验证

```sh
pnpm --filter @movie-hub/helper-gateway test
pnpm test:remote-gateway
pnpm --filter @movie-hub/helper-gateway simulate
# 显式开启真实本机网络及 Redis（测试使用随机前缀，不读取 .env）
GATEWAY_TEST_NETWORK=1 GATEWAY_TEST_REDIS_URL=redis://127.0.0.1:16381 pnpm test:remote-gateway
```

模拟器是仓库开发工具，使用根目录测试 harness，真实 JOSE 加密/签名、模拟存储及下载器，不代表实际 Agent 已接通。当前 Agent 仍是旧共享密钥协议，本次未改其代码；网站远程下载业务入口及用户通知渠道不在本次范围。
