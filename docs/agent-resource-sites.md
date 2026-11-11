# Agent local resource sites — batch 4

## Scope and ownership

M-Team, HDArea and HDWing can now be configured, verified, enabled/disabled and removed in the Agent. Desktop and Web use the same Core service and Vue resource-sites page. Configuration works without a Popular/Gateway binding.

This batch manages local credentials and verifies the current site account. Popular resource searches, resource details and download-source resolution still use their existing routes; local-site discovery, Gateway RPC and routing selection belong to the next integration batch. The UI explicitly states that Popular search is not connected to these local configurations yet. Enabling a local site records its local preference; it does not switch cloud execution automatically.

```text
apps/helpers/agent/
├── core/src/resource-sites/
│   ├── mod.rs                    Local configuration service and atomic commits
│   ├── types.rs                  Requests, safe snapshots and persisted contracts
│   ├── verification.rs           Fixed site verification requests and identity parsers
│   └── tests.rs                  Synthetic local protocol, storage and isolation checks
├── ui/src/features/resource-sites/
│   ├── ResourceSitesPage.vue      One bilingual page for App and Web
│   ├── resource-sites.composable.ts
│   ├── resource-sites.domain.ts
│   ├── resource-sites.types.ts
│   └── resource-sites.presentation.ts
├── app/src-tauri/src/resource_sites.rs
├── app/src/desktop-agent.client.ts
├── web/server/src/server.rs
└── tools/test-site-agent.mjs       Standalone Web/Core/encrypted-store integration
```

`Agent` owns the resource-sites service and shares its CredentialStore implementation with the existing runtime. Site configuration has separate credential IDs from Gateway keys, device private keys and downloader credentials. Existing settings, device identity and task files are not migrated or overwritten by configuring a site.

## Supported credentials and verification

| Site | Inputs | Verification |
| --- | --- | --- |
| M-Team | Trusted API origin and API key | POST `/api/member/profile` with `x-api-key`; validates a successful payload and current account ID |
| HDArea | Trusted origin, Cookie and Passkey | GET `/index.php` with Cookie; requires authenticated navigation and one current-user link inside `#info_block` |
| HDWing | Trusted origin and Cookie | GET `/index.php` with Cookie; requires one current-user link inside `#site_header .userinfo` |

Defaults match the current repository: `https://api.m-team.cc`, `https://hdarea.club`, `https://hdwing.org`. The owner may explicitly enter another trusted HTTPS origin. M-Team also accepts `/api` as the API base path. Credentials, query strings, fragments and unrelated paths are rejected in the configured address. Changing a destination requires new credentials; no fallback or automatic cross-origin credential forwarding is permitted.

Verification checks authentication and the current account identity. HDArea Passkey is saved locally but is not submitted or tested by this login check. A new HDArea account requires entering its Passkey explicitly rather than retaining the previous account's value. Large string account IDs stay strings; unsafe JSON numbers, duplicate IDs, cross-origin account links and ambiguous current-user identities are rejected.

Requests have a 15-second deadline, no automatic retries, no redirect following and bounded response bodies (64 KiB for M-Team, 2 MiB for HTML sites). Login pages, browser challenges, rate limits and invalid responses are distinguished. Agent does not solve CAPTCHA, refresh login sessions or bypass site restrictions. HTTP is allowed only for explicit development loopback fixtures when `HELPER_ALLOW_INSECURE_DEV=true`; normal site origins require HTTPS.

## Credential and persistence boundaries

Desktop uses its existing OS credential store; Web/Docker uses the existing AES-GCM file store and separate master key. Credentials and private account identity remain inside that store. `resource-sites.json` holds only site/endpoint metadata, credential references, verification status, timestamps and deferred credential-cleanup references.

Each encrypted site payload also binds its site ID and exact normalized destination. Editing the metadata file cannot redirect a saved credential to a different destination. UI/API snapshots return only address, status, enabled state, verification time and credential-presence flags. Cookie, Passkey, API key and external account ID never return to the browser. Requests never put credentials in URLs or diagnostic logs.

A new credential entry is written before an atomic metadata commit. Failed replacement verification or failed credential writing preserves the prior working configuration. Superseded credentials are removed after commit. Deferred cleanup is recorded persistently so a failed credential deletion can be retried; explicit deletion reports failure while that site's cleanup remains incomplete. A broken credential entry produces a per-site error and can be removed or explicitly replaced without blocking other sites.

Each site has its own operation lock. The shared commit lock is held only around local metadata/credential work, not during remote HTTP requests. Concurrent saves to different sites retain each other's updates. Verification of saved credentials invalidates authentication/challenge failures and account changes; network failures, rate limits and redirects retain the last successful verification rather than pretending the credentials have expired. A disabled site stays disabled after reconfiguration or verification. A known-invalid site cannot be enabled until verification succeeds.

## Product behavior

The page offers editable site address, the appropriate secret inputs, Verify and save, Verify again, Enable/Disable and explicit Delete confirmation. Secrets use presence masks rather than read-back values. Address changes clear eligibility to reuse saved credentials. Cookie inputs accept up to 8192 characters, API keys 4096 and Passkeys 2048; Core enforces byte and control-character limits as well.

The feature composable owns drafts and per-site pending/error state for the full Agent UI session, so navigation and locale changes retain edits. Unmount/logout clears secret drafts; late responses do not repopulate state. Failed initial load has retry. Saved credential failures are shown per site. Unsupported older transport adapters retain the unavailable-state fallback rather than exposing a nonfunctional form.

Both hosts call fixed business operations. Desktop registers five dedicated IPC commands; Web adds the authenticated `/api/resource-sites` read endpoint and fixed configure/verify/enabled/remove endpoints. Existing session, Origin and CSRF checks apply to all Web writes. The new path reuses structured diagnostics with correlation IDs, safe site identifiers and redacted original causes. `VERBOSE=false` remains the default and no credentials are sent to the Popular cloud by these operations.

## Validation

Completed locally: 68 Rust tests, 54 frontend tests, workspace Clippy, type checking, all three frontend builds, standalone Web/encrypted-store integration and actual Chrome desktop/mobile checks. Real PT accounts, native keychain writes, Docker runtime and remote CI remain unverified. The integration also proves that the normal non-test binary rejects HTTP without contacting the synthetic site, before enabling the explicit development fixture.

```sh
pnpm --filter @movie-hub/helper-agent build
pnpm --filter @movie-hub/helper-agent test:ui
cargo test --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace
cargo clippy --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace --all-targets -- -D warnings
cargo build --locked --manifest-path apps/helpers/agent/Cargo.toml -p popular-agent-web
node apps/helpers/agent/tools/test-site-agent.mjs
```

Core tests and the standalone process integration use temporary files and synthetic local HTTP responses. They do not contact real PT sites, use real account credentials or write to real downloaders. The standalone integration exercises the actual Web authentication boundary, all three Core verifiers, encrypted file persistence, restart, disabled-state retention, expired login and credential deletion. App tests exercise its IPC adapter; a mock does not prove native OS keychain writes.

The previous batch's Docker image/start/restart acceptance remains a separate outstanding check. A new Core site test or a successful native Web run does not establish Docker, live site, native keychain or remote deployment acceptance. See `apps/helpers/agent/VALIDATION.md` for checks actually completed.

## Batch 5 routing

Popular can now opt into the locally configured sites for resource operations and download preparation. See [Agent resource routing](agent-resource-routing.md) for the business protocol, ticket ownership and batch-5 validation boundaries. Earlier validation counts above describe batch 4 only.
