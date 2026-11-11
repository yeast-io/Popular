# Agent Core and desktop host

## Batch 1 scope

The Agent remains in the Popular repository. Its existing desktop application now uses a host-independent Rust library. This batch does not add Docker, a Web management server, local resource-site credentials, or Agent resource routing. Those are subsequent batches.

```text
apps/helpers/agent/
├── Cargo.toml                 Rust workspace
├── Cargo.lock                 Shared, pinned Rust dependency graph
├── package.json               Existing helper-agent command entrypoints
├── core/
│   ├── Cargo.toml             popular-agent-core
│   └── src/                   Business operations, runtime and existing protocol
├── ui/                        Shared Vue product interface (batch 2)
├── app/
│   ├── package.json           Desktop frontend commands and dependencies
│   ├── src/                   Desktop mounting and native transport adapter
│   └── src-tauri/             Desktop shell and native platform adapters
└── tools/                     Local fixtures, icons and packaging
```

Batch 2 extracts the frontend into `ui/`; App now mounts the same shared interface intended for the future Web host. The `web/` package and Docker remain subsequent work. See [Shared Agent interface](agent-ui.md).

## Ownership and dependency direction

`app/src-tauri` depends on `popular-agent-core`; Core does not import Tauri, keyring or a Web framework. Core retains the existing Gateway challenge/proof protocol, downloader validation and execution, journal/outbox recovery, queue cache, settings validation and redacted diagnostics.

`application::Agent<C>` receives a configuration directory and an implementation of `CredentialStore`. It provides settings, binding, downloader verification/reset, locale and disconnect operations. Both the Gateway session and downloader-health loop use the same runtime, directory, credentials and configuration lock. The host polls `run()` once per instance and signals `shutdown()` on exit. Dropping the run future cancels its child futures; no independent session or health worker is spawned by Core. Already-issued external download requests cannot be undone by cancellation; the existing durable unknown-state journal remains necessary for recovery.

Runtime business snapshots and a bounded subscription stream contain connection, binding and downloader state. Subscribers read the current snapshot after a lagged event. Page selection and desktop preference feedback remain in the desktop host. The desktop adapter preserves the previous flattened JSON response expected by the existing Vue UI.

The desktop host owns the window, tray, login autostart and native credential backend. Native credential failures carry a safe category and retain their original source; diagnostics do not format credential error contents.

## Existing-installation compatibility

The Tauri identifier remains `com.popular.helper-agent`. The host continues to use Tauri's existing application configuration and log directories. Native credential entries retain service `com.popular.helper-agent` and their stored IDs. Settings, device identity, downloader association, journal and queue-cache names and formats remain unchanged. Source-directory moves do not migrate or clear user data.

The Gateway wire version and downloader submission semantics are unchanged. This is not yet the future Agent-owned resource mode: resource credentials and sensitive download preparation remain on their current paths until later implementation batches.

## Development and verification

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @movie-hub/helper-agent build
pnpm --filter @movie-hub/helper-agent test:ui
cargo test --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace
cargo clippy --locked --manifest-path apps/helpers/agent/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path apps/helpers/agent/Cargo.toml --all --check
```

Core can be tested on Linux without desktop system libraries:

```sh
cargo test --locked --manifest-path apps/helpers/agent/Cargo.toml -p popular-agent-core
```

The existing opt-in local Gateway/downloader fixtures run with `pnpm --filter @movie-hub/helper-agent test:mock`. They require loopback listening permission and use simulated persistence/downloaders with the actual Gateway and backend domain services. The real-downloader and native credential-write tests remain separately opt-in. Local simulations do not establish production behavior, native credential access or Windows packaging acceptance.

Desktop development remains `pnpm --filter @movie-hub/helper-agent dev`; packaging remains `pnpm --filter @movie-hub/helper-agent package:macos --debug`. Rust outputs now live under `apps/helpers/agent/target/`. The packaging tool resolves the actual target directory through Cargo metadata. Existing `.env` configuration at the Agent product root remains discoverable when commands run from `app/`.

`check-agent.yml` checks headless Core on Linux and the desktop workspace/UI on macOS and Windows. Adding the workflow is not evidence that remote jobs have run. The release workflow uses the relocated Tauri configuration and workspace output paths, and compares the previous configuration path during the directory transition. This batch does not change release versions or publish artifacts.

## Web host (batch 3)

The `web/server` workspace crate embeds this same Core application runtime and supplies an encrypted file CredentialStore. It does not depend on Tauri or duplicate download/Gateway behavior. HTTP authentication and static assets belong to Web, not Core. See [Web/Docker](agent-web.md) for startup and validation boundaries.
