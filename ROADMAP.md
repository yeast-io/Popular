# Popular Movie AI Studio Roadmap

## 产品目标

第一阶段交付一个支持多用户的电影发现与个人电影状态应用。用户可以注册、登录、维护头像和基础资料、浏览 TMDB 本周电影趋势、搜索电影，并记录自己对电影的观看状态。

第一阶段只实现一条完整垂直链路：

```text
注册或登录
  → 设置头像和用户资料
  → 浏览本周流行电影
  → 搜索电影
  → 标记已看、想看或不想看
  → 查看自己的电影状态列表
  → 登出
```

## 第一阶段范围

### 页面能力

- 默认展示“本周流行”。
- 顶部提供电影搜索框。
- 搜索框清空后恢复“本周流行”。
- 搜索输入约 300ms debounce。
- 新搜索必须取消旧请求，或忽略旧请求的迟到响应。
- 使用“加载更多”，不实现复杂分页组件。
- 每张电影卡片展示：
  - 海报；
  - 本地化标题；
  - 原始标题（可选）；
  - 上映日期或年份；
  - TMDB 评分（可选）；
  - 用户电影状态控件。
- 状态控件支持“已看”“想看”“不想看”，当前状态必须有明确的选中表现。
- 未设置状态的电影显示为默认“未看”。
- 状态操作失败时回滚乐观更新并显示错误。
- 海报缺失时使用统一占位图。
- 提供“我的电影”页面，可以按已看、想看和不想看查看电影。
- 提供用户设置页面，支持修改显示名称、头像和密码。
- 未登录用户可以浏览和搜索；修改电影状态或用户设置时要求登录。

### 用户能力

- 邮箱和密码注册。
- Google 登录以及与已有邮箱账户的安全绑定。
- 登录、查询当前用户、登出。
- 上传、更换和删除用户头像。
- 修改显示名称和密码；第一阶段不支持修改注册邮箱。
- 每个用户只能读取和修改自己的用户资料与电影状态。
- `ownerId` 必须来自服务端认证上下文，不能接受客户端指定的用户 ID。

### 明确不做

- 日历视图；
- 平台筛选；
- 地区筛选；
- 复杂排序；
- 电视剧；
- 独立 IMDb 数据补充；
- M-Team 状态；
- Agent 推荐；
- 通知；
- 多因素认证；
- 管理后台；
- 复杂角色权限；
- TMDB 全量镜像；
- 最近 14 天批量同步。

邮箱验证和密码找回暂不进入第一阶段，但在公开部署前应作为后续安全工作补充。没有邮箱验证时，不允许仅凭相同邮箱静默合并 Google 与密码账户。

## 技术选型

### 后端

- Node.js；
- TypeScript；
- Fastify；
- Mongoose 作为 MongoDB ODM/数据访问层（底层使用 MongoDB Node.js Driver）；
- Redis 保存用户 session；
- MinIO 保存用户头像等对象文件。

### 前端

- Vue；
- TypeScript；
- Vite。

### Contract-first 接口开发

- 所有前后端共享接口必须先在 `packages/contract` 定义，再实现后端路由和前端调用。
- `packages/contract` 是请求参数、请求 body、成功响应、错误响应、分页结构、错误码和枚举的唯一事实来源。
- Contract 必须同时提供运行时校验 schema 和从 schema 推导的 TypeScript 类型，不能只声明无法运行时校验的 interface。
- Fastify 路由直接使用 Contract schema 校验输入和序列化输出，并据此生成 OpenAPI。
- Vue 前端只能从 `packages/contract` 导入接口类型和枚举，不能在页面或请求层复制 DTO。
- Mongoose 文档类型属于服务端持久化实现，不得作为 API Contract 暴露给前端。
- API 发生不兼容变更时，必须先修改 Contract 和 Contract 测试，再修改后端与前端。

### 模块和文件组织

