# Helper Gateway Socket v1 — 公钥协议

> 2026-10-23：新增 Popular 主动状态查询及 7 天推送队列。新队列、状态时效和 Agent 接入要求以[交接契约](agent-queued-push-handoff.md)为准；原短期命令接口继续保留，新 Web 下载流程使用持久队列。

这是本次 Gateway 的完整线协议，与当前旧 Agent 的共享密钥协议不兼容。模拟客户端位于 `../../../../tools/remote-gateway/simulate.mjs`，运行 `pnpm --filter @movie-hub/helper-gateway simulate`。任何设备客户端实现均须按本文件迁移并独立完成 downloader/journal 集成验证。

## Transport 与公共消息头

`WSS /client/v1/socket`，HTTP 握手头 `Authorization: Bearer <remote_client_api_key>`。禁止 URL query（包括 Key），不用 Socket.IO。标准 WebSocket Ping/Pong 用于连接活性，不能据此判定下载器可用。生产信任来自普通 HTTPS 身份验证；正常验证证书后通过 `GET /client/v1/signing-keys` 获取公钥，API Key 放同一认证头。有效但未绑定 Key 也可调用；返回 JWKS `{keys:[...]}`，不返回私钥。

所有时间为 **UTC epoch 毫秒**，所有 ID 为 1–160 位 `[a-zA-Z0-9_-]`。序列是每任务持久正安全整数。Base64 为无填充 base64url。协议 JSON 禁止额外字段；禁止二进制消息。64 KiB 最大消息，发送方不得排队无限数据。

```json
{
  "protocolVersion": 1,
  "command": "__command_result__",
  "messageId": "message-1",
  "replyTo": "optional-message-id",
  "correlationId": "correlation-1",
  "payload": {}
}
```

`replyTo`、`correlationId` 可选。业务事件沿用命令 correlationId。重发保留原 messageId 和完整内容，业务事件同时使用 commandId/executionId/sequence 去重。不要依赖 JSON 属性顺序；服务端用递归排序对象字段、保留数组顺序的 JSON 摘要比较内容。ACK 指向 `replyTo`，仅在相关持久化成功后发送；ACK 不再要求 ACK。

| Agent → Gateway          | Gateway → Agent                                  | 用途                                            |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------- |
| `__authenticate__`       | `__auth_challenge__`                             | 提供公钥，获取持有证明挑战                      |
| `__auth_proof__`         | `__auth_result__` / `__session_revoked__`        | 完成认证，后者用于撤销/接管                     |
| `__agent_status__`       | 无协议 ACK                                       | 下载器类型/配置/可访问性                        |
| `__command_received__`   | 无协议 ACK                                       | 客户端已验证并持久保存命令                      |
| `__request_execution__`  | `__execution_granted__` / `__execution_denied__` | 获得固定执行身份的一次授权                      |
| `__command_result__`     | `__command_result_ack__`                         | 持久结果及原下载投影                            |
| `__download_status__`    | `__download_status_ack__`                        | 已关联任务的单调序列快照                        |
| `__execution_recovery__` | `__execution_recovery_result__`                  | 查询原执行，不重新授权                          |
| `__error__`              | `__error__`                                      | 协议错误；服务端收到客户端 error 不执行业务操作 |

## 公钥绑定与会话

设备生成两套不同用途私钥：Ed25519 认证签名，RSA 2048–4096 bit / exponent 65537 解密。只提交下面的公开 JWK 字段；不得上传 `d`、`p`、`q` 等私钥字段。

```json
{
  "protocolVersion": 1,
  "command": "__authenticate__",
  "messageId": "auth-1",
  "payload": {
    "intent": "bind",
    "operationId": "bind-operation-1",
    "keys": {
      "signingKey": { "kty": "OKP", "crv": "Ed25519", "x": "BASE64URL_32_BYTES" },
      "encryptionKey": { "kty": "RSA", "n": "BASE64URL_MODULUS", "e": "AQAB" }
    }
  }
}
```

Gateway 从 Key 摘要查询权威 owner。客户端不得传 ownerId 冒充身份。首次绑定必须显式 intent=bind 并持久保留 operationId；重连使用 intent=authenticate、原 deviceId 和原公钥，不自动重新绑定。服务端回复：

```json
{
  "protocolVersion": 1,
  "command": "__auth_challenge__",
  "messageId": "challenge-1",
  "replyTo": "auth-1",
  "payload": { "challenge": "EXACT_SERVER_GENERATED_JSON_STRING", "expiresAt": 1800000010000 }
}
```

challenge 是服务端生成的 JSON **原字符串**，包含 protocolVersion、command=`__auth_proof__`、audience=`popular-helper-gateway`、connectionId、32 随机字节 nonce、ownerId、authVersion、keysDigest、intent、operationId/deviceId、deviceVersion（已绑定时）、expiresAt。客户端不能解析后重新序列化来签名，应使用 UTF-8 原字节。证明为 compact JWS，protected header `{alg:"EdDSA"}`：

```json
{
  "protocolVersion": 1,
  "command": "__auth_proof__",
  "messageId": "proof-1",
  "replyTo": "challenge-1",
  "payload": { "proof": "COMPACT_JWS_SIGNED_BY_DEVICE_ED25519" }
}
```

