# 资源站点适配

The `resource-sites` backend module accesses supported resource sites directly. HDArea is the first implementation. Jackett is not required. The optional Passkey is encrypted separately and can be used by the backend to build a torrent URL. Downloads submit the site's torrent URL directly to the configured downloader; Popular does not fetch torrent files.

`resource-sites` 后端模块直接访问资源站点，首版支持 HDArea，无需部署 Jackett。可选 Passkey 单独加密保存，供后端拼接种子地址；本版仍不获取种子、不提交下载任务。

## Try it / 使用方式

1. Open Settings → Resources → HDArea. 登录 Popular 后打开「设置 → 资源 → HDArea」。
2. Log in to HDArea in your browser, then copy the **value** of the Cookie request header from a request to the site. Paste it into Popular and select Verify and save. 从浏览器开发者工具复制已登录 HDArea 请求的 Cookie 请求头值，粘贴到 Popular，点击「验证并保存」。不要包含 `Cookie:` 前缀。
3. Source configuration cards share the same action order: Delete configuration → Retest configuration → Test and save. Retesting uses the saved credentials, not unsaved input values. 资源卡片使用统一的操作顺序：删除配置 → 重新测试配置 → 测试并保存。重新测试使用已保存的凭据，不提交尚未保存的输入。

The Search across sources frontend block has been removed for now. Search, source listing and detail APIs remain available to authenticated callers. 页面暂时移除了跨站搜索功能块；搜索、来源列表和详情的后端接口继续保留，并要求登录。

Configuration responses include `cookieMasked` / `passkeyMasked` display values with the first six and last six characters visible and the original character count preserved instead of plaintext secrets. M-Team and download clients similarly return `apiKeyMasked` or `passwordMasked`. The input fields display these masked values as text and show the stored character count. Credentials of 12 characters or fewer are fully masked to prevent overlapping ends from revealing the complete credential. Replacement values remain password inputs; unchanged masks are omitted from updates. The backend also recognizes the exact marker as retain-existing and rejects partially edited markers.

配置响应返回 `cookieMasked` / `passkeyMasked`：超过 12 个字符时保留前 6 位和后 6 位，中间按原长度遮盖；不超过 12 个字符时全部遮盖，防止首尾重叠导致完整泄露。输入框显示原字符数。M-Team 和下载器同样返回 `apiKeyMasked` 或 `passwordMasked`。输入框显示这些掩码；未修改时不会提交。后端也将完整掩码视为保留原凭据，拒绝部分修改后的掩码。

Saving verifies the login before replacing the encrypted credential. Leave the Cookie field blank to revalidate the saved credential. Invalid/blocked credentials stop subsequent search requests until revalidation or replacement. A failed replacement does not overwrite the previous credential.

保存前会验证登录态，成功后才替换加密凭据。Cookie 留空时验证已保存凭据。凭据失效或被拦截后，后续搜索停止外部请求，直到重新验证或更新。替换失败不会覆盖原凭据。

The assistant's existing resource search also includes registered sites. Its movie lookup uses the catalog IMDb identity; missing IMDb identities return `unmatchable` instead of silently searching ambiguous keywords. HDArea download requests use the same download service as M-Team.

助手资源查询也包含已注册站点，按电影目录中的 IMDb ID 搜索；缺少 IMDb ID 时返回无法可靠匹配。HDArea 下载仍不支持。

## Boundaries / 模块边界

- `apps/api/src/modules/resource-sites/`: adapter contracts, registry, credential orchestration, site rules/parsers, errors and routes. 适配器契约、注册、凭据协调、规则与页面解析。
- `apps/api/src/infrastructure/hdarea/`: HDArea adapter, HTML parsing, selectors, HTTP client, per-operation Cookie jars and request scheduling. HDArea 适配器、HTML 解析、选择器、HTTP 客户端、操作级 Cookie 容器与请求调度；与 `infrastructure/mteam/` 同级。
- `apps/api/src/infrastructure/mongodb/resource-sites/`: schema/model factory and owner/site credential persistence. Schema、Model 工厂与按用户和站点存储凭据。
- `packages/contract/src/integrations/resource-site.schema.ts`: HTTP contracts. 接口契约。
- `apps/web/src/features/integrations/ResourceSiteSettings.vue`: HDArea credential configuration only. HDArea 凭据配置。
- `apps/api/src/modules/resource-search/`: shared search contracts, orchestration and source adapters for M-Team and registered resource sites. 跨站搜索与来源适配。
- `apps/web/src/features/integrations/SourceConfigurationActions.vue`: shared source configuration actions and deletion confirmation. 统一资源配置操作和删除确认。

