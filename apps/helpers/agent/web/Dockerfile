ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/node:24-bookworm-slim AS ui
WORKDIR /workspace
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/helpers/agent/package.json apps/helpers/agent/package.json
COPY apps/helpers/agent/ui/package.json apps/helpers/agent/ui/package.json
COPY apps/helpers/agent/web/package.json apps/helpers/agent/web/package.json
RUN pnpm install --frozen-lockfile --filter @movie-hub/helper-agent-web...
COPY apps/helpers/agent/ui apps/helpers/agent/ui
COPY apps/helpers/agent/web apps/helpers/agent/web
RUN pnpm --filter @movie-hub/helper-agent-web build

FROM ${BASE_REGISTRY}/library/rust:1.96-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/agent
COPY apps/helpers/agent/Cargo.toml apps/helpers/agent/Cargo.lock ./
COPY apps/helpers/agent/core core
COPY apps/helpers/agent/app/src-tauri app/src-tauri
COPY apps/helpers/agent/web/server web/server
RUN cargo build --locked --release -p popular-agent-web

FROM ${BASE_REGISTRY}/library/debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent && useradd --uid 10001 --gid agent --no-create-home agent \
    && mkdir -p /var/lib/popular-agent /run/agent-secrets \
    && chown agent:agent /var/lib/popular-agent /run/agent-secrets \
    && chmod 700 /var/lib/popular-agent /run/agent-secrets
COPY --from=server /workspace/agent/target/release/popular-agent-web /usr/local/bin/popular-agent-web
COPY --from=ui /workspace/apps/helpers/agent/web/dist /app/ui
USER 10001:10001
ENV AGENT_WEB_BIND=0.0.0.0:1423 \
    AGENT_WEB_ORIGIN=http://127.0.0.1:1423 \
    AGENT_DATA_DIR=/var/lib/popular-agent \
    AGENT_WEB_STATIC_DIR=/app/ui \
    AGENT_MASTER_KEY_FILE=/run/agent-secrets/master.key \
    AGENT_ADMIN_PASSWORD_FILE=/run/agent-secrets/admin-password \
    VERBOSE=false LOG_LEVEL=info
EXPOSE 1423
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/local/bin/popular-agent-web", "--health-check"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/popular-agent-web"]