挑战 10 秒有效、单次消费（失败也消费）。Gateway 验证证明后通过 Socket 请求 Popular 以当前 Key/版本和唯一设备槽位原子绑定；默认一槽，其他公钥竞争失败。已绑定设备只能使用原两套公钥，不能覆盖；解绑后旧 deviceId 不可再次激活。成功：

```json
{
  "protocolVersion": 1,
  "command": "__auth_result__",
  "messageId": "result-1",
  "replyTo": "proof-1",
  "payload": {
    "authenticated": true,
    "ownerId": "owner-1",
    "deviceId": "device-1",
    "authVersion": 1,
    "deviceVersion": 1,
    "sessionId": "session-1",
    "instanceId": "gateway-1",
    "serverTime": 1800000001000
  }
}
```

同设备新会话接管旧会话；后续业务用户、设备、版本、会话来自连接认证上下文。旧连接收到 `__session_revoked__`，payload `{code:"SESSION_REVOKED"}`，或在下一关键操作被拒绝；应停止新执行并关闭连接。解绑/Key 更新需新 Key 和重新绑定流程。重连不恢复旧添加请求。

```json
{
  "protocolVersion": 1,
  "command": "__agent_status__",
  "messageId": "status-1",
  "payload": { "downloaderType": "qbittorrent", "instanceId": "downloader-1", "configured": true, "reachable": true }
}
```

downloaderType 只接受 `qbittorrent|transmission`，instanceId 是客户端持久下载器目标身份；改配置到另一实例时换身份。不得包含密码或凭据。配置不完整或不可访问时不授予执行。设备在线不等于下载器可用。

## 命令信封与执行授权

```json
{
  "protocolVersion": 1,
  "command": "__add_download__",
  "messageId": "delivery-1",
  "correlationId": "correlation-1",
  "payload": { "envelope": "COMPACT_JWS" }
}
```

envelope 是服务端 Ed25519 compact JWS，protected header `{alg:"EdDSA",kid:"server-key-id",typ:"popular-gateway-v1"}`，payload 为 `{protocolVersion:1,command:"__add_download__",jwe:"COMPACT_JWE"}`。先验证服务端签名与固定算法/命令/版本，再解密 JWE；不得接受客户端自带任意签名 key 或算法。JWE protected header 为 `{alg:"RSA-OAEP-256",enc:"A256GCM",typ:"popular-gateway-v1"}`，使用设备 RSA 公钥加密，解密后：

