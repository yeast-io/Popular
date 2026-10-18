# 测试环境页面

网页 AI 助手和 Docs 页面使用后端 `.env` 开关。修改后重启 API，前端刷新后通过 `/api/v1/config` 获取实际启用状态。

```env
PAGE_AI_ASSISTANT_ENABLED=true
PAGE_DOCS_ENABLED=false
VERBOSE=false
```

| 开关 | 控制范围 |
|---|---|
| `PAGE_AI_ASSISTANT_ENABLED` | 网页 AI 助手导航、`/ai` 页面及 `/api/v1/conversations` 下的网页会话 API |
| `PAGE_DOCS_ENABLED` | Docs 导航、`/docs` 页面、文档目录及正文 API |

仅在 `NODE_ENV=development/test/local/dev` 时可启用；`production` 始终关闭这两个页面及对应 API，即使开关设为 `true`。

## 后台 AI 能力

`PAGE_AI_ASSISTANT_ENABLED` 是网页功能开关，不是模型能力总开关。它不会关闭 Agent、Workflow、Telegram / WhatsApp AI 处理、偏好后台维护或偏好生成接口；用户的 AI 配置和已有偏好也保留。

## Docs 数据源

API 从项目根目录的 `docs/` 递归扫描 Markdown 文件（扩展名 `.md`，不区分大小写），按路径生成侧栏。标题取文件中的一级标题，没有标题时使用文件名。没有硬编码文档文件名。

每次请求目录时重新扫描；新增、修改或删除文件后，重新加载页面即可更新。隐藏文件、隐藏目录、非 Markdown 文件和符号链接不会展示。部署时需保留根目录 `docs/`，源码及编译后的 API 使用同一相对位置。

- `GET /api/v1/docs`：返回扫描到的路径与标题。
- `GET /api/v1/docs/content?path=...`：读取目录内已扫描到的文档，正文上限为 1 MB。

两个接口都要求登录。关闭页面开关时返回 404；路径越界和未收录路径也返回 404。文档响应不缓存。

页面支持 Markdown 标题、列表、代码块、表格、相对文档链接和 Mermaid。HTML 先经过过滤；Mermaid 使用严格模式，按需加载。窄屏侧栏可展开和折叠。

Docs 调用链使用请求 ID 关联身份校验、目录扫描和文档读取阶段。`VERBOSE=true` 且日志级别允许时输出阶段日志；关闭追踪不会关闭错误日志，不记录文档正文。
