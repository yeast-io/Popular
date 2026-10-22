# Agent — Gateway Socket v1

当前客户端遵循 [Gateway 公钥协议](../gateway/PROTOCOL.md)。该文件是线协议的唯一契约；本文件说明 Agent 的实现及迁移边界。旧共享设备密钥、`/v1/bind`、`/v1/authorize`、自定义 heartbeat 和 `__event_ack__` 均不再使用。

## 连接与身份

生产配置为 Gateway **HTTPS/WSS 基础地址**（支持反向代理路径前缀）。客户端通过 `GET <base>/client/v1/signing-keys` 获取 JWKS，再连接 `WSS <base>/client/v1/socket`；两者均用 `Authorization: Bearer <RCCK>`，不在 URL 或消息 payload 中携带 RCCK。HTTP/WS 仅在原生进程显式设置 `HELPER_ALLOW_INSECURE_DEV=true` 时允许。使用正常证书验证，不跟随重定向、不使用系统代理。

首次 Connect 授权绑定。设备生成用途分离的 Ed25519 签名私钥和 RSA-2048 解密私钥，保存在系统凭据库的独立条目中；只上传公开 JWK。绑定 operationId、凭据引用和服务端 deviceId 持久化到 `identity.json`。先保存私钥与操作身份，再发送绑定；绑定响应丢失时沿用原操作与公钥，不能抢占新名额。已有 deviceId 的重启/重连使用 `intent=authenticate`，不重新生成密钥或绑定。

认证证明签名服务端挑战的原始 UTF-8 字符串，核对其用途、意图、设备/操作身份、公钥摘要、nonce、owner 与授权版本；认证成功后验证返回上下文与原挑战一致。标准 WebSocket Ping/Pong 与下载器 HTTP 执行分离，45 秒未收到 Pong 则断开。网络错误使用 1–30 秒指数退避和随机抖动。

会话撤销立即取消执行并暂停自动连接，但不单凭 `SESSION_REVOKED` 销毁设备身份（它也可能表示连接被接管）。用户再次 Connect 验证原身份；明确 RCCK/设备失效后标记需要重新绑定。不存在客户端解绑命令。HTTP 错误日志包括安全的状态码，协议错误记录允许列出的错误码，不记录响应正文、凭据、密钥或完整种子 URL。

## 验证与执行

先用当前 TLS 获取的 JWKS 验证服务端 Ed25519 compact JWS，固定 `alg=EdDSA`、`typ=popular-gateway-v1` 和 `kid`；再用设备私钥解密 `RSA-OAEP-256 / A256GCM` compact JWE。核对协议/命令、owner、device、auth/device 版本、当前 session、外层 messageId/correlationId、源和资源身份及原截止时间。ID 接受协议定义的 1–160 位字母、数字、下划线和连字符；时间为 epoch 毫秒，哈希为 40 或 64 个小写十六进制字符。

执行期限来自认证 serverTime 加单调时钟；壁钟仅用来检测休眠/时钟跳变并使授权失效，不能延长授权。执行前还要检查签名 grant 的完整执行身份、原命令期限和固定下载器 instanceId。

`gateway-journal.json` 保存无 URL 的命令关联与固定 executionId，随后发送 `__command_received__` 和当前 Socket 的 `__request_execution__`。一次 grant 只允许一次本机 URL 提交。执行前查重复；已有任务报告 duplicate，不修改标记来接管它。提交前持久化 unknown，即使崩溃、断线、撤销或 HTTP 响应丢失也不能盲目重试。

qBittorrent 仅提交 `urls,tags`；Transmission 仅提交 `filename,labels`。不下载/上传 torrent 文件、不指定目录，不把下载器凭据发往 Gateway。成功必须由实际查询确认完整 torrentHash、当前下载器实例和 `popular-<executionId>` 标记，并记录真实 API taskId。qBittorrent 的本机任务列表只保留请求哈希匹配项，区分 `hash`（API taskId）与 `infohash_v1/infohash_v2`（资源身份）；不会把手动任务上传为关联。字段依据 [qBittorrent 上游定义](https://github.com/qbittorrent/qBittorrent/blob/master/src/webui/api/serialize/serialize_torrent.h)。下载器不能提供可核实哈希/标记时不能报告成功；真实 v2 下载仍需实机验证。

## 状态与恢复

只同步已确认成功的关联。每 2 秒检查状态；下载中每 30 秒生成快照，状态变化在检测后立即进入有序 outbox。无法查询报告 unreachable；成功查询后原任务确实不存在才报告 deleted；哈希仍存在但所有权标记/证据被改写则报告 failed，不接管替代任务。均不自动添加。

状态序号按任务持久递增；结果/状态事件保留原 messageId、correlationId 与完整 payload 重试。只有匹配原事件类型、replyTo、commandId、executionId、outcome/sequence 和 persisted=true 的 ACK 才删除事件。结果先于状态提交，避免服务器尚未建立关联就接收状态。

重连请求 `__execution_recovery__`、补发未确认结果并查询当前任务快照；`mayExecute=false` 永不当作添加许可。prepared/authorized 的中断执行转为 abandoned，不恢复已失效的 URL 请求。unknown 只查询原实例，有真实证据才转 succeeded。

`downloader-targets.json` 保留下载器目标身份映射。换地址、类型或用户时分配另一身份；切回原目标复用原身份。旧关联保留，旧状态不投递为新实例状态，旧 unknown 不对新实例执行添加。

## 旧版本迁移与验证范围

旧 `identity.json`（无 protocolVersion 或版本为 0）不会被自动用于新协议；显式 Connect 将其归档到唯一的 `legacy-identity-<uuid>.json` 后准备新协议身份。原系统凭据条目保留。旧 `journal.json` 不被覆盖、不上传到新 Gateway，也不重放其中的请求；新协议使用独立 `gateway-journal.json`。

联调夹具 `tools/mock-gateway.mjs` 实际运行仓库 Gateway routes/service/JOSE 和 Popular 下载领域服务，使用回环 HTTP/WebSocket；账户持久化、路由存储与下载器是模拟，Popular 调用在夹具内直接转发。这不代表部署后的 TLS/WSS、Redis/Mongo、真实资源站或真实下载器链路已验证。详见 [VALIDATION.md](VALIDATION.md)。