- 一个文件只承担一个清晰职责；connector、schema、store、service、route、job 和 contract 不得合并成单个大文件。
- 相关文件必须归类到明确目录，禁止把业务文件平铺在 `src` 根目录或放入含义不明的通用 `utils` 目录。
- MongoDB connector、各集合 schema 和 store 分成不同文件，但统一放在 MongoDB 基础设施目录。
- Route 只负责 HTTP 协议适配和调用 service，不直接调用 Mongoose。
- Service 负责业务规则，通过 store 接口访问数据，不依赖 Fastify request/reply。
- Store 负责查询和持久化，不包含 HTTP 或页面业务。
- 测试文件与被测模块放在同一功能目录或对应的测试目录，并保持相同模块结构。

建议目录结构：

```text
apps/
  api/
    src/
      app.ts
      server.ts
      infrastructure/
        mongodb/
          connector.ts
          user.schema.ts
          user.store.ts
          auth_identity.schema.ts
          auth_identity.store.ts
          movie.schema.ts
          movie.store.ts
          movie_result_set.schema.ts
          movie_result_set.store.ts
          user_movie_state.schema.ts
          user_movie_state.store.ts
          sync_job.schema.ts
          sync_job.store.ts
        redis/
          connector.ts
          session.store.ts
          distributed_lock.store.ts
        minio/
          connector.ts
          avatar.store.ts
        tmdb/
          client.ts
          movie.mapper.ts
      modules/
        auth/
          auth.routes.ts
          auth.service.ts
          google_oauth.service.ts
        users/
          user.routes.ts
          user.service.ts
        movies/
          movie.routes.ts
          movie.service.ts
        movie_statuses/
          movie_status.routes.ts
          movie_status.service.ts
        sync/
          trending_sync.service.ts
          sync_scheduler.ts
      jobs/
        sync_trending.ts
  web/
    src/
      assets/
        default-avatar.png
      features/
        auth/
        users/
        movies/
        movie_statuses/
packages/
  contract/
    src/
      common/
        error.schema.ts
        pagination.schema.ts
      auth/
      users/
      movies/
      movie_statuses/
```

目录表达模块归属，文件名表达单一职责。共享基础设施可以被多个业务模块调用，但业务模块之间不能通过导入对方的 Mongoose schema 形成隐式耦合。

### 外部基础设施

- MongoDB、Redis 和 MinIO 均连接远程服务，不假定与应用运行在同一主机。
- 所有连接信息、凭据、TLS 选项和 bucket 名称均通过环境变量注入。
- 仓库只提交 `.env.example`，真实 `.env` 不进入版本控制。
- 应用启动时集中校验必需环境变量；配置缺失或格式错误时应立即停止启动，不能带错误配置继续运行。
- API 路由统一使用 `/api/v1` 前缀。

## 日志规范

### HTTP 访问日志

每个路由请求完成后必须输出一条 Apache Combined Log Format 访问日志：

```text
::1 - - [11/Oct/2026:19:58:00 +0000] "GET /api/v1/users HTTP/1.1" 200 426 "-" "Mozilla/5.0..."
```

字段顺序固定为：

```text
remote-address - - [UTC timestamp] "method url protocol" status response-bytes "referer" "user-agent"
```

- 日志在响应完成后写入，确保状态码和响应字节数准确。
- 时间使用 UTC 和 Apache 时间格式。
- 缺少 Referer、User-Agent 或响应长度时使用 `-`。
- 若应用位于反向代理之后，只有在明确配置可信代理范围后才能使用转发的客户端 IP，不能无条件信任 `X-Forwarded-For`。
- 健康检查是否记录访问日志必须通过显式配置决定，默认记录。

### 错误日志

- 每个路由处理器和具体业务执行函数都必须通过统一错误记录工具处理异常。
- 服务端错误日志必须包含完整 stack、错误名称、错误消息、时间、层级、业务操作名称和 `requestId`（存在请求上下文时）。
- 同一个异常跨层传播时只记录一次完整 stack，避免路由层和多个业务层重复输出相同异常；统一工具应标记异常已经记录。
- 记录错误后继续向上抛出，由 Fastify 全局错误处理器统一生成客户端响应。
- 客户端响应不得包含 stack、内部连接信息或敏感实现细节。
- 必须脱敏密码、Cookie、Authorization、session token、TMDB Token、MongoDB/Redis/MinIO 凭据和对象存储签名参数。
- 访问日志和错误日志写入标准输出/标准错误，便于部署环境集中采集。