A new site supplies an infrastructure adapter and parser. `apps/api/src/server.ts` creates the concrete adapters and injects their registry into the resource-site service; the business module depends only on the adapter contract. 新站点在 infrastructure 中提供适配器与解析器，由 `server.ts` 创建具体实现并注入注册表；业务模块只依赖适配器契约。 Settings routes, credential storage and resource query projection are generic. The first UI card currently selects HDArea explicitly; a future site's UI entry must be added deliberately.

新增站点实现适配器和解析器，并加入注册表。设置路由、凭据存储与资源查询投影可复用；首版 UI 卡片明确选择 HDArea，新增站点时需增加相应入口。

The search selectors and parameter mapping were informed by Jackett's [HDArea definition](https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/hdarea.yml). This is an independent TypeScript implementation, not a Jackett YAML interpreter. Basic detail extraction is implemented separately.

搜索参数和选择器参考 Jackett 的 HDArea 定义。本模块为独立 TypeScript 实现，不解释 Jackett YAML；基础详情由单独的解析逻辑提取。

## API

All paths below are under `/api/v1` and require the Popular session cookie. 所有接口均要求 Popular 登录态。

| Method | Path | Purpose / 用途 |
| --- | --- | --- |
| GET / PUT / DELETE | `/me/integrations/resource-sites/:site` | Configuration status, verify/save Cookie, delete configuration / 配置状态、验证保存、删除 |
| POST | `/me/integrations/resource-sites/:site/test` | Revalidate the saved Cookie / 重新验证 |
| GET | `/me/resource-sites/:site/releases?query=...&page=1` | Keyword search / 关键词搜索 |
| GET | `/me/resource-sites/:site/releases?imdbId=tt0816692&page=1` | IMDb search / IMDb 搜索 |
| GET | `/me/resource-sites/:site/releases/:id` | Basic title, resource ID and optional IMDb ID / 基础详情 |

Shared search endpoints (all require the authenticated Popular session):

| Method | Path | Purpose / 用途 |
| --- | --- | --- |
| GET | `/me/resource-search/sources` | Source identity, configuration status and detail capability; no credentials / 来源、配置状态与详情能力，不返回凭据 |
| GET | `/me/resource-search/:site/releases?query=...&page=1` | Search one selected source; callers can aggregate requests / 单站查询，调用方可聚合多个来源 |
| GET | `/me/resource-search/:site/releases?imdbId=...&page=1` | IMDb search / IMDb 搜索 |
| GET | `/me/resource-search/:site/releases/:id` | Details when supported by that source / 支持时查询详情 |

Each search API request targets one source and has independent paging and failure handling. A caller may query multiple sources concurrently. The HTTP request correlation ID is retained through source adapters, and caller disconnection cancels in-flight work where supported.

每次搜索接口请求针对一个来源，分页和错误独立处理；调用方可以并发查询多个来源。请求关联 ID 贯穿来源适配器，调用方断开连接时取消受支持的执行中请求。

M-Team uses its native page number with 100 results per source request. When the upstream supplies total metadata, it determines whether a next page exists; otherwise a full 100-row page permits one more request, which may return empty. Both source query interfaces limit page numbers to 1–100. M-Team requests are restricted to one active query per owner with a 2.5-second per-process cooldown; HDArea retains its shared per-site scheduler. Separate users never share credentials.

M-Team 使用原生分页，每页最多 100 条。上游返回总数时据此判断下一页；没有总数时，满 100 条允许继续查询，末页可能返回空结果。查询页码限制为 1–100。M-Team 每个用户最多一个执行中的搜索，结束后有单进程内 2.5 秒冷却；HDArea 沿用站点级调度。用户间不共享凭据。

