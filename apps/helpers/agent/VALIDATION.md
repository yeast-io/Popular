# GHCR 双架构发布（2026-11-11）

源码提交 `647526a803efd0d4bc22ee5b179e4c56e03dfd0f` 已通过 GitHub Actions 原生构建并发布到 `ghcr.io/yeast-io/popular-agent`。

- 工作流：[Publish Agent Docker / 43034118917](https://github.com/yeast-io/Popular/actions/runs/43034118917)，最终结论 `success`。
- `linux/amd64`、`linux/arm64` 均通过 Docker 架构检查和非 root/只读容器的健康、登录、加密卷持久化、重启及注销验收后推送。
- 组合清单校验包含且仅包含上述两个 Linux 架构。共享标签为 `0.1.1-beta.1-647526a803ef` 与 `edge`；另有 `-amd64`、`-arm64` 版本标签。
- 发布后的匿名拉取检查返回 HTTP 401；包公开前需要授权登录。若需用户免登录拉取，应在 GHCR 包设置将可见性改为 Public。

本次关闭了此前“Docker 镜像构建/容器生命周期尚未验收”的待办；下方各批次记录保留当时状态。真实 PT、真实下载器、真实 Mongo、OS keychain 写入和桌面安装包仍不由这次 Docker smoke test 证明。API/Web/Gateway 的生产 `release` 分支未推进。

---

# Agent 资源执行（第 5 批，2026-11-11）

本批源码接通 Popular → Gateway → Core 的站点业务请求，以及本地票据 → 执行授权 → Agent 下载器的下载路径。Resources 增加单设备 Agent 模式胶囊；云端默认站点与 Agent 默认站点分别保留。AI 下载沿用选定设备。凭据和真实种子 URL 不回传云端，离线不回退云端。

| 检查 | 结果与边界 |
| --- | --- |
| Rust 工作区测试 | 73 通过，14 项按现有设置忽略；包括签名连接、Web 认证、本地凭据、哈希、票据绑定、账号一致性与 HTML 解析回归 |
| Popular API/工作流相关测试 | 69 通过；包含 Agent 所有权、离线无回退、模式切换、临时票据、AI 下载和既有资源/下载回归 |
| Popular Web / 共享 Agent UI | 383 / 54 通过；含 en-US、zh-CN 设置开关、加载失败、设备发现失败和默认配置保留 |
| Gateway / 远程队列 | 11 / 26 通过，各 3 项需要独立外部服务的测试保持跳过；含会话隔离、严格响应、超时和断开清理 |
| 编译与规范 | contract 构建、API/Gateway/Popular Web/Agent 三端类型检查、Popular Web 生产构建、Rust 全目标 Clippy、rustfmt、作用域 ESLint 与 diff 空白检查通过 |
| 原生 Web/Core/Gateway/API 联调 | 最新二进制通过三站搜索、HDArea/HDWing 详情、三站种子准备、M-Team 票据重复准备去重与下载器提交；模拟账户/持久化/下载器，站点为本机合成 HTTP 服务 |

端到端测试额外检查：保留 HDArea 集数副标题、0 做种与未知做种的区别、其他 owner 拒绝、云端响应不含测试 Cookie/API Key/Passkey/真实下载地址、认证失效后标记本地站点无效、加密存储重启后复用 deviceId、Agent 离线失败、关闭 Agent 模式恢复云端偏好。测试仅在显式开发模式下允许合成本机 HTTP 地址；生产请求继续遵循既有 HTTPS 限制。

回环集成测试在允许监听本机端口的环境通过；受限沙箱中的端口权限失败不计为应用故障。

**尚未验证**：真实 PT 账号及页面、真实 Mongo 存储/索引、真实下载器、OS keychain 写入、Docker 镜像启动/重启、桌面安装包与远程部署。未重新打包 `.app`，未提交或推送代码。之前 Docker 运行验收仍单独待办；本机原生 Web 联调不能替代它。

复现命令及目录：[Agent 资源路由](../../../docs/agent-resource-routing.md)。

---

# 设置交互与凭据掩码（2026-10-22）

本轮仅修改 Agent，未打包，未使用真实 Key、下载工具密码或系统凭据库。

- Vue/TypeScript、Vite 界面构建、作用域 ESLint、Rust Clippy 和 rustfmt 通过。
- Rust 常规测试 33 项通过，8 项默认忽略；新增覆盖旧配置迁移、断开持久化、重连复用 deviceId/私钥身份，以及重置只清除下载工具配置和密码，保留 API Key、任务 journal 和目标关联。
- 隔离 DOM 检查通过：两种语言、配置卡片收起、密码/Key 固定掩码、聚焦清空显示、未修改沿用原凭据、输入新密码替换、断开/重连、重置确认及恢复连接入口。DOM 检查模拟 Tauri 调用，不证明原生窗口显示效果。
- Gateway 本机协议联调 7 项通过（103.62 秒）。使用真实 Gateway 协议代码，模拟账户存储、持久化和两种下载工具；覆盖认证失效、重连、重复命令、结果丢失与事件重发。新增用户断开期间取消慢 HTTP 添加并保留 unknown、重连后不重投且不创建新设备。

真实部署 HTTPS/WSS、真实下载工具、macOS 原生凭据提示/窗口/托盘交互和 Windows 行为本轮未验证。以下记录属于此前轮次。

---

# Gateway Socket v1 对齐验证（2026-10-22）

本节是当前源码验证结论；下方早期记录中的“Gateway 尚不存在”、共享密钥协议、旧测试数量和旧包验证只描述当时版本，不代表本次源码。

## 当前结果

客户端对齐仓库 Gateway 公钥协议，未新增解绑功能、未修改 Gateway/API/共享契约代码、未打包。旧 HTTP 绑定/授权、自定义心跳和旧事件 ACK 已从运行代码移除。已有 UI 调整保持。

| 检查 | 结果与边界 |
| --- | --- |
| Vue/TypeScript、Vite build、客户端 ESLint | 通过；不是 `.app` 打包 |
| Rust 常规测试 | 27 项通过；6 项回环联调另行运行，系统凭据库专用测试保持忽略 |
| Rust Clippy `--all-targets -- -D warnings`、rustfmt | 通过；macOS 主机构建，不等于 Windows 构建 |
| `pnpm --filter @movie-hub/helper-agent test:mock` | 6 项通过，最终一轮 83.95 秒；真实 Gateway routes/service/JOSE + Popular 下载领域服务，账户/持久化/路由/下载器模拟 |

回环联调覆盖 qBittorrent、Transmission legacy/modern RPC 三种组合：首次绑定响应丢失仍复用 operationId/公钥/设备名额；重连复用 deviceId；重复命令不重复提交；添加响应丢失后按真实模拟任务证据确认；结果 ACK 丢失重发同一事件；暂停状态 ACK 丢失跨重连沿用原 messageId/payload；每任务递增序列、30 秒下载快照、完成/暂停/失败、unreachable 与 deleted；更换实例保留旧关联，旧 unknown 不向新目标重投。手动任务只报 duplicate，不建立关联。

另覆盖签名篡改、错误 owner/session/hash、过期命令、grant 篡改/丢失和中断请求不恢复执行；慢 HTTP 添加期间撤销在 2 秒内停止会话并保留 unknown；RCCK 失效与服务端解绑后停止接受命令；同设备会话接管不破坏新会话私钥；401/404 保留状态码且不创建绑定；64 字符资源哈希与模拟 qBittorrent 40 字符 API taskId 区分。常规测试另覆盖 grant 每个身份字段、私钥重启复用/写入失败、旧身份归档及旧 journal 保留、严格 ACK、所有权标记丢失不冒报删除、手动任务不被接管、休眠或壁钟跳变不延长授权。同步 journal 后、提交下载器 HTTP 前再次核对期限并允许撤销处理；托盘错误状态使用独立双语短文案，避免把完整错误提示拼进菜单。

第一次恢复矩阵因 ACK 丢失夹具捕获了认证消息而未真正丢弃暂停 ACK 失败；已按 ACK.replyTo 查原事件并加入“必须仍有未确认暂停事件”断言。随后一轮因新增服务端解绑认证检查产生预期 INVALID_API_KEY，但断言仍要求空错误列表而失败；已把该预期错误单独列出。最终完整矩阵通过，未把夹具错误解释为生产故障。

## 尚未验证

没有使用真实 RCCK、系统私钥或真实资源站。回环使用显式开发 HTTP/WS，不证明部署后的 HTTPS/WSS、证书/反向代理、Redis/Mongo、多实例网络 RPC 池、生产撤销链路或真实下载器行为正确；Popular 调用在夹具内直接转发。v2 下载器联调是元数据模拟，真实下载器 v2 支持仍须实机检查。

本轮没有运行 macOS 应用的原生 Keychain→Gateway 首次绑定、托盘/窗口/自启 UI，也没有运行 Windows 构建、Credential Manager 或托盘生命周期。没有生成/替换 `.app`、发布签名、公证、Intel 或 Universal 包；现存包仍为此前版本。

## 复验

```sh
pnpm --filter @movie-hub/helper-agent build
pnpm exec eslint apps/helpers/agent/ui/src apps/helpers/agent/ui/preview apps/helpers/agent/app/src apps/helpers/agent/tools --max-warnings 0
cargo test --offline --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace
cargo clippy --offline --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace --all-targets -- -D warnings
pnpm --filter @movie-hub/helper-agent test:mock
```

---

# 下载助手客户端验证记录

日期：2026-10-21。环境：macOS Apple Silicon、Rust 1.96.0、pnpm 12.10.1。

## 第 1 项实际检查与延续范围

开始前读取根 `AGENTS.md`，检查 Git 状态和源代码。已有 `apps/helpers/agent` 为未跟踪目录，包含双语设置 UI、API Key/密码的 Keychain/Credential Manager 存储、原子设置替换、Keep/Set/Clear 操作、两种下载器的只读连接测试。它当时没有设备身份、Gateway 连接、命令执行、任务关联、状态上报、托盘和自启生命周期。

本次在这些实现上扩展。保留原有保存/读取/测试操作，并为旧设置缺少 `autostart` 的情况提供默认值。空 Gateway 表示尚未配置，允许先关闭自启再绑定；旧 HTTP Gateway 或非回环下载器地址仍能读取以便用户修改，但运行连接和新保存强制执行新的传输限制。既有 `eslint.config.mjs`、根 pnpm 配置/锁文件、`experiments/` 与历史 `docs/REMOTE_CLIENT.md` 的改动未被回滚或重写。本次未提交 Git commit。

## 本机真实验证

| 检查 | 结果及边界 |
| --- | --- |
| `pnpm --filter @movie-hub/helper-agent build` | Vue/TypeScript 类型检查、Vite 生产 UI 构建通过 |
| `pnpm exec eslint apps/helpers/agent --max-warnings 0` | 通过 |
| `cargo clippy --offline --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace --all-targets -- -D warnings` | 通过，包含 Rust 类型/编译检查 |
| 常规 `cargo test` | 14 通过，2 项默认跳过；包括存储故障、旧设置兼容、双语资源一致性、URL 限制、AEAD/会话/过期校验、事件持久化与精确 ACK、脱敏错误分类 |
| `cargo test ... native_credential_roundtrip -- --ignored` | 真实 macOS Keychain 虚构凭据写入、读回、删除通过；未读取或修改用户真实凭据 |
| `pnpm --filter @movie-hub/helper-agent tauri build --debug --bundles app` | 最终 macOS Apple Silicon 调试 `.app` 构建通过，约 39.20 MiB；不是发布体积/性能数据 |

常规下载器 HTTP 测试使用真实 loopback 网络和模拟 HTTP 响应，包括 qBittorrent 登录 Cookie、Transmission 409 会话协商、旧版/新版响应、认证拒绝、拒绝重定向及响应大小限制；这不等于访问了真实下载器。第一次在沙箱内运行这些测试被禁止监听本机端口，获准使用 loopback 网络后通过。

## 模拟 Gateway 联调

命令：`pnpm --filter @movie-hub/helper-agent test:mock`。Rust 的生产传输/执行/上报代码连接 Node loopback 模拟服务；不需要 GUI、不访问系统设备密钥、不下载真实种子。矩阵覆盖 qBittorrent、Transmission 4.0 风格 RPC、Transmission 4.1 风格 JSON-RPC；新版握手按 `6.0.0` semver 处理。

覆盖内容：

- 首次绑定接口的相同 installation/key 重试返回相同 deviceId；重连认证复用已有 deviceId；解绑信号持久标记 revoked 并退出会话。测试直接注入虚构设备身份，真实身份创建/绑定的完整 Keychain→Gateway 端到端链路仍未验证。
- 密文验证、双下划线控制消息、过期命令拒绝、重复 commandId 不二次添加；HTTP 提交仅带 URL/专属标签，没有下载目录或本机凭据上传到 Gateway。
- 故意丢失添加响应后依靠 hash 与专属 marker 核实成功；无任务证据时保留 unknown，重连后不重新添加；用户手动添加的同 hash 任务报告 duplicate，未建立所有权。
- 状态采集、暂停/完成/失败、下载器不可达和任务删除；断线后恢复 outbox，丢失 ACK 的同一事件按相同 eventId/sequence/内容重发；精确匹配 ACK 后才移除。Gateway 的生产持久化、权限验证、乱序条件更新并未验证。
- 改变下载器目标后保留 unknown 关联且不向新目标投递；journal 中不含种子 URL、passkey 或下载器密码。

模拟状态变化使用 2 秒检测轮询；下载中进度按代码的 30 秒定时策略入队。没有测量长时间运行的精确上报间隔、容量或网络负载。事件按持久序号依次确认，网络异常/未确认积压会延迟后续事件送达。

一次增强测试初次失败是夹具的全局“丢弃下一条 ACK”开关被前一条排队事件消耗，未制造目标暂停事件的 ACK 丢失。修正为按事件状态精确注入后，三种协议矩阵通过（91.88 秒）。最终加入重连当前状态快照的复验也通过（97.79 秒），同样覆盖三种协议。

## 尚未验证

- 真实 Gateway：本仓库没有 `apps/helpers/gateway`；生产 TLS/WSS、账号授权、绑定配额、撤销推送、单会话接管、执行授权原子性及服务端事件持久化仍待服务端实现后验证。
- 真实 qBittorrent/Transmission：认证配置、真实 tracker URL、下载建立、版本兼容、并发手动添加竞争、用户修改标签/实例更换等需联调。模拟成功不能证明这些行为。
- 当前客户端的 macOS 原生菜单栏交互、关闭窗口后台继续、菜单明确退出、登录自启/关闭自启、退出后重启设备身份复用、重新登录启动、稳定签名/公证与升级凭据访问。本次构建了应用，未启动其原生 GUI。历史实验验证不替代当前程序验证。
- Windows 编译、托盘、Credential Manager、自启、窗口关闭与退出行为均未验证。

## 交付限制

实际客户端契约见 [PROTOCOL.md](./PROTOCOL.md)。它采用明确版本的共享设备密钥 AES-256-GCM/HMAC profile，并非历史 HPKE 公钥方案；要求可信 v1 info-hash、Transmission 4+ 的添加时 labels 能力和本机回环下载器地址。来源/重定向授权由真实 Gateway 承担，模拟服务不具备生产安全策略或持久化，严禁部署。客户端没有实现或更改 Popular 通知逻辑。

## 2026-10-21 实验目录清理

模拟 Gateway 的 `ws` 已迁入客户端自己的开发依赖，改为直接包导入，根 workspace 锁文件同步更新。实验目录移除，原生实验验证证据保留于 [历史归档](../../../docs/archive/remote-client-tauri-validation.md)。这一清理不增加真实 Gateway 或原生桌面的验证结论。

删除实验目录后复验：客户端 ESLint、Vue/TypeScript 与 Vite 构建通过；三种下载器协议的模拟 Gateway 联调通过（97.99 秒）。代码无实验目录依赖，更新后的文档相对链接检查通过。

## Popular Link Agent 命名与打包

界面（中英文）及 macOS 显示名统一为 `Popular Link Agent`。新增 `pnpm package:macos` 打包入口，按 `popular-link-agent-$version-$arch.app` 输出，并核对真实二进制架构及完整应用签名。已实际生成 `popular-link-agent-0.1.0-arm64.app` 调试包；Vue/TypeScript、Vite、ESLint、plist 名称/版本、arm64 架构和改名后 `codesign --verify --deep --strict` 均通过。默认调试包原先仅有链接器签名，现已补做本机 ad-hoc 资源封签；这不是 Developer ID 签名或公证。Intel/Universal 的入口已提供，但本次未构建验证。

## 首次绑定 UI 与 macOS 窗口修复

已将连接摘要移到托盘菜单两条短状态；移除设置页顶部整行连接提示。首次绑定、进行中、已绑定及需要重新绑定使用独立状态，未分配过 deviceId 的认证失败仍显示首次绑定。绑定按钮位于 Gateway 配置底部，独立校验并保存 Gateway/API Key，不保存尚未提交的下载器表单修改。普通设置保存不会发起首次绑定；旧版已绑定身份继续自动重连。

macOS 设置窗口打开时采用 Regular 模式，关闭后恢复 Accessory 菜单栏后台模式。原生 UI 实测：英/中文均显示“绑定设备”而不是“重新绑定”；按钮位于 Gateway 分组内；顶部连接长文案已移除；通过 Cmd-Tab 切到 Finder 后可直接切回同一窗口；关闭窗口后再次打开仍保留未保存的语言选择，证明窗口状态及后台会话得到保留。未填写或提交真实 API Key，未保存自启设置。直接通过应用名称启动的自动化第一次未能解析，随后按路径启动曾超时；最终通过 Finder 打开包并按 bundle identifier 读取原生窗口完成验证。

17 项常规 Rust 测试、Clippy（含测试目标）、ESLint、Vue/TypeScript 和 Vite 构建通过；三种下载器协议模拟回归通过（98.02 秒）。首次 mock 回归因本机缺失 `ws` 失败，仅恢复 helper 与根工具的锁定依赖后重跑通过，未修改新增 Gateway 项目的依赖。重新生成 `popular-link-agent-0.1.0-arm64.app`（调试、本机 ad-hoc 签名），架构及完整签名校验通过。真实 Gateway 的绑定端到端链路与 Windows 原生行为仍未验证。

## 设置交互精简（2026-10-21，仅源码与检查，未打包）

移除顶部副标题、窗口中的自启选项、全局保存/重新加载按钮及普通成功提示。Connect 保存 Gateway 配置并触发已有连接流程，已绑定有效身份复用 deviceId；不新增解绑功能，也没有迁移 Gateway 协议。下载器 Test 仅在 API 验证成功后保存对应配置，失败不写设置或凭据。语言即时保存，自启选项移到保持同一原生菜单实例的托盘勾选项；自启写入失败恢复勾选状态并记录诊断，文件保存失败尝试恢复 OS 自启设置。

验证：Vue/TypeScript 与 Vite 构建、限定客户端文件的 ESLint、Rust Clippy（含测试目标）通过。Rust 常规测试 20 项通过，2 项显式集成测试保持忽略；新增回归覆盖下载器测试成功自动保存、失败保留原设置及凭据、改目标不复用密码、保存不修改 Gateway/设备身份、Connect 复用已绑定身份、偏好修改保留凭据引用。下载器 HTTP 为真实 loopback + 模拟响应，凭据库使用内存替身。

通过临时 Vite 预览与模拟 Tauri IPC 检查中英文布局、Connect 启用条件、连接/绑定状态、下载器错误提示及成功后状态；预览未访问真实 Gateway、下载器或系统凭据库。macOS/Windows 的托盘勾选、自启启停及设置写入失败后的原生恢复行为尚未实测。现存 `.app` 未更新。


## 2026-11-11 Core/App 第 1 批

代码已整理为 `core/` 与 `app/`，Rust workspace 和锁文件位于 Agent 根目录，前端仍是原有桌面界面。共享 UI、Web/Docker、本地站点凭据和站点代理属于后续批次。

本地检查：workspace 常规 Rust 测试 48 项、桌面 UI 测试 13 项通过；新增 Core 完整运行流程覆盖两种下载器；本地 Gateway 恢复矩阵通过。ESLint、Clippy（禁止警告）、格式检查、前端构建和 macOS ARM64 调试打包通过，调试应用通过本地 ad-hoc 签名校验。

现有本地测试夹具更新为当前协调器字段；恢复用例按活跃任务的恢复增量断言，不再假设已经停止监控的任务继续恢复。生产 Gateway 协议和下载执行恢复规则未改变。

未执行真实下载器写入、原生凭据写入测试、Windows 打包、Linux 实机运行或远端 Actions。新 CI 负责后续 Linux Core 与 macOS/Windows 检查，但本地新增工作流不代表远端验证完成。目录、数据兼容性和命令见 [Core 与桌面宿主](../../../docs/agent-core.md)。


## 2026-11-11 统一 UI 第 2 批

共享 Vue 产品界面已迁至 `ui/`，桌面 `app/src/` 仅挂载页面和提供 Tauri 适配。五个入口为总览、资源站点、下载器、任务和设置；资源站点明确显示尚未开放。双语草稿、凭据隔离、显式重置、初始失败重试、旧快照提示及生命周期清理已覆盖。

| 本地验证范围 | 结果 |
| --- | --- |
| 共享 UI、状态与队列测试 | 31 项通过 |
| 桌面 IPC 与宿主能力适配测试 | 2 项通过 |
| Rust workspace 回归 | 48 项通过，真实服务和原生凭据写入用例仍跳过 |
| TypeScript / UI 与 App 构建 / ESLint / Clippy / Rust 格式 | 通过 |
| macOS ARM64 调试打包及本地 ad-hoc 签名 | 通过 |
| 浏览器实际布局 | 中文桌面 1040×820、英文手机 390×844、手机表单、未配置与状态失败场景已检查；手机内容宽度等于视口宽度 |

浏览器使用独立且明确标注的模拟预览入口，不读取凭据，不连接设备。共享 UI 源代码不依赖 Tauri；现有业务协议与数据格式保持不变。新增桌面启动偏好操作复用托盘的原生应用、持久化和回滚逻辑，但未对用户的真实 OS 自启动配置执行操作。Windows、Linux 和远端 Actions 尚未运行。

本批仍不包含 Web 管理服务、Docker、站点凭据或站点请求代理。开发与预览入口见 [共享 UI 说明](../../../docs/agent-ui.md)。


## 2026-11-11 Web / Docker 第 3 批

Web 宿主已接入同一 Core 与共享 UI，具备本地管理口令、HttpOnly 会话、同源/CSRF 校验、登录限流、SSE 状态、独立主密钥加密凭据、数据锁及优雅退出。Dockerfile、Compose、初始化和独立验收脚本已加入；资源站点凭据与站点请求仍留在后续批次。

| 本地验证范围 | 结果 |
| --- | --- |
| Rust 常规回归 | Core 46、App 2、Web 8 项通过；显式真实服务/系统凭据用例仍跳过 |
| 共享 UI / 桌面适配 / Web | 32 / 2 / 10 项通过；最终使用单 worker 验证 |
| Web/Core/Gateway 进程联调 | qBittorrent、Transmission 均通过登录、绑定、下载成功、加密持久化、重启复用 deviceId、无重复绑定/添加及退出失效；账户/下载器为本机模拟 |
| 真实 Chrome | 连接实际 Rust Web 服务，中英登录和共享页面、390×844 手机布局无横向溢出、退出清空口令；最终无浏览器错误 |
| TypeScript / UI、App、Web 构建 / ESLint / Web Clippy / 格式 | 通过 |
| Compose | 配置解析通过；不等于运行验收 |
| Docker 镜像构建、启动和卷重启 | **未完成**：Docker Hub 下载缓慢，两次外部前端退出；改用内置前端后本机 Docker API 又出现 15 秒无响应，未获得可运行的最终镜像 |

一轮默认多 worker UI 回归中，原有 TasksPage 英文用例超过 5 秒，整轮耗时 172 秒；单 worker 重跑全部 32 项在约 2.4 秒通过。未修改测试断言，未修改默认超时配置。

Docker 的公共缓存检查得到相同版本 manifest，但缓存构建不能代替容器运行验收。未重启 Docker Desktop，未改动现有容器、卷或默认 builder；只终止本任务的构建客户端。`tools/test-docker-agent.mjs` 已准备好，待引擎恢复后执行。Linux/Windows、远端 Actions、真实 Gateway/下载器写入和真实手机 LAN 访问均未实测。桌面安装包未在本批重新生成。

启动、凭据备份和后续验证命令见 [Web/Docker 说明](../../../docs/agent-web.md)。本批代码已实现，Docker 运行验收仍为明确的待办。

## 2026-11-11 本地资源站点第 4 批

Core 新增本地站点配置服务、M-Team/HDArea/HDWing 身份验证器、独立站点凭据引用、加密载荷的站点/地址绑定和持久化清理记录。App 与 Web 共用服务与双语页面，支持验证后保存、重新验证、启停和确认删除。Popular 的资源搜索、详情、下载来源解析及 Gateway 站点请求路由未在本批切换；界面明确说明此边界。

| 本地验证范围 | 结果 |
| --- | --- |
| Rust workspace | Core 57、Web 9、App 2，共 68 项通过；13 项显式集成/真实服务与 1 项原生凭据写入测试仍跳过 |
| 共享 UI / App 适配 / Web | 40 / 3 / 11，共 54 项通过 |
| 站点 Core 专项 | 11 项覆盖三个站点、账号身份解析、跨域/重复身份拒绝、地址更换不复用凭据、失败替换保留原配置、账号变化、失效/限流/重定向、大响应、删除重试、损坏凭据恢复和并行提交 |
| 独立 Web/Core 进程联调 | 默认模式拒绝 HTTP 且不发出站点请求；显式 loopback 开发模式下三站点验证、真实加密文件存储、重启恢复、停用状态保留、失效登录标记、删除后凭据文件清空均通过；站点响应均为本机合成 |
| 实际 Chrome | 独立临时 Web Agent；登录后三站点表单、明确切换中文的桌面页、390×844 英文手机页及退出通过；无横向溢出和浏览器错误 |
| TypeScript / UI、App、Web 构建 / ESLint / workspace Clippy / Rust 格式 / diff 空白检查 | 通过 |

浏览器截图保存于本机验收产物目录 `agent-batch4/`。端到端使用临时数据目录、初始化的测试主密钥和合成凭据，结束后清理；未连接真实资源站、Gateway 或下载器，未写用户的真实系统凭据库。默认 HTTP 拒绝由非测试 Web 二进制验证；Rust 单元夹具仅对 loopback 开启测试许可，不修改全局环境变量。

中途的测试夹具类型、类型检查及格式问题已修正。默认并行编译在本机发生持续资源竞争；最终 Rust 检查改为 `CARGO_BUILD_JOBS=1`，完整通过。未以修改断言或跳过新增测试替代验证。

本批没有重新生成桌面安装包，未执行 Windows/Linux 实机验收或远端 Actions。第 3 批 Docker 镜像/启动/卷恢复仍为独立待验收项；本机 Web 加密存储的通过不能代替容器运行验收。实现边界和命令见 [本地站点说明](../../../docs/agent-resource-sites.md)。