## 外部数据源

### 本周流行

```http
GET https://api.themoviedb.org/3/trending/movie/week
```

- `week` 表示趋势统计窗口，不表示每七天才刷新一次。
- 第一阶段默认每 1 小时自动同步 Trending；同步间隔通过环境变量配置。
- Trending 首页读取 MongoDB；只有明确的 Load More 操作可以在用户请求期间触发下一页 TMDB 同步。
- 每次从 TMDB 获得结果后，将每部电影作为独立记录 upsert 到 `movies`。
- 榜单只保存有序的 `tmdbId` 列表，不复制电影资料。
- 最新 Trending 结果不使用 TTL 自动删除；在下一次成功同步前持续提供最后一次成功结果。

### Trending 自动调度与手动入口

独立 scheduler worker 持续运行：

```bash
node dist/workers/sync-scheduler.js
```

- worker 默认每 60 秒扫描 MongoDB `sync_jobs`，寻找 `nextRunAt <= now` 的启用任务。
- worker 必须作为独立部署进程随应用自动启动，并由进程管理器或容器平台负责崩溃重启。
- API 进程不运行 scheduler，避免扩容 API 实例时隐式增加调度器数量。
- 到期任务必须通过 MongoDB 原子 `findOneAndUpdate` 获取执行 lease，不能先查询再更新。
- 获取 MongoDB lease 后仍需获取 Redis 分布式锁，防止 scheduler worker 与手动命令同时执行同一任务。
- Trending 默认间隔为 3600 秒。成功后从原计划时间推进到下一个未来执行点，避免任务执行耗时造成长期时间漂移，也不补跑所有错过的周期。
- 执行失败时保留上一次成功结果，并按带上限的退避策略更新 `nextRunAt`；错误完整 stack 写入日志，MongoDB 只保存经过截断和脱敏的错误摘要。
- worker 无法连接 MongoDB 或 Redis 时不得执行无锁任务。

同时保留手动运维入口：

```bash
node dist/jobs/sync-trending.js
```

自动调度和手动命令必须调用同一个同步业务函数，不能维护两套同步实现。任务通过环境变量决定同步语言、页数、请求并发和锁超时。执行流程：

1. 生成本次执行唯一的 `runId`。
2. 使用 Redis `SET key runId NX PX ttl` 获取分布式锁。
3. 锁已存在时不执行同步，记录 `skipped` 结果并正常退出。
4. 请求配置页数的 `/trending/movie/week`。
5. 每页使用 Mongoose `bulkWrite`，按 `tmdbId` 幂等 upsert 独立电影记录。
6. 只有该页依赖的电影全部成功保存后，才更新对应的 `movie_result_sets`，避免发布引用缺失电影的榜单。
7. 输出执行结果，包括 `runId`、耗时、页数、新增数、更新数、失败数和跳过原因。
8. 使用比较 `runId` 后删除的原子操作释放锁，不能直接删除可能已经属于其他实例的锁。

锁要求：

- 锁 key 至少包含媒体类型、窗口和语言，例如 `lock:sync:trending:movie:week:zh-CN`。
- 锁必须设置 TTL，防止进程崩溃后形成永久死锁。
- 任务可能超过初始 TTL 时，使用仅锁持有者可执行的续租机制。
- Redis 不可用或无法确认锁所有权时任务必须失败退出，不能无锁继续执行。
- 同步成功退出码为 `0`；已有任务执行导致跳过时退出码也为 `0`；真正的同步错误返回非零退出码。
- CLI 任务日志使用结构化任务日志，不使用仅针对 HTTP 路由的 Combined Access Log Format。

