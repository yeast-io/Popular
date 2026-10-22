# 测试环境页面

网页 AI 助手使用后端 `.env` 开关。修改后重启 API，前端刷新后通过 `/api/v1/config` 获取实际启用状态。

```env
PAGE_AI_ASSISTANT_ENABLED=true
VERBOSE=false
```

| 开关 | 控制范围 |
|---|---|
| `PAGE_AI_ASSISTANT_ENABLED` | 网页 AI 助手导航、`/ai` 页面及 `/api/v1/conversations` 下的网页会话 API |

仅在 `NODE_ENV=development/test/local/dev` 时可启用；`production` 始终关闭网页 AI 助手页面及对应 API，即使开关设为 `true`。

## 后台 AI 能力

`PAGE_AI_ASSISTANT_ENABLED` 是网页功能开关，不是模型能力总开关。它不会关闭 Agent、Workflow、Telegram / WhatsApp AI 处理、偏好后台维护或偏好生成接口；用户的 AI 配置和已有偏好也保留。

## 独立静态文档

主应用已移除 Docs 导航、Markdown 展示和 `/api/v1/docs`、`/api/v1/docs/content` 接口；公共配置不再返回 `docsEnabled`，`PAGE_DOCS_ENABLED` 已移除。

执行 `pnpm docs:dev` 后访问 `http://127.0.0.1:5175`。此页面独立于 API 和主应用运行，无需登录。入口支持中英文，链接到 `.archify/<项目>/index.html`，图表沿用自身的语言切换。

执行 `pnpm docs:build` 生成 `apps/docs/dist/`，可以直接部署到静态托管服务。修改 `.archify` 后重新构建即可更新。构建仅收录包含 `index.html` 的项目目录及其展示资源，跳过 `evidence` 源码快照、隐藏文件和符号链接。没有项目时显示空状态。