```json
{
  "protocolVersion": 1,
  "command": "__add_download__",
  "messageId": "delivery-1",
  "commandId": "command-1",
  "downloadId": "download-1",
  "ownerId": "owner-1",
  "deviceId": "device-1",
  "authVersion": 1,
  "deviceVersion": 1,
  "sessionId": "session-1",
  "source": "mteam",
  "resourceId": "resource-1",
  "correlationId": "correlation-1",
  "expiresAt": 1800000060000,
  "torrentUrl": "https://trusted-tracker.example/download?passkey=REDACTED",
  "torrentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

客户端必须以受保护内容为准，比较当前 owner/device/authVersion/deviceVersion/session、外层 messageId/correlationId、命令和版本，检查原期限，然后持久保存已验证命令（不要保存明文种子 URL）。外层改写不能改变执行身份或期限。使用服务端可信时间与本地单调时钟控制期限；生产不要靠任意客户端壁钟绕过过期检查。加密库生成随机 CEK/IV；传输重试使用原持久信封，不能自行重新生成执行身份。

持久保存后：

```json
{
  "protocolVersion": 1,
  "command": "__command_received__",
  "messageId": "received-1",
  "correlationId": "correlation-1",
  "payload": { "commandId": "command-1" }
}
```

执行前先持久生成 executionId，通过**当前 Socket**发送：

```json
{
  "protocolVersion": 1,
  "command": "__request_execution__",
  "messageId": "execute-1",
  "correlationId": "correlation-1",
  "payload": { "commandId": "command-1", "executionId": "execution-1" }
}
```

Popular 原子保存 grant，Gateway 签名 后回复 `{command:"__execution_granted__",...,payload:{grant:"COMPACT_JWS"}}`。JWS 使用同一服务签名格式，受保护 payload：

```json
{
  "protocolVersion": 1,
  "command": "__execution_granted__",
  "commandId": "command-1",
  "downloadId": "download-1",
  "ownerId": "owner-1",
  "deviceId": "device-1",
  "authVersion": 1,
  "deviceVersion": 1,
  "sessionId": "session-1",
  "executionId": "execution-1",
  "expiresAt": 1800000031000,
  "correlationId": "correlation-1",
  "torrentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "downloader": { "downloaderType": "qbittorrent", "instanceId": "downloader-1" }
}
```

客户端验证签名、全部身份、下载器实例和固定截止时间。相同执行重试只返回同一 grant 身份和原截止时间；不同执行拒绝。`__execution_denied__` 的 payload 为 `{code:"EXECUTION_NOT_ALLOWED"}` 等结构化码。已经终止、超时或换会话不能获得新 grant。一次 grant 对应一次本地添加，客户端必须依赖自己的持久 journal 防止重复调用下载器；不能把收到相同 grant 视为另一份添加许可。

## 结果与任务证据

结果 payload 基础字段 `commandId,executionId,outcome`，outcome 为 `succeeded|duplicate|failed|unknown`。只有 succeeded 可携带 evidence 且必须提供。证据必须来自下载器实际查询，不能从“URL 已接受”响应自行捏造：

```json
{
  "protocolVersion": 1,
  "command": "__command_result__",
  "messageId": "event-result-1",
  "correlationId": "correlation-1",
  "payload": {
    "commandId": "command-1",
    "executionId": "execution-1",
    "outcome": "succeeded",
    "evidence": {
      "downloaderType": "qbittorrent",
      "instanceId": "downloader-1",
      "torrentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "taskId": "task-1",
      "marker": "popular-execution-1"
    }
  }
}
```

真实任务必须同时匹配原 torrentHash、执行时固定下载器实例及唯一 `popular-<executionId>` 标记。Gateway 验证该设备证明的结构、来源上下文、原命令和执行关联；Gateway 本身不连接下载器独立检查任务，真实证据采集仍由 Agent 实现并联调。

已有手动任务只能报告 duplicate，不得加标记来接管。duplicate 不提供 evidence、不建立平台任务关联。明确失败可报告 failed；调用可能已经生效但无法核实必须 unknown。unknown 之后允许同一 executionId 以核实证据变成 succeeded；不提供第二次添加授权。最终 succeeded/duplicate/failed 不相互改写。超时只会归入 unknown，不作为未执行证据。

```json
{
  "protocolVersion": 1,
  "command": "__command_result_ack__",
  "messageId": "ack-result-1",
  "replyTo": "event-result-1",
  "correlationId": "correlation-1",
  "payload": { "persisted": true, "commandId": "command-1", "executionId": "execution-1", "outcome": "succeeded" }
}
```

Agent 在 ACK 前保留原结果并重发。Gateway 持久化命令结果、完成幂等原下载投影后才 ACK。进程在两次写之间崩溃，由 durable projected 标记恢复，无需事务。

## 进度、恢复及错误

下载中每 30 秒快照一次，关键变化立即发送。只上报已确认关联任务：

```json
{
  "protocolVersion": 1,
  "command": "__download_status__",
  "messageId": "event-progress-2",
  "correlationId": "correlation-1",
  "payload": {
    "commandId": "command-1",
    "executionId": "execution-1",
    "sequence": 2,
    "evidence": {
      "downloaderType": "qbittorrent",
      "instanceId": "downloader-1",
      "torrentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "taskId": "task-1",
      "marker": "popular-execution-1"
    },
    "state": "downloading",
    "progress": 0.5,
    "downloadedBytes": 500,
    "totalBytes": 1000,
    "downloadSpeed": 100,
    "uploadSpeed": 10
  }
}
```

state 为 `downloading|completed|paused|failed|unreachable|deleted`。progress 取 0–1，其余计数/速度为非负 bytes / bytes-per-second。sequence 是每关联任务的持久递增整数，重连不重置。相同 sequence 不同内容冲突；旧序列 ACK 但不覆盖新状态。服务端还会核对 Popular 原下载记录关联；未知任务不能直接创建记录。

```json
{
  "protocolVersion": 1,
  "command": "__download_status_ack__",
  "messageId": "ack-progress-2",
  "replyTo": "event-progress-2",
  "correlationId": "correlation-1",
  "payload": { "persisted": true, "commandId": "command-1", "executionId": "execution-1", "sequence": 2 }
}
```

`unreachable` 用于下载器无法查询；仅在成功查询后确定原任务消失才报告 `deleted`。均不自动重新添加。重连可上报当前快照及原未确认结果，服务端允许同设备当前有效新会话接收原执行恢复事件：

```json
{
  "protocolVersion": 1,
  "command": "__execution_recovery__",
  "messageId": "recovery-1",
  "payload": { "commandId": "command-1", "executionId": "execution-1" }
}
```

回复 `__execution_recovery_result__`，payload 为 `commandId,downloadId,state,expiresAt,executionId,grantExpiresAt,result,accepted,added,mayExecute:false`。`added` 为 true（有成功关联）、false（确定未由本命令添加）或 null（尚不确定）；人工结束不会把已成功关联变成未下载。查询不延长请求、不返回新授权。恢复证据通过原 `__command_result__`、快照通过 `__download_status__` 提交。

错误示例：

```json
{
  "protocolVersion": 1,
  "command": "__error__",
  "messageId": "error-1",
  "payload": { "code": "STATUS_SEQUENCE_CONFLICT" }
}
```

错误不含展示文案、凭据、完整 URL 或原 payload。客户端若报告协议错误，可发送 payload `{code:"..."}` 的 `__error__`；服务端消费而不回发另一个 error，避免错误循环。认证失败或被撤销应停止当前会话；连接中断、执行超时不得解释为下载器没有添加成功。首版没有暂停/继续/删除控制消息，完成通知由 Popular worker 负责。