### 电影搜索

```http
GET https://api.themoviedb.org/3/search/movie
```

- 固定传递 `language=zh-CN` 和 `include_adult=false`。
- 第一阶段不隐式传递地区参数。
- TMDB 搜索结果是权威结果源；MongoDB 是查询缓存和故障降级来源。
- 不能因为 `movies` 中存在一条标题匹配记录，就断定本地搜索结果完整。
- 只有存在未过期的同查询、同语言、同页码结果集时，才能完全从本地返回。
- 缓存不存在或已经过期时，请求 TMDB、缓存结果并返回。
- TMDB 不可用时可以返回本地部分匹配，但响应必须标记结果可能不完整。
- 不通过逐部按标题搜索来预先扩展电影库；用户真正搜索某个查询时再缓存该查询结果。

### TMDB 调用约束

- TMDB Token 只能保存在服务端，浏览器只能调用本地 API。
- 为 TMDB 请求设置超时。
- 限制后台同步并发，例如 3–5 个请求。
- 遇到 `429` 时尊重 `Retry-After`；缺少该响应头时使用带抖动的指数退避。
- 单个电影写入失败不应破坏整批同步，应记录失败并允许重试。
- 图片数据库字段只保存 TMDB path，不保存拼接后的完整 CDN URL。
- 页面或 About/Credits 中加入 TMDB 要求的来源声明。

## MongoDB 数据模型

MongoDB 集合统一使用 `snake_case` 命名；名称包含多个单词时使用下划线分隔。

第一阶段使用六个 MongoDB 集合：

```text
users
auth_identities
movies
movie_result_sets
user_movie_states
sync_jobs
```

### `users`

```text
_id
email
emailNormalized
emailVerified
displayName
avatar
status: active | disabled
createdAt
updatedAt
lastLoginAt
```

索引：

```js
{ emailNormalized: 1 } // unique
```

`avatar` 只保存文件元数据和存储 key，不将头像二进制直接写入用户文档：

```text
avatar.storageKey
avatar.mimeType
avatar.version
avatar.updatedAt
```

头像文件使用对象存储；开发环境可以通过同一存储接口使用本地实现。上传接口必须校验实际文件类型和大小，只接受允许的位图格式，并生成服务端控制的文件名。

用户未设置自定义头像时，前端使用仓库内的默认头像资源：

```text
apps/web/src/assets/default-avatar.png
```

### `auth_identities`

认证身份与用户资料分离，一个用户可以同时拥有密码身份和 Google 身份。

```text
_id
userId
provider: password | google
providerSubject
passwordHash
providerEmail
providerEmailVerified
createdAt
updatedAt
```

- `passwordHash` 只允许出现在 `provider=password` 的记录中。
- Google 身份使用 Google `sub` 作为稳定的 `providerSubject`，不能使用邮箱作为 Google 身份主键。
- 同一用户同一 provider 最多存在一个身份。

索引：

```js
{ provider: 1, providerSubject: 1 } // unique
{ userId: 1, provider: 1 }         // unique
```

### `movies`

每部电影在该集合中保存为一条独立记录。

```text
_id
tmdbId
imdbId
title
originalTitle
overview
releaseDate
posterPath
backdropPath
genreIds
genres
voteAverage
voteCount
metadataLevel: summary | detail
summarySyncedAt
detailSyncedAt
createdAt
updatedAt
```

索引：

```js
{ tmdbId: 1 } // unique
```

Trending 和 Search 返回摘要数据，只更新摘要字段和 `summarySyncedAt`，不能用列表响应中的空值覆盖已有详情字段。用户设置任意电影状态时，如果本地没有完整详情或 `detailSyncedAt` 超过 7 天，服务端调用 TMDB movie details，并只在详情成功写入后更新 `detailSyncedAt`。

### `movie_result_sets`

该集合记录一次完整的 TMDB Trending 或 Search 结果及其顺序，不保存电影资料副本。