Page numbers are one-based. No API returns plaintext site Cookies, Passkeys or credential-bearing download links. `ResourceSiteService.torrentUrl(ownerId, site, releaseId)` constructs the HDArea URL from the authenticated owner's saved Passkey for backend callers only; it does not fetch or submit a torrent. Only registered, fixed HTTPS site origins may be requested; cross-origin redirects are rejected.

页码从 1 开始。接口不返回明文 Cookie、Passkey 或含凭据的下载链接。`ResourceSiteService.torrentUrl(ownerId, site, releaseId)` 仅供后端根据对应用户的 Passkey 拼接 HDArea 种子地址，不获取种子或提交下载。请求仅访问注册站点的固定 HTTPS 源，拒绝跨源跳转。

## Operational limits / 运行限制

Credentials are encrypted with the existing `INTEGRATION_SECRET_KEY` and authenticated with owner/site context. Cookie jars are never shared across owners. No site-response cache is added by this module. The existing assistant snapshots remain owner/conversation scoped.

凭据使用现有 `INTEGRATION_SECRET_KEY` 加密，并绑定用户和站点上下文。不同用户不共享 Cookie 容器。本模块不缓存站点响应；助手既有快照仍按用户和会话隔离。

Requests are serialized per site with a two-second minimum interval **inside one process**, a bounded queue and 20-second timeout. HTTP 429 imposes a site cooldown of at least 60 seconds and honors a longer Retry-After. There is no automatic retry. These limits are conservative initial values, not verified site policy. Multiple API processes would require a distributed scheduler before the limits can be considered deployment-wide.

单进程内每个站点串行请求，最小间隔 2 秒，队列有上限，请求含排队最多等待 20 秒。429 触发至少 60 秒冷却，并遵守更长的 Retry-After；不自动重试。这些是初始保守配置，不代表已经验证的站点规则。多进程部署需要分布式调度，才能保证整个部署的总请求限制。

Structured diagnostic traces use the existing `VERBOSE=false` switch and `LOG_LEVEL`. Error diagnostics remain enabled independently of verbose events. Cookies, Cookie values and search text are registered for redaction; no raw HTML or response payloads are logged.

诊断复用 `VERBOSE=false` 和 `LOG_LEVEL`，关闭详细事件不抑制错误日志。Cookie 及其值、搜索文本参与脱敏，不记录原始 HTML 或响应载荷。

Automated parser tests use synthetic fixtures based on the public definition. They do not prove live layout compatibility. Live HDArea Cookie search was reported successful by the user during initial integration. M-Team pagination, details and challenge variants still require live acceptance testing; automated tests use substitutes for upstream HTTP responses.

解析测试使用依据公开定义构造的合成页面，不能证明真实页面兼容。初次接入时用户已反馈真实 Cookie 搜索成功；分页、基础详情和验证码变体仍需真实验收。


## Torrent URL submission / 种子链接提交

Page and assistant downloads share the backend download service. M-Team obtains a fresh URL through `torrent/genDlToken`; HDArea builds an owner-specific URL from the saved Passkey. qBittorrent receives `urls` at `torrents/add`; Transmission receives `filename` at `torrent-add` (or `torrent_add`). Popular neither fetches torrent bytes nor uploads torrent files. The downloader must reach the source URL and fetch the torrent itself. URLs remain transient backend values: never return them to the page, persist them with download records, or log them. A successful URL submission may precede torrent retrieval; tasks remain `submitting` until a downloader task is observed.

页面与助手共用后端下载服务。M-Team 通过 `torrent/genDlToken` 获取新链接，HDArea 使用对应用户保存的 Passkey 生成链接。qBittorrent 使用 `urls` 参数，Transmission 使用 `filename` 参数。Popular 不获取或上传种子文件，由下载器自行访问链接获取种子。链接仅在后端临时传递，不返回页面、不存入下载记录、不写入日志。链接提交成功时种子可能尚未获取完成，未观察到下载器任务前保持 `submitting` 状态。
