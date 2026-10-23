# Agent：状态上报与 7 天推送队列接入清单

更新日期：2026-10-23。本文是这轮 Gateway / Popular 变更的 Agent 交接契约。Agent 源码未在本轮修改。

## 1. 已由 Gateway / Popular 实现的行为

Popular 的设备设置显示 `isAgentOnline`、`isAgentDownloaderOnline`，前端每 60 秒刷新，后端也每分钟扫描有效绑定。Popular 主动调用 Gateway `__get_device_status__`，Gateway 根据认证会话/连接租约返回 Agent 在线状态。下载器状态来自 Agent 的 `__agent_status__`；Gateway 接收时记录服务器时间，超过 90 秒未更新即视为下载器不可用。续租 Agent 连接不能刷新下载器报告时间。

资源弹窗内不再选择下载器。点击下载后打开选择窗口，允许选择原有服务器直连下载器或有效绑定的 Agent。推送前会显示中英文队列保留提示；离线设备仍可提交。API 使用 `remoteDeviceId` 指定 Agent，不能同时指定服务器直连的 `provider` / `downloaderInstanceId`。

Popular 在 `movie_downloads.remoteRequest` 原子保存命令意图，再创建 `remote_client_commands`；进程退出后可恢复。排队期限 `queueExpiresAt` 为首次入队后 7 天，任何重试都不延长。后台每 5 秒扫描，每个任务最多每 60 秒进行一次自动尝试，只有两个状态同时在线才投递。离线、缺少下载器、下载器不可达、网关异常、明确执行失败均保留任务；绑定失效停止投递。到期后台删除未成功的排队任务及其命令，通常有至多一个扫描周期的延迟；服务停机期间顺延到恢复运行后清理，过期任务不会再次执行。

成功标准仍是下载器确认接收且 Agent 提交有效执行证据，不是 Gateway 已发送或 Agent 已收到。成功下载保留任务关联、状态同步，不按排队期限删除。任务结果为 `unknown` 时只允许核实，不自动重新添加。

## 2. Agent 必须持续上报下载器可用性

沿用 Socket v1 命令，无需新增上报 `isAgentOnline`：

```json
{
  "protocolVersion": 1,
  "command": "__agent_status__",
  "messageId": "unique-message-id",
  "correlationId": "diagnostic-id",
  "payload": {
    "downloaderType": "qbittorrent",
    "instanceId": "stable-downloader-identity",
    "configured": true,
    "reachable": true
  }
}
```

- 认证成功后立即探测并报告，之后至少每 30 秒报告一次，即使状态未变化、没有下载任务也必须报告。当前执行会话已有周期探测，需要核实无配置/重置/切换配置时仍能发送负面状态。
- `reachable=true` 必须证明下载器 API 连接、认证及基本读取成功；仅有配置或 TCP 可达不够。超时、认证失败、不可达时上报 `reachable=false`。
- 配置被删除或重置时立即报告 `configured=false, reachable=false`。协议字段仍必填，报告最后已知目标的类型和身份；从未配置过时使用持久化的占位身份并确保两个布尔值均为 false。
- 相同下载器在断网、Agent 重启和重连后必须保留 `instanceId`。换目标或删除后重新创建配置必须更换身份。Popular 已知原目标时会固定它，不会把旧队列自动投给新下载器；首次从未观察到目标的任务，会在首次可用投递时固定目标。

## 3. Agent 必须支持同一命令的多次投递尝试

Gateway 的已签名、加密 `__add_download__` 明文增加以下两个可选字段。旧的短期命令仍可不携带它们：

```json
{
  "queueExpiresAt": 1793318400000,
  "retryAttempt": 2
}
```

`queueExpiresAt` 是 Unix 毫秒时间戳；`retryAttempt` 是非负整数，当前实际投递从 1 开始。新增字段必须纳入本地命令摘要/防篡改校验，不能简单移除严格字段校验。现有 `protocol.rs::Command` 使用 `deny_unknown_fields`，未更新的 Agent 会拒绝新队列命令。

同一逻辑任务的 `commandId`、`downloadId`、资源身份、绑定代次和首次排队期限保持不变；每次实际重试的 `messageId`、会话、加密信封、短期 `expiresAt` 可变化，`retryAttempt` 递增，新的执行需要新的 `executionId` 和新的授权。短期投递最长 60 秒，执行授权最长 30 秒，均不得超过排队期限。尚未报告下载器类型时，远程排队记录的 `provider` 可以缺省，不会假设为 qBittorrent；服务器直连记录仍必须有类型。URL 及资源有效性仅在可投递时重新解析和校验，不应在 Agent 日志或历史中持久化明文 URL。

- 相同尝试的重复消息必须幂等 ACK / 回放结果，不能重复添加。
- 只有上一尝试**明确未添加**且结果为 `failed`，才能接受更高 `retryAttempt` 的新投递。保留旧尝试的历史，不可只清空旧记录。
- `succeeded`、`unknown`、已获授权但尚未核实、或下载器超时后无法确定是否已添加，都必须先按 torrent hash、任务 marker 和原下载器身份核对。禁止把超时当作确定失败。
- 禁止重放旧信封、重复执行旧授权、切换到别的下载器或跨绑定代次执行。更低尝试应拒绝；同一尝试不同内容应报告冲突。新尝试到来时不得重放旧 executionId 的失败结果。

## 4. 保持现有结果和进度协议

先持久化接收记录，再发送 `__command_received__`，通过 `__request_execution__` 获取当前会话授权，再调用下载器。添加确认成功后，按现有 `__command_result__` 提交 `succeeded` 与完整 evidence，收到 `__command_result_ack__` 才完成事件交接。下载器不可达/配置删除/请求被拒绝且确定没有添加时，可报告 `failed`；结果不明报告 `unknown` 并通过 `__execution_recovery__` 和下载器核实恢复。

下载器目标当前要求 `downloaderType` 与 `instanceId` 均匹配。后续 `__download_status__` 沿用现有顺序号、关联证据与 ACK；不要把下载器的 `reachable` 状态混成某一下载任务的下载状态。任务已成功添加后被用户删除，是进度状态 `deleted`，本次队列不会自动把它重新添加。

## 5. 新 session 的验收项目

1. Agent 认证后、空闲时、下载器断网/恢复、认证失败、删除配置时正确报告；Gateway 超过 90 秒未收到新报告时只将下载器视为不可用。
2. 离线排队后重连：同一任务自动投递，7 天期限不变；替换下载器后旧队列不投给新目标。
3. 明确失败后接收更高尝试并成功；同一尝试重复消息、迟到旧授权与旧结果均不能触发重复添加。
4. 模拟“下载器已接收但响应丢失”、Agent 崩溃、结果 ACK 丢失：必须核实原下载器并恢复，不能自动再添加。
5. 过期、解绑、RCCK 轮换、乱序消息及进程重启均不恢复过期授权；验证英文/中文状态与敏感信息脱敏。

可复制到新 session 的任务：

> 请按 apps/helpers/gateway/agent-queued-push-handoff.md 实现 Popular Link Agent 对状态上报和 7 天推送队列的支持，重点更新严格命令解析、多次投递尝试的持久化幂等、下载器可用性探测、删除配置的负面报告与 unknown 核实。Gateway 和 Popular 已由上一 session 修改；先检查当前代码及 AGENTS.md，保留现有用户改动，不重复实现网关/服务端队列。需要单元测试和真实 Agent / Gateway / 下载器联调；没有真实联调时明确标注模拟验证范围。