```text
_id
key
type: trending | search
params
tmdbIds[]
page
totalPages
totalResults
fetchedAt
freshUntil
deleteAt
```

示例 key：

```text
trending:movie:week:zh-CN:1
search:movie:zh-CN:batman:1
```

索引：

```js
{ key: 1 }      // unique
{ deleteAt: 1 } // TTL, expireAfterSeconds: 0
```

`freshUntil` 和 `deleteAt` 是可选字段：

- Trending 结果由自动或手动同步任务覆盖，不设置 `deleteAt`，避免同步长期失败时首页最后一次成功数据被自动删除。
- Search 结果使用 `freshUntil` 判断是否需要刷新，并设置更晚的 `deleteAt` 供 TTL 最终清理。
- 应用层必须检查 `freshUntil`，不能依赖 MongoDB TTL 任务准时删除。

读取电影时使用 `tmdbIds` 批量查询 `movies`，然后按照 `tmdbIds` 重新排序。

### `sync_jobs`

该集合保存持久化调度状态。应用启动初始化必须以幂等 upsert 创建缺失的系统任务，不能在每次启动时重置已有任务的运行状态。

```text
_id
name
type: trending
enabled
intervalSeconds
nextRunAt
lastStartedAt
lastFinishedAt
lastSuccessAt
lastResult
lastError
leaseOwner
leaseExpiresAt
createdAt
updatedAt
```

第一阶段内置任务：

```text
name: sync_trending_movies_weekly_window
intervalSeconds: 3600
```

这里的 `weekly_window` 表示 TMDB 的趋势窗口，任务自身默认每小时执行一次。

索引：

```js
{ name: 1 } // unique
{ enabled: 1, nextRunAt: 1, leaseExpiresAt: 1 }
```

- worker 使用原子条件更新认领到期且 lease 不存在或已过期的任务。
- `leaseOwner` 使用本次执行的唯一 `runId`。
- 任务运行期间续租 MongoDB lease 和 Redis 锁。
- 完成任务时只有当前 `leaseOwner` 可以更新结果并释放 lease。
- Redis 锁冲突导致本次未执行时，不把任务推进一个完整周期，而是安排短时间后重新尝试。
- `lastError` 只保存错误类型、脱敏消息、发生时间和 `runId`；完整 stack 只写入服务端日志。

### `user_movie_states`

```text
_id
ownerId
movieId
status: unwatched | watched | interested | not_interested
statusChangedAt
createdAt
updatedAt
```

用户电影状态为四个互斥值：

- `unwatched`：未看，默认状态；
- `watched`：已看；
- `interested`：想看；
- `not_interested`：不想看。

同一用户对同一电影同一时刻只能有一个状态，切换状态时覆盖原状态。不存在对应记录时，API 仍将状态计算为默认 `unwatched`；用户显式选择“未看”时可以保存一条 `status=unwatched` 的记录，以保留用户操作。由于本地电影库不是完整 TMDB 镜像，“我的电影”中的未看列表只包含用户显式保存过的 `unwatched` 记录，不能代表所有未看电影。

索引：

```js
{ ownerId: 1, movieId: 1 } // unique
{ ownerId: 1, status: 1, statusChangedAt: -1 }
```

## Redis 会话

用户 session 保存到 Redis，不写入 MongoDB。

客户端持有安全随机的原始 session token。服务端对 token 计算 hash，并以 hash 构造 Redis key：

```text
session:<token_hash>
```

Redis value 至少包含：

```json
{
  "userId": "...",
  "createdAt": "...",
  "lastSeenAt": "..."
}
```

- Redis key 使用 30 天绝对有效期，并由 Redis TTL 自动清理。
- Session 到期时间在登录时确定，不使用滑动续期；普通请求可以按节流策略更新 `lastSeenAt`，但不能延长绝对到期时间。
- 登出时删除对应的 Redis key，使 session 立即失效。
- Redis 不可用时，受保护接口应安全失败，不能绕过认证。
- 浏览器 Cookie 使用 `HttpOnly`、生产环境 `Secure` 和 `SameSite=Lax`。

