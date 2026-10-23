# Popular ↔ Gateway 双向 Socket RPC v1

> 2026-10-23：新增 Popular 主动状态查询及 7 天推送队列。新队列、状态时效和 Agent 接入要求以[交接契约](agent-queued-push-handoff.md)为准；原短期命令接口继续保留，新 Web 下载流程使用持久队列。

Popular 主动连接 `wss://gateway.example.com/service/v1/socket`，握手头 `Authorization: Bearer <independent-service-token>`。不使用 Socket.IO，不通过 URL 传凭据。公网 HTTPS/WSS 由 Nginx 终止，代理到 Gateway HTTP/WS；Popular 必须正常验证公网证书。本地测试才能显式开启不安全传输。

## 边界和数据所有权

| 模块                                                                | 职责                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Popular `modules/remote-downloads`                                  | 权威授权、原下载归属、命令生命周期、执行许可、结果及进度规则                                |
| Popular `infrastructure/mongodb/remote-clients`、`remote-downloads` | 唯一 Mongoose 定义、索引、条件持久化；原下载仍为 `movie_downloads`                          |
| Gateway                                                             | Agent 证明验证、JWS/JWE、Socket 管理、Redis 租约与跨实例路由；没有 MongoDB 驱动或存储适配器 |
| `packages/contract/src/helper-gateway`                              | 纯消息 DTO、运行时校验；Node RPC 运行时通过独立 `@movie-hub/contract/socket-rpc` 子入口导出 |

`shared/storage` 已移除。历史 `remote_client_authorizations` 仅供 Popular 迁移，当前授权来自 `users.rcck` 和 `remote_client_devices`。默认一个设备槽位，服从 Popular 现有 `remoteDeviceLimit`；当前代际的槽位与公钥唯一索引防止并发抢绑。设备解绑后不能以旧 deviceId 重新激活，重新绑定必须显式生成新操作。

## 连接池及请求头

Popular 配置：

```dotenv
REMOTE_GATEWAY_BASE_URL=https://gateway.example.com
REMOTE_GATEWAY_SERVICE_TOKEN=<与 Gateway INTERNAL_INBOUND_TOKEN 相同的独立服务凭据>
REMOTE_GATEWAY_POOL_SIZE=4
REMOTE_GATEWAY_ALLOW_INSECURE_DEV=false
```

每个 Popular 进程维护默认 4 条、可配置 1–32 条 Socket。连接后先发送 `__service_hello__`，payload `{popularInstanceId,poolSlotId}`；响应 `{gatewayInstanceId,connectionId,serverTime}`。完成 hello 才加入可用池，按当前未完成请求数选择连接。每条连接并发请求，响应不必按请求顺序返回；慢下载 URL 获取不会串行堵住后续状态查询。断线指数退避重连，握手 10 秒超时，Ping/Pong 检测失联。

连接池不能保证任意数量任务都立即处理：每连接、每方向最多 64 个在途 RPC，发送缓冲 1 MiB，单帧 64 KiB。满载立即 `SERVICE_BUSY`，没有可用连接立即 `GATEWAY_UNAVAILABLE`。这些是运行保护，不是在线设备或活跃任务额度；没有离线添加队列。请求超时 30 秒（为 Popular 种子元数据的 10 秒获取窗口留出余量），超时或断连的效果为 unknown，不能推断业务未执行。服务端响应绕过请求槽位，避免双向调用互相等待。

RPC envelope：

```json
{
  "protocolVersion": 1,
  "command": "__get_device_status__",
  "messageId": "rpc-1",
  "correlationId": "trace-1",
  "payload": { "ownerId": "owner-1", "deviceId": "device-1", "authVersion": 1, "deviceVersion": 1 }
}
```

成功响应：

```json
{
  "protocolVersion": 1,
  "command": "__rpc_result__",
  "messageId": "response-1",
  "replyTo": "rpc-1",
  "correlationId": "trace-1",
  "payload": { "requestCommand": "__get_device_status__", "ok": true, "data": { "online": false } }
}
```

失败响应：

