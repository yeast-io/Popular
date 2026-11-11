# Shared Agent interface — batch 2

## Runtime boundaries

Agent remains inside the Popular repository. The frontend is now a shared workspace package rather than a collection of desktop-owned pages.

```text
apps/helpers/agent/
├── core/                         Existing shared Rust business runtime
├── ui/
│   ├── src/AgentRoot.vue         Shared application shell
│   ├── src/agent-session.composable.ts
│   ├── src/agent-runtime.composable.ts
│   ├── src/transport/            Business contract and client injection
│   ├── src/components/           Product components and icons
│   ├── src/features/
│   │   ├── overview/
│   │   ├── resource-sites/
│   │   ├── downloaders/
│   │   ├── tasks/
│   │   └── settings/
│   ├── src/locales/              One shared English/Chinese resource
│   └── preview/                  Explicit mock-only development entrypoint
└── app/
    ├── src/main.ts               Mounts the shared root and stylesheet
    ├── src/desktop-agent.client.ts
    └── src-tauri/                Native host, IPC commands and platform adapters
```

`AgentClient` describes settings, connection, downloader and queue operations. It does not expose an arbitrary IPC command, URL, HTTP header or credential-read operation. `AgentHost` describes optional title, startup and navigation capabilities, plus the documentation-opening action and product version. Shared pages do not import Tauri or branch on `isTauri()`. App implements those contracts using native commands. Batch 3 adds a Web host implementing the same contracts through its authenticated local HTTP service; see [Web/Docker](agent-web.md). The optional runtime subscription and sign-out capability are supplied only by hosts that support them.

The existing frontend was moved into `ui/`, not copied. Desktop tray labels and documentation URLs read the same bundled resources. Icon generation now targets shared UI assets. The desktop application identifier, credential storage, Gateway protocol and persisted data formats are unchanged. The default desktop window is wider to accommodate the product navigation.

## Product behavior

The shared shell offers Overview, Resource sites, Downloaders, Tasks and Settings. Overview shows observed connection health and links to the next useful action. It does not invent throughput, task counts or site configuration. Batch 4 adds local site configuration and credential verification when the host supplies the local resource-sites client; see [local sites](agent-resource-sites.md). Popular search routing remains outside that batch. Older adapters retain an explicit unavailable state. The download-tool setup, pending-queue paging and site cooldown details retain their existing functionality.

Form drafts live in the session composable, so internal navigation and locale changes preserve them. Only explicit verification/save actions submit credentials. Saved credentials remain represented by presence flags and a display-only mask; changing a target or authentication method does not silently reuse the previous target's secret. Reset requires an explicit in-page confirmation. No credentials are stored in browser storage.

Initial settings load has a retry state and does not expose active credential forms before it succeeds. Runtime reads are serialized. After an action, a pre-action read is discarded and a fresh status is requested. Failed reads preserve the last snapshot but present unavailable/stale state. Queue failures preserve metadata, remove a misleading live label and leave retry available. Timers, pending-response updates and late navigation subscriptions are cleaned up on unmount.

UI owns only presentation, drafts and host navigation. Core remains authoritative for connection, binding, task execution and recovery. App startup settings use the same native application/persistence/rollback logic as the tray. The desktop status response optionally includes persisted startup preference so a tray change can be reflected by the open UI.

Both languages share the same pages, including loading, errors, empty states and upcoming-feature notices. The responsive shell uses a desktop sidebar and five-column mobile navigation. Inputs and actions adapt to narrow screens; colors follow the system color scheme and loading motion honors reduced-motion preferences.

## Local verification

```sh
pnpm --filter @movie-hub/helper-agent test:ui
pnpm --filter @movie-hub/helper-agent build
pnpm --filter @movie-hub/helper-agent dev
```

An explicit, independent preview uses simulated data and never constructs the desktop adapter:

```sh
pnpm --filter @movie-hub/helper-agent dev:preview
```

Open `http://127.0.0.1:1422/preview/?locale=zh-CN`. Optional `locale=en-US`, `state=setup`, `state=error`, and `page=overview|resource-sites|downloaders|tasks|settings` select development scenarios. The preview is visibly marked as simulated and performs no device requests, OS preference changes or persistent credential writes. It is not a Web management server and is not imported by the App or UI library entrypoint.

Browser checks cover both languages, the desktop-sized layout, mobile navigation, downloader forms and queue metadata. Browser preview and native-adapter tests do not prove real OS startup permission, native documentation launch or live downloader acceptance. Those remain separate validation scopes.
