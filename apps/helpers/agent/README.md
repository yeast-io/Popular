# Popular Link Agent

Popular 的本机设备代理。设置窗口与菜单显示名称为 **Agent**，macOS 应用名称为 **Popular Link Agent**，打包文件名为 `popular-link-agent-$version-$arch.app`。

在仓库根目录安装依赖：`pnpm install --frozen-lockfile`。

## macOS 打包

在 macOS 上执行：

```sh
# 当前机器架构的调试包
pnpm --filter @movie-hub/helper-agent package:macos --debug

# 发布包：Apple Silicon / Intel / 双架构
pnpm --filter @movie-hub/helper-agent package:macos --arch arm64
pnpm --filter @movie-hub/helper-agent package:macos --arch x64
pnpm --filter @movie-hub/helper-agent package:macos --arch universal
```

跨架构或 Universal 构建需安装对应 Rust targets；Universal 需要 `aarch64-apple-darwin` 和 `x86_64-apple-darwin`。脚本会检查生成二进制的真实架构，确认后再命名应用包。

版本取自 `package.json` 与 `src-tauri/tauri.conf.json`，两者必须一致。`--debug` 使用 debug 目录，否则使用 release 目录。

| 架构 | 文件名示例 |
| --- | --- |
| Apple Silicon | `popular-link-agent-0.1.0-arm64.app` |
| Intel | `popular-link-agent-0.1.0-x64.app` |
| Universal | `popular-link-agent-0.1.0-universal.app` |

原生架构构建输出位于 `src-tauri/target/{debug,release}/bundle/macos/`；显式跨架构或 Universal 构建在 `target/<Rust target>/{debug,release}/bundle/macos/`。设置了 `CARGO_TARGET_DIR` 时使用 Cargo 解析的目标目录。程序内部显示名、bundle identifier、可执行文件名与外层 `.app` 文件名分别管理。打包后校验完整应用签名；调试构建若只有链接器的 ad-hoc 签名，会补做本机 ad-hoc 资源封签。不会自动替换已有正式签名。发布包必须通过签名校验后才报告成功。

先前版本验证过 Apple Silicon 调试包；本次协议迁移未重新打包。Intel、Universal、发布签名和公证尚未验证。

协议与验证范围见 [PROTOCOL.md](PROTOCOL.md) 和 [VALIDATION.md](VALIDATION.md)。

## Gateway 协议与联调

源码已迁移至 Gateway Socket v1 公钥协议。Gateway 配置填写 HTTPS/WSS 基础地址，客户端使用 `/client/v1/signing-keys` 与 `/client/v1/socket`。旧共享密钥身份需点击 Connect 显式迁移；旧身份、凭据条目及执行记录保留，不重放旧请求。源码更新不会更新已经生成的 `.app`。

开发检查：

```sh
pnpm --filter @movie-hub/helper-agent build
cargo test --offline --manifest-path apps/helpers/agent/src-tauri/Cargo.toml
pnpm --filter @movie-hub/helper-agent test:mock
```

`test:mock` 需要安装本仓库 Gateway 与 API 的开发依赖（包括 Node/tsx）；使用真实 Gateway 代码和回环网络，账户存储、路由存储及下载器仍为模拟，不读取 `.env` 或调用外部资源站，不写系统凭据库。生产 Agent 不依赖 Node 或本机 Gateway。

## 设置窗口与绑定

Gateway 配置底部的 **Connect / 连接** 保存 Gateway/API Key 并启动连接；首次连接请求绑定，已有有效身份会复用 deviceId。连接状态显示在各配置分组和托盘菜单中。客户端没有解绑入口。网关连接后可主动断开；断开状态持久保存，重启不会自动连接，点击连接时复用已有设备身份。断开期间现有下载继续运行，重新连接后恢复状态同步。已保存的配置收起为状态卡片，可通过“修改配置”展开。密码和 API Key 在输入框中显示固定掩码，聚焦后可输入替换值，未修改时沿用原值；真实凭据不返回前端。

下载工具配置底部的 **Connect / 连接** 在 API 验证成功后自动保存配置和密码；失败保留原配置。配置后显示 **Reset settings / 重置配置**，确认后清除下载工具地址、用户名和密码，保留现有下载、执行记录和旧任务关联。重置后恢复连接入口。此操作不会保存尚未提交的 Gateway 表单。语言切换即时保存，登录自启在托盘菜单中勾选或取消。窗口不再提供全局保存、重新加载或普通成功提示。

macOS 设置窗口打开时进入普通应用模式，可通过 Dock 或应用切换返回；关闭设置窗口后恢复菜单栏后台模式。关闭窗口不退出进程，托盘“退出”才结束进程。
