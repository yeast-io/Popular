# Agent resource execution — batch 5

## Product scope

In Popular Settings → Resources, the Agent request capsule enables one bound Agent for the account. Docker/Web and desktop hosts share the same Core implementation and local site configuration. Cloud mode remains available. Enabling Agent mode changes resource search, movie availability, resource details, torrent preparation and download submission to use the selected Agent. The AI download workflow uses that device without offering cloud downloaders.

Users configure and verify M-Team, HDArea and HDWing credentials in the Agent UI. Popular receives site readiness and public resource metadata; it does not import those credentials. Cloud and Agent site defaults/selections are stored separately. Disabling Agent mode restores the existing cloud configuration. Agent mode requires the selected device to be online. An offline, unsupported, unauthorized or invalidly configured Agent produces a localized failure; there is no automatic cloud credential fallback.

The capsule is hidden behind authenticated account settings. Existing cookie authentication and request boundaries apply. Initial mode-read failure hides cloud credential forms until a successful retry; failed device discovery preserves the already-loaded execution mode. Both en-US and zh-CN are supported.

## Boundaries and flow

1. Popular authenticates the account and validates the selected bound device and authorization versions. `__agent_resource__` is a fixed business RPC, not a raw HTTP proxy.
2. Gateway resolves the live session and requires `resourceProtocol: 1`. It signs `__resource_request__` with owner/device/auth/device versions, session/instance IDs, message/correlation IDs and a bounded expiry. Cross-instance routing reuses the existing Gateway bus.
3. Agent validates the signature and full session context, then executes `list`, `search`, `detail` or `prepare`. Only three fixed site providers and validated resource IDs are supported. Secrets come from the local credential store. HTML account identity must match the locally verified account.
4. Preparation obtains the transferable URL locally, reads bounded torrent bytes locally, hashes the exact bencoded info dictionary and retains the URL in a short-lived session-local memory ticket. Only the UUID ticket and info hash return through Gateway. A repeated prepare for the same command/session/site credential version reuses the ticket.
5. The existing encrypted delivery and execution grant carry that ticket. Core checks the ticket against command, source, resource, hash, owner, device, session, instance and current local credential metadata, then submits the URL to the local downloader. The URL is not persisted in the command journal or returned to Popular.

M-Team search and torrent token preparation are supported; its search source continues to advertise no separate detail operation. HDArea and HDWing support search, public detail metadata and torrent preparation. Confirmed zero seeders remain distinct from an unknown count. HTML parsing and provider behavior still require acceptance against actual sites.

## State and failure policy

- Account preferences add the selected device, execution generation, Agent selections and Agent default. Existing cloud fields retain their meaning. Mode generations invalidate in-flight results, including a switch away and back.
- Resource search/release cache keys include execution scope and local credential version. Availability checks use separate internal provider keys for Agent scope, preserving cloud availability records.
- Remote download intents pin Agent execution and the local site credential version. Mode/device/credential changes fail preparation instead of silently preparing with another target. Existing cloud intents without the new fields retain cloud semantics.
- Authentication, account mismatch and challenge responses invalidate the affected local site. Generic transport/rate-limit failures do not erase credentials. The recognized M-Team daily-download message reuses the existing durable cooldown handling.
- Request concurrency, queued work, response bytes, torrent bytes and ticket count/lifetime are bounded. Session teardown cancels local request futures and drops tickets. Existing command queue, authorization, grant, idempotency and recovery rules remain in force.

Tracing reuses correlation IDs and redacted original causes. `VERBOSE=false` remains the default; error logging remains controlled by the existing logger level. Never enable raw HTTP/body logging for site credentials or torrent URLs.

## Directory plan implemented

```text
packages/contract/src/helper-gateway/
├── agent-resource.schema.ts             Strict request/public response schemas
├── helper-gateway.schema.ts             Internal RPC and capability validation
└── helper-gateway.types.ts              Capability and prepared torrent union
apps/helpers/gateway/src/
├── agent-resource-relay.service.ts      Signed session relay and pending requests
└── agent-resource.types.ts              Pending response contract
apps/helpers/agent/core/src/
├── resource_requests.rs                 Signed request validation/session worker
└── resource-sites/
    ├── resources.rs                     Fixed site search/detail/preparation
    ├── torrent.rs                       Exact info-dictionary hashing
    └── tickets.rs                       Memory-only URL tickets
apps/api/src/modules/agent-resources/
├── agent-resource.types.ts              Dependencies
├── agent-resource.service.ts            Account/device policy and resource RPC
├── agent-resource-source.adapter.ts     Search routing with generation guards
├── agent-resource.routes.ts             Authenticated mode read/write
└── agent-resource.service.test.ts       Isolation and download routing regression
apps/web/src/features/integrations/
├── AgentResourceSettings.vue            Capsule/device/site status UI
├── AgentResourceSettings.test.ts        Bilingual mode/error coverage
├── agent-resource.composable.ts         Reactive state/lifecycle ownership
├── agent-resource.client.ts             HTTP transport
└── agent-resource.presentation.ts       Provider display names
apps/helpers/agent/tools/
└── test-agent-resources.mjs             Native Web/Core/Gateway/API integration
```

Existing integration preferences/schema/store, resource checks/search caches, downloader services/persistence, assistant workflow, application assembly, locales and shared Agent UI scope text are updated at their existing paths.

## Reproducible checks

```sh
pnpm --filter @movie-hub/contract build
pnpm --filter @movie-hub/api typecheck
pnpm --filter @movie-hub/helper-gateway typecheck
pnpm --filter @movie-hub/web build
pnpm --filter @movie-hub/helper-agent test:resources
```

`test:resources` starts real native Web/Core and Gateway services with a synthetic PT HTTP server, memory account/command persistence and a simulated qBittorrent. It covers three-site search/detail/preparation, zero versus unknown seeders, preparation deduplication, owner rejection, local-ticket download, no credentials/token URL in cloud responses, local auth invalidation, encrypted restart with the same device, offline failure and restoration of cloud preferences. It does not prove real Mongo persistence, real PT parsing, native keychain, Docker runtime, desktop packaging or remote deployment.

Batch-5 acceptance evidence and remaining runtime checks are recorded in `apps/helpers/agent/VALIDATION.md`. API, Gateway, contract and Agent must be upgraded together; older Agents fail capability validation when enabling this mode.