## API

所有接口的请求、响应、枚举和错误码必须先定义在 `packages/contract`。统一错误响应：

```json
{
  "error": {
    "code": "TRENDING_NOT_SYNCED",
    "message": "Trending movies are not available yet.",
    "requestId": "01..."
  }
}
```

- `code` 是前端分支处理的稳定依据。
- `message` 是允许展示给用户的安全消息。
- `requestId` 用于关联服务端访问日志和错误日志。
- 校验错误可以增加 Contract 定义的字段错误列表，但不能改变基础结构。
- 客户端响应不包含 stack、数据库错误、远程服务地址或内部凭据。

### 认证

```http
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
GET  /api/v1/auth/google/start
GET  /api/v1/auth/google/callback
```

Google 登录规则：

- OAuth `state`、PKCE verifier 和 nonce 临时状态保存在 Redis，并设置短 TTL。
- 必须校验 Google token 的签名、issuer、audience、nonce 和 `email_verified`。
- Google 身份只使用稳定的 `sub` 进行身份识别。
- Google 返回的已验证邮箱没有对应用户时，创建用户和 Google identity。
- 邮箱已存在且当前请求已经登录该用户时，将 Google identity 绑定到当前用户。
- 邮箱已存在但当前请求未登录时，不允许仅凭邮箱自动合并；要求用户先通过原密码登录，再在设置页面完成 Google 绑定。
- 该限制防止攻击者预先使用他人邮箱注册密码账户，然后在受害者使用 Google 登录后继续持有账户访问权。
- 合并只增加认证身份，不复制用户、电影状态或 session 数据，也不能产生第二个相同邮箱用户。

### 用户设置

```http
PATCH  /api/v1/users/me
PUT    /api/v1/users/me/password
PUT    /api/v1/users/me/avatar
DELETE /api/v1/users/me/avatar
```

- 所有接口都要求登录。
- `PATCH /api/v1/users/me` 第一阶段只允许修改显示名称。
- 修改密码需要提交当前密码；成功后撤销该用户的其他 session。
- 头像上传使用 `multipart/form-data`，服务端校验文件内容而不只信任扩展名或 `Content-Type`。
- 替换或删除头像后，应清理不再被引用的旧头像文件；清理失败不能破坏已经完成的用户资料更新。

### 电影

```http
GET /api/v1/movies/trending?page=1
POST /api/v1/movies/trending/load-more
GET /api/v1/movies/search?q=...&page=1
```

统一响应形状：

```json
{
  "items": [],
  "page": 1,
  "hasMore": true,
  "source": "cache",
  "resultCompleteness": "complete"
}
```

- `source` 可取 `cache`、`tmdb` 或 `local-fallback`。
- `resultCompleteness` 可取 `complete` 或 `partial`。
- 登录用户的每个电影项目包含当前用户的 `userStatus`。
- 未登录用户以及没有状态记录的登录用户，其 `userStatus` 均为 `unwatched`。
- `GET /api/v1/movies/trending` 只读取最后一次成功写入的 MongoDB 结果，并返回 `fetchedAt` 供前端判断数据时间。
- 从未成功同步 Trending 时返回明确的 `503 TRENDING_NOT_SYNCED`，不能由 Web 请求偷偷启动同步任务。
- 前端点击“加载更多”时调用 `POST /api/v1/movies/trending/load-more`，body 提交当前页码；服务端计算并同步下一页、持久化电影和结果集，然后返回新页结果。
- Load More 同步使用按窗口、语言和页码区分的 Redis 锁。相同页面已有同步执行时不得重复请求 TMDB，应等待该结果或返回可重试状态。
- Load More 路由必须限流并限制合法页码，不能让客户端任意触发无限页同步。
- 搜索分页以 TMDB 页码为基准，不能因为本地命中而跳过 TMDB 的第一页。

### 用户电影状态

```http
PUT    /api/v1/movie-statuses/:tmdbId
DELETE /api/v1/movie-statuses/:tmdbId
GET    /api/v1/movie-statuses?status=watched&page=1
```