```json
{
  "protocolVersion": 1,
  "command": "__rpc_result__",
  "messageId": "response-2",
  "replyTo": "rpc-1",
  "correlationId": "trace-1",
  "payload": {
    "requestCommand": "__get_device_status__",
    "ok": false,
    "error": { "code": "SERVICE_BUSY", "retryable": true, "effect": "not_applied" }
  }
}
```

所有名字双下划线；所有 ID 长度 1–160、字符 `[A-Za-z0-9_-]`，时间 epoch 毫秒。`correlationId` 在服务 RPC 中必填，`replyTo` 仅响应使用。响应不再需要回执。相同 messageId 必须保留 command、payload、correlationId；同一 Socket 的缓存只作短期去重，跨连接/重启由 Popular 持久业务身份去重。错误无展示文案，无凭据、URL 或原消息正文。`effect` 为 `not_applied|unknown`，不是下载成功与否；即便标为可重试，也只能查询/重发原身份，不能创建新 executionId 绕过不确定结果。

## Popular → Gateway

| command                     | payload                                                                                             | 返回 data                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `__get_device_status__`     | ownerId, deviceId, authVersion, deviceVersion                                                       | `{online,session?,agentStatus?}`；只匹配对应授权代际，在线不等于下载器可用              |
| `__dispatch_download__`     | 下方 DownloadRequest                                                                                | PublicCommand；仅投递 Popular 已持久建立的命令，accepted 不等于已添加                   |
| `__authorization_changed__` | `{scope:'key',eventId,ownerId,authVersion,correlationId}` 或 scope=device 加 deviceId/deviceVersion | `{applied:true,eventId}`；只唤醒检查，当前授权始终由 Popular 查询，旧通知不会复活旧授权 |
| `__command_closed__`        | eventId, commandId, ownerId, deviceId, authVersion, deviceVersion                                   | `{applied:true,eventId}`；Popular 已先持久关闭，无下载器停止/删除操作                   |

DownloadRequest：

```json
{
  "commandId": "command-1",
  "downloadId": "ORIGINAL_MOVIE_DOWNLOAD_OBJECT_ID",
  "ownerId": "USER_OBJECT_ID",
  "deviceId": "device-1",
  "authVersion": 1,
  "deviceVersion": 1,
  "source": "mteam",
  "resourceId": "resource-1",
  "correlationId": "trace-1"
}
```

Popular 内的 `RemoteDownloadCoordinator.dispatch` 先检查 Gateway 当前在线及下载器可用，再验证数据库归属并建立原意图，随后调用投递。投递时再次检查在线、会话和授权。确定未生效的投递拒绝会取消未执行命令；不确定失败保留原身份等待结果核实。查询 `query(commandId,ownerId)` 和人工结束 `close(commandId,ownerId,closeId)` 直接由 Popular 完成，不需要为了查询自己数据库绕经 Gateway。原 `/internal/v1/*` HTTP 业务路由及 torrent-url HTTP 调用均已移除。

## Gateway → Popular

下面 `context` 是已认证 `{ownerId,deviceId,authVersion,deviceVersion,sessionId,instanceId}`；Agent 不能自行提供或覆盖。`agentMessageId/agentDigest` 是 Gateway 校验后的原消息身份和 canonical SHA-256 摘要。

