# Agent Web / Docker

For deployment, start with the [English README](../apps/helpers/agent/web/README.md) or [Chinese README](../apps/helpers/agent/web/README.zh-CN.md). Both cover Docker CLI startup, optional Compose deployment, and initial configuration.

Status: native `linux/amd64` and `linux/arm64` Docker images passed build/start/restart and encrypted-volume lifecycle checks in [GitHub Actions run 43034118917](https://github.com/yeast-io/Popular/actions/runs/43034118917). This guide also describes native development and advanced host configuration.

## Responsibility and scope

`web/` is a second host for the existing `core/` and `ui/`, alongside desktop `app/`. It has no duplicate Gateway client, downloader implementation, task runtime or product pages. A single Rust process owns the HTTP management service and one Core runtime. Closing the browser or logging out leaves Core running; stopping the container stops Core gracefully. Docker restart policy provides service startup rather than the desktop OS startup option.

The host supports Gateway setup and explicit device binding, qBittorrent/Transmission configuration, pending tasks, observed runtime updates, disconnect/reset and locale preferences. [Local site configuration and verification](agent-resource-sites.md) and [Agent resource routing](agent-resource-routing.md) now provide site search, resource details and local torrent preparation when Agent mode is enabled in Popular.

```text
apps/helpers/agent/
├── core/                         One shared business runtime
├── ui/                           One bilingual product interface
├── app/                          Tauri desktop host
└── web/
    ├── src/
    │   ├── WebRoot.vue           Login boundary and shared AgentRoot
    │   ├── management.composable.ts
    │   ├── web-agent.client.ts   Fixed same-origin API and SSE adapter
    │   └── web-agent.types.ts
    ├── server/src/
    │   ├── main.rs               Signals, initialization and health command
    │   ├── server.rs             HTTP host, authentication boundary and Core facade
    │   ├── auth.rs               Password verification, sessions and login throttling
    │   ├── config.rs             Explicit paths and public origin validation
    │   ├── credentials.rs        Encrypted CredentialStore implementation
    │   └── management_schema.rs  Strict HTTP request validation
    ├── Dockerfile
    ├── Dockerfile.dockerignore
    └── compose.yaml
```

## Local development

From the repository root:

```sh
pnpm --filter @movie-hub/helper-agent-web build
cargo build --locked --manifest-path apps/helpers/agent/Cargo.toml -p popular-agent-web
apps/helpers/agent/target/debug/popular-agent-web --init-secrets .data/agent-secrets
cargo run --locked --manifest-path apps/helpers/agent/web/server/Cargo.toml
```

Open `http://127.0.0.1:1423`. Retrieve the generated local password with `cat .data/agent-secrets/admin-password`. The password is for this Agent's management interface, separately from the Popular account API key. Do not send it to Popular or put it in browser storage. Initialization refuses a nonempty secrets directory and never overwrites an existing key. Restart by rerunning the server command; do not initialize again.

For frontend hot reload, start the Rust server with `AGENT_WEB_ORIGIN=http://127.0.0.1:1424`, and run `pnpm --filter @movie-hub/helper-agent-web dev` in a second terminal. Vite proxies `/api` with the original Host and Origin; production serves UI and API from one Rust process and requires no Node runtime.

## Docker startup

The Compose file pulls a published image by default and can also be used outside the source checkout. From the repository root:

```sh
docker compose -f apps/helpers/agent/web/compose.yaml pull agent
docker compose -f apps/helpers/agent/web/compose.yaml --profile setup run --rm init-secrets
docker compose -f apps/helpers/agent/web/compose.yaml up -d agent
docker compose -f apps/helpers/agent/web/compose.yaml exec agent cat /run/agent-secrets/admin-password
```

Open `http://127.0.0.1:1423`. Run initialization once per new installation. Repeated `up` or container recreation keeps the two named volumes. `agent-data` contains settings, identity, journal and encrypted credential envelopes; `agent-secrets` separately contains the 32-byte encryption key and management password. The running service mounts secrets read-only. Back up both volumes securely; data alone cannot decrypt credentials. Missing, wrong or corrupted keys fail startup rather than silently making a new device identity. Stop/recreate with Compose; do not use `down -v` unless intentionally deleting the installation.

The image runs UID/GID `10001:10001`, with a read-only root filesystem, no Linux capabilities and no-new-privileges. Only the data volume and `/tmp` are writable. It includes `/health/live`, `/health/ready` and a standalone `--health-check` used by Docker. The default port is published to the host loopback interface only.

For LAN access, explicitly set the publish interface and the exact browser origin in the same terminal before starting/recreating the service:

```sh
export AGENT_PUBLISH_ADDRESS=0.0.0.0
export AGENT_WEB_ORIGIN=http://192.168.1.10:1423
docker compose -f apps/helpers/agent/web/compose.yaml up -d agent
```

Replace the example IP with the Docker host address. On a phone, open that exact origin while connected to the same LAN/VPN. A Docker host is not the phone: downloader addresses must be reachable **from the container**. `127.0.0.1` inside Docker points to the container. Use downloader LAN addresses or a shared Docker network. Docker Desktop also supports `host.docker.internal`; Linux requires an explicitly configured reachable host address/network.

HTTP over the LAN does not encrypt passwords or configuration requests. Use HTTPS at a reverse proxy or a trusted VPN when the network is not trusted. The service itself is HTTP behind the proxy; preserve the original `Host` and `Origin`, set `AGENT_WEB_ORIGIN` to the public HTTPS origin and disable SSE buffering. HTTPS origins enable Secure cookies. Do not expose the default HTTP service directly to the public Internet. No reverse-proxy deployment or Internet reachability is assumed by this batch.

For a local source image, build it explicitly with `docker build -f apps/helpers/agent/web/Dockerfile -t popular-agent-web:local .` from the repository root, then set `AGENT_IMAGE=popular-agent-web:local`.

## Authentication and secret boundaries

The admin password is read from a file at startup and converted to a salted PBKDF2-HMAC-SHA256 verifier. Sessions are random, memory-only, bounded, expire after eight hours by default and are revoked by logout or process restart. The browser receives an HttpOnly/SameSite=Strict cookie and an in-memory CSRF token; there is no localStorage/sessionStorage credential persistence. Gateway keys and downloader passwords are write-only, with presence flags in settings responses. UI drafts are cleared on logout/expiry/unmount. Runtime uses authenticated SSE with polling fallback; streams are closed on logout/unmount and recheck session validity server-side.

The HTTP service rejects unexpected Host/origin, cross-site browser requests and writes without the exact configured Origin/CSRF token. There is no permissive CORS. Login is throttled by peer IP and globally; the service does not trust forwarded IP headers. JSON bodies, active connections, sessions and SSE connections are bounded. Static serving is restricted to the bundled index and assets with canonical-path checks and a restrictive CSP. Logs use the shared redacted diagnostics and correlation IDs; no request bodies, cookies, credential values or torrent URLs are logged.

Credential envelopes use AES-256-GCM, random nonces and authenticated credential IDs. Files are atomic, directory permissions are `0700` and secret/envelope files `0600` on Unix. The master key lives outside the data/static directories. This protects a stolen data-volume backup; it does not protect against a compromised Docker host or malicious Agent process. Desktop continues using its existing OS credential store; there is no automatic cross-host keychain migration.

To change the management password, replace only `admin-password` securely with a value of at least 16 bytes and restart the service; this also revokes sessions. Keep `master.key` unchanged. Key rotation/migration and multi-user management accounts are outside this batch.

## Configuration

`web/.env.example` documents the common settings without storing credentials. For Compose, explicitly pass `--env-file apps/helpers/agent/web/.env` when using a copied file from the repository root.

| Variable | Default / meaning |
| --- | --- |
| `AGENT_WEB_BIND` | Native `127.0.0.1:1423`; container `0.0.0.0:1423` |
| `AGENT_WEB_ORIGIN` | `http://127.0.0.1:1423`; one exact browser origin |
| `AGENT_DATA_DIR` | Native `.data/agent-web`; container `/var/lib/popular-agent` |
| `AGENT_WEB_STATIC_DIR` | Native `apps/helpers/agent/web/dist`; container `/app/ui` |
| `AGENT_MASTER_KEY_FILE` | Native `.data/agent-secrets/master.key`; container `/run/agent-secrets/master.key` |
| `AGENT_ADMIN_PASSWORD_FILE` | Native `.data/agent-secrets/admin-password`; container `/run/agent-secrets/admin-password` |
| `AGENT_SESSION_TTL_SECONDS` | `28800`; accepted range `60`–`86400` |
| `VERBOSE` / `LOG_LEVEL` | `false` / `info`; shared redacted diagnostics; failures remain logged |
| `AGENT_PUBLISH_ADDRESS` / `AGENT_WEB_PORT` | Compose only: `127.0.0.1` / `1423`; set origin to match any changed port |

## Verification commands

```sh
pnpm --filter @movie-hub/helper-agent build
pnpm --filter @movie-hub/helper-agent test:ui
cargo test --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace
cargo clippy --locked --manifest-path apps/helpers/agent/Cargo.toml -p popular-agent-web --all-targets -- -D warnings
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/helpers/agent/tools/test-web-agent.mjs
node apps/helpers/agent/tools/test-docker-agent.mjs popular-agent-web:local
```

The Web integration test uses real Web/Core/Gateway code with synthetic account persistence and local simulated downloaders, in temporary directories. It covers both downloader protocols, one submission, write-only credential responses, encrypted persistence, session revocation, automatic reconnect and retained device identity without repeated binding or duplicate submission. Docker smoke uses its own randomly named containers/volumes and removes only those resources. It checks non-root/read-only operation, UI, unauthenticated rejection, login/logout, health and persistence across restart. Neither test writes to real downloaders or calls a real resource site.

See `apps/helpers/agent/VALIDATION.md` for the checks actually run; CI definitions alone do not prove remote execution or multi-architecture acceptance.