- 三个接口都要求登录。
- PUT 和 DELETE 必须是幂等操作。
- PUT body 接受 `unwatched`、`watched`、`interested` 或 `not_interested`，并首先确保电影详情已经持久化，再 upsert `user_movie_states`。
- DELETE 删除显式状态；读取时仍返回默认 `unwatched`，重复删除视为成功。
- GET 只返回当前认证用户的数据，并支持按四个状态筛选；`status=unwatched` 只返回用户显式保存过的未看记录。

## 安全要求

- 密码使用 Argon2id 或 bcrypt hash，绝不保存明文或可逆加密密码。
- `users.emailNormalized` 使用唯一索引，重复邮箱注册返回 Contract 定义的冲突错误，不能创建第二个用户。
- 注册和登录接口进行限流。
- 登录失败统一返回“邮箱或密码错误”，不泄露邮箱是否存在。
- 所有请求使用 schema 校验。
- API 不返回 `passwordHash` 或 `tokenHash`。
- 修改状态的 Cookie 请求验证 `Origin`，必要时加入 CSRF token。
- 登出时撤销服务端 session。
- 所有 `user_movie_states` 查询必须包含认证用户的 `ownerId`。
- 头像上传限制文件大小和像素尺寸，校验文件签名，拒绝 SVG 和无法安全解码的图片。
- 头像访问地址不能暴露对象存储管理凭据。

## 实施里程碑

### M1：项目与基础设施

- 使用 Node.js、TypeScript 和 Fastify 初始化 API，使用 Vue、TypeScript 和 Vite 初始化 Web。
- 首先初始化 `packages/contract`，定义共享运行时 schema、TypeScript 类型、错误结构和枚举；后端与前端实现不得先于对应 Contract。
- 按约定目录拆分 connector、schema、store、service、route、job 和前端 feature，不创建承担多个职责的大文件。
- 使用 Mongoose 接入远程 MongoDB。
- 接入远程 Redis。
- 接入远程 MinIO 头像对象存储及其开发环境实现。
- 建立独立 scheduler worker 进程及其部署启动方式。
- 建立并校验 `.env.example` 中的环境变量，配置服务端 TMDB 客户端。
- 建立 MongoDB 集合索引和 Redis session TTL 策略。
- 添加 `/api/v1` 路由前缀、统一错误格式和输入校验。
- 实现 Apache Combined Format 路由访问日志。
- 实现带完整 stack、请求关联信息、去重标记和敏感字段脱敏的统一错误日志工具。

### M2：用户认证

- 注册、登录、当前用户和登出 API。
- 禁止重复邮箱注册。
- 实现 Google OAuth 登录以及经过原账户认证的安全身份绑定，禁止只凭相同邮箱静默合并未验证账户。
- 密码 hash 和 Redis 服务端 session。
- Session 使用 30 天绝对有效期，不滑动续期。
- Cookie、认证中间件和接口限流。
- 验证跨用户数据隔离。

### M3：用户设置

- 实现用户设置页面。
- 修改显示名称和密码。
- 上传、更换和删除头像。
- 实现头像格式、大小和像素限制以及旧文件清理。
- 修改密码后撤销其他 session。

### M4：本周流行

- 接入 `/trending/movie/week`。
- 实现 `node dist/workers/sync-scheduler.js` 自动调度进程，默认每 60 秒扫描 MongoDB 到期任务。
- 幂等初始化 `sync_jobs`，默认每小时同步一次 Trending。
- 实现 MongoDB 原子任务 lease、续租、失败退避和安全释放。
- 保留 `node dist/jobs/sync-trending.js` 手动运维入口，并与自动任务复用同一业务函数。
- 使用带 TTL、所有权校验和安全释放机制的 Redis 分布式锁，防止多实例重复同步。
- 使用 `bulkWrite` upsert 独立电影记录。
- 成功保存电影后再发布有序的 trending result set。
- Trending 首页读取 MongoDB，并实现未同步错误、由 Load More 显式触发的下一页同步和占位图。
- 实现任务退出码、统计日志、失败重试和并发执行测试。