| command                            | payload                                         | 返回 data                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__resolve_client_authorization__` | keyDigest, deviceId?                            | Authorization：ownerId/keyDigest/authVersion/active，指定当前绑定设备时还包括 deviceId/deviceVersion/keys；未指定设备允许未绑定有效 Key 获取公钥        |
| `__bind_device__`                  | keyDigest, authVersion, operationId, keys       | 当前 Authorization；Gateway 已验证私钥持有证明，Popular 以唯一槽位原子抢绑，不覆盖已有公钥                                                              |
| `__validate_session__`             | context                                         | 当前 Authorization；校验用户 Key 代际和设备绑定代际                                                                                                     |
| `__prepare_delivery__`             | context, commandId                              | `{command,keys,torrent?:{url,torrentHash}}`；Popular 校验原下载/资源权限，获取 URL，限 8 MiB 获取元数据并哈希原始 info 字节；已有加密信封不重新获取 URL |
| `__save_delivery__`                | context, commandId, deliveryMessageId, envelope | 原 CommandRecord；CAS 只保留第一份加密信封和原截止时间，随机 IV 造成并发信封不同也不替换已保存信封                                                      |
| `__confirm_command_received__`     | context, agentMessageId, agentDigest, commandId | PublicCommand；只表示 Agent 已验证并持久接收                                                                                                            |
| `__authorize_execution__`          | context, commandId, executionId, downloader     | `{decision:'granted',command}`；核对原记录选择的下载器类型后，固定执行身份、下载器和截止时间持久化后返回；拒绝为 RPC error                              |
| `__record_command_result__`        | context, agentMessageId, agentDigest, result    | `{persisted:true,commandId,executionId,outcome}`；命令结果及原记录投影都成功后返回                                                                      |
| `__record_download_status__`       | context, agentMessageId, agentDigest, status    | `{persisted:true,commandId,executionId,sequence}`；旧序列幂等确认、同序列不同内容拒绝                                                                   |
| `__recover_execution__`            | context, commandId, executionId                 | PublicCommand 加 `mayExecute:false`，不产生新许可                                                                                                       |
| `__list_pending_deliveries__`      | context                                         | `{commandIds}`；最多 64 条，只限原 session、原期限、尚未执行；新连接不恢复旧添加                                                                        |

`CommandRecord`、`PublicCommand`、result/status/evidence 完整字段以公共 `.types.ts` 和 `.schema.ts` 为准，Agent 示例见 [PROTOCOL.md](PROTOCOL.md)。PublicCommand 中 `added:true` 仅限已关联真实证据；`null` 表示执行结果未知；accepted/closed 不会伪造成功或未执行事实。

## 持久化、恢复和多实例

原 `movie_downloads.remoteRequest` 先条件保存 commandId、原截止时间、原 session/messageId，再创建唯一 `remote_client_commands`，最后条件确认原记录的 remoteCommandRegistered。Popular 恢复扫描会从尚未确认的原意图补齐命令账本；崩溃重试从原意图读取身份，不延长期限或重定向新 session。命令以 commandId+revision CAS 更新；事件用 `remote_client_event_receipts` 唯一摘要去重，不创建 `remote_client_operations`。结果先入命令，再投影原下载，最后 ACK；projected 标记和 Popular 的 5 秒 worker 修复中间崩溃。无需多文档事务。

结果成功需下载器类型/实例、torrentHash、taskId 和唯一执行 marker；duplicate 不关联用户手动任务。结果 unknown 不再授予添加，授权超时也保留 unknown。进度严格匹配原关联和授权，以持久 sequence 条件更新；unreachable 不改成 deleted。不整体替换原记录、不覆盖通知字段。原 Popular worker 扫描通知；本次没有新通知接口或用户入口。

Gateway 在 Redis 保存设备到实例的当前 session 租约，连接对象仅在本机内存；旧连接用 sessionId+instanceId 条件释放。Popular 连接池落在实例 A、Agent 在 B 时，经 Redis 有界 inbox/reply 转发双向 RPC，Pub/Sub 仅唤醒，250ms 轮询兜底。转发内容以独立服务凭据经 HKDF 派生的 AES-256-GCM 密钥加密，防止 torrent URL 明文落 Redis。集群 Gateway 使用相同服务凭据；实例租约 45 秒，relay 请求 30 秒、回复 10 秒。该中继不是命令账本，不能在未来设备上线后补执行旧添加。

数据迁移和 Agent 适配仍需独立联调。当前没有真实 MongoDB 测试结果；不能把内存/文件测试替身当正式存储。已有网站创建本地下载的入口没有改为远程入口；后续调用者需先在 Popular 建立 `executionMode:'remote'` 的原 `movie_downloads`，再以该持久业务身份调用 coordinator。Gateway 不替用户创建第二份下载记录。
