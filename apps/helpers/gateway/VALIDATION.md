# Gateway 验证记录

日期：2026-10-21。当前架构为 Popular 主动建立双向 WebSocket 连接池，MongoDB 由 Popular 独占访问；Gateway 不再使用内部 HTTP 或存储适配器。

## 本次结果

| 检查                                  | 结果                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ESLint 全仓库 / lint 规则测试         | 通过；规则测试 22 项                                                                                                              |
| TypeScript 与构建                     | contract、Popular API、Gateway 编译通过；Web vue-tsc 与 Vite 构建通过，Node RPC 子入口未进入浏览器依赖链                          |
| Popular API 全量测试                  | 666 通过，0 失败，1 个 opt-in 真实 MongoDB 用例跳过                                                                               |
| Gateway、公共契约和根目录远程链路测试 | 开启真实本机网络和 Redis：50/50 通过，无跳过                                                                                      |
| 配置脚本                              | 已实际更新本机 Gateway .env，移除旧 DB/适配器/出站 Token 字段，保留原服务凭据、Ed25519 私钥及 key ID；不打印凭据、不创建 TLS 证书 |

执行 package scripts 对应的底层 Node/TypeScript 命令，避免脚本前依赖检查干扰。API 全量测试以 `apps/api` 为工作目录；从根目录直接启动该套测试会让既有 SIGINT 子进程用例找不到它依赖的 tsx，已纠正工作目录并通过。Web 构建只有既有大 bundle 的体积提示。

## 模拟与进程恢复

数据库使用显式 MemoryControlStore 测试替身，下载器任务和 tracker URL/元数据结果为 fixture。实际运行 JOSE Ed25519/RSA/AES 签名与加密；不读取业务 .env、不调用真实 tracker/downloader、不调用付费服务或用户通知。

覆盖无效 Key/证明、并发首次绑定、权威 owner、同设备跨实例接管、旧连接释放不能删除新租约、解绑及 Key 更新后无通知仍拒绝、未执行取消/已授权 unknown、离线拒绝、重复及冲突业务身份、并发信封竞争、原 session 与期限约束、成功证据、duplicate 不关联手动任务、结果丢失与投影重试、未知结果不重新授权、单调状态/冲突序列、重连快照、unreachable/deleted、人工结束保留成功事实。

独立 Node 子进程测试以临时文件作为**持久测试替身**：结果保存后、原下载投影和 ACK 前以退出码 86 退出；第二个子进程修复投影，保留原执行身份、截止时间和通知字段。另测试原下载意图已写但命令账本缺失的恢复，不延长期限。这证明恢复算法，不证明真实 MongoDB 的索引、持久性或条件写行为。

RPC 测试覆盖双向并发、乱序响应、慢请求不阻塞后续请求、方向限制、消息身份冲突、瞬时错误重试、超时 unknown、在途/缓冲保护及断连 drain。配置脚本覆盖权限、重复运行、密钥损坏/缺失、无泄密、锁/符号链接拒绝、含空格路径与 en-US/zh-CN。

## 真实本机网络与 Redis

使用本机 Redis 8.10.2，绑定 127.0.0.1:16381，关闭 RDB/AOF，测试使用随机前缀并清理自身 keys，绝不 FLUSHDB。真实 ioredis 验证 Lua 续租/释放、路由、并发限速、租约到期与订阅健康检查。

实际 TCP WebSocket 验证默认 4 条 Popular 连接、并发双向请求、健康与公钥接口、离线池拒绝。两个逻辑 Gateway 实例分别持有 Redis 客户端：Popular 池仅在 A、Agent 在 B，实际通过 Redis 双向中继投递；关闭 Pub/Sub 订阅仍由轮询完成。这里是同一测试进程内的两个实例，不是多主机部署验证。

模拟 Agent 通过实际 TCP WebSocket 完成显式绑定、持有证明、JWS 验签、JWE 解密、执行许可、成功结果、进度和持久 ACK。服务间也经过真实 WebSocket。存储/下载器仍是测试替身，不是现有桌面 Agent 的端到端联调。

复现：

```sh
GATEWAY_TEST_NETWORK=1 GATEWAY_TEST_REDIS_URL=redis://127.0.0.1:16381 pnpm test:remote-gateway
GATEWAY_TEST_REDIS_URL=redis://127.0.0.1:16381 pnpm --filter @movie-hub/helper-gateway test
```

## 未验证与接入条件

| 项目                      | 当前边界                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 MongoDB / standalone | 已实现 Popular Mongoose store、唯一索引和 CAS，无 transaction；本机没有 mongod，因此未执行真实 MongoDB 验证。可设置 REMOTE_GATEWAY_TEST_MONGODB_URI 运行 remote-control.store.test.ts；只创建和删除随机测试数据库 |
| 实际 Agent / 下载器       | 现有 Agent 仍是旧共享密钥协议，本次未修改。需按 PROTOCOL.md 独立迁移并验证真实 qBittorrent/Transmission 任务证据、journal、序列恢复                                                                               |
| 网站业务入口              | 本次不增加远程下载用户入口。调用者必须先建立 Popular 原 executionMode=remote 下载记录和通知计划，再调用 coordinator，不得把 Gateway 当原下载记录创建入口                                                          |
| 公网部署                  | 未实测 Nginx、可信证书、多主机网络、Redis 故障切换、MongoDB 进程故障或 10000 用户生产容量；连接池提供并发和背压，不是容量承诺                                                                                     |
| 完成通知                  | Gateway 只更新原记录，不覆盖通知字段、不直接通知；原 Popular worker 的远程完成通知尚未端到端验证                                                                                                                  |