### M5：电影搜索

- 实现查询规范化和 300ms debounce。
- 使用 result set 判断本地缓存是否完整、是否过期。
- 缓存缺失时查询 TMDB 并持久化结果。
- 实现分页、去重、请求取消和上游故障降级。

### M6：用户电影状态

- 实现 `unwatched`、`watched`、`interested` 和 `not_interested` 四种互斥状态。
- 实现幂等 PUT 和 DELETE。
- 设置状态时补全或刷新电影详情。
- 在 trending 和 search 响应中合并当前用户状态。
- 实现“我的电影”页面及按状态查看。
- 实现乐观 UI、失败回滚和错误提示。

### M7：验证与发布准备

- 完成接口、数据库和关键页面测试。
- 验证并发操作不会创建重复电影或用户电影状态记录。
- 验证无标题、无日期、无海报等降级表现。
- 验证 TMDB 超时、`429` 和不可用场景。
- 验证 Cookie、CSRF 防护和跨用户隔离。
- 验证所有路由只产生一条格式正确的访问日志。
- 验证路由和业务异常记录完整 stack，且同一异常不会被重复记录或泄露给客户端。
- 验证日志不会输出密码、Token、Cookie 或远程服务凭据。
- 加入 TMDB attribution。

## 第一阶段验收标准

- 新用户可以注册、登录、刷新页面后保持会话并正常登出。
- 用户可以修改显示名称和密码，以及上传、更换和删除头像。
- 未设置自定义头像时正确使用 `apps/web/src/assets/default-avatar.png`。
- 重复邮箱不能创建第二个用户；Google 身份只能在满足账户绑定验证规则后合并到已有用户。
- 两个用户看不到也无法修改对方的资料或电影状态。
- 首页能够展示本周流行并加载更多。
- Trending 中每部电影在 `movies` 中只有一条记录。
- Scheduler worker 可以自动发现并执行 MongoDB 中的到期 Trending 任务。
- 自动和手动 Trending 任务都可以重复安全执行，并且多实例并发时只有一个实例真正同步。
- Scheduler 重启不会重置任务进度，过期 lease 可以被其他 worker 安全接管。
- Trending API 不会隐式访问 TMDB；从未运行同步任务时返回明确的未同步错误。
- 同步失败不会覆盖最后一次成功发布的 Trending 结果。
- 搜索支持本地缓存命中；未命中或过期时访问 TMDB。
- 本地偶然存在标题匹配电影时，不会被误判为完整搜索结果。
- 快速连续输入不会被旧搜索响应覆盖。
- 用户可以把电影设为未看、已看、想看或不想看，四种状态互斥。
- 同一用户对同一电影最多只有一条显式状态记录。
- 重复设置或重置状态不会产生重复记录或错误状态。
- 刷新页面后所有用户电影状态保持一致。
- TMDB 请求失败时页面提供明确错误或带 `partial` 标记的本地降级结果。
- 缺少海报、日期或本地化标题时页面仍可正常展示。
- 每个路由请求完成后产生符合约定格式的访问日志。
- 路由或业务执行异常时，服务端日志包含完整 stack 和 `requestId`，客户端响应不包含 stack。
- 应用可以完全通过环境变量连接远程 MongoDB、Redis 和 MinIO，仓库不包含真实凭据。
- 每个 API 在后端和前端实现前已经定义于 `packages/contract`，前端不存在重复 DTO。

## 后续阶段候选

- 邮箱验证和密码重置；
- 其他第三方登录提供方与多因素认证；
- 评分、短评和状态变更历史；
- 更强的全文搜索或 MongoDB Atlas Search；
- 电影详情页；
- MCP 接口；
- Agent 推荐；
- M-Team 状态；
- 通知；
- 平台、地区、日期和高级排序筛选；
- 电视剧支持。
