FROM node:24-bookworm-slim AS build

COPY --from=ghcr.io/pnpm/pnpm:12.10.1 /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @movie-hub/contract build
RUN pnpm --filter @movie-hub/helper-gateway build

RUN pnpm --filter @movie-hub/helper-gateway --prod deploy /out

RUN mkdir -p /out/dist /out/node_modules/@movie-hub/contract/dist \
    && cp -a apps/helpers/gateway/dist/. /out/dist/ \
    && cp -a packages/contract/dist/. /out/node_modules/@movie-hub/contract/dist/

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002

WORKDIR /app
COPY --from=build --chown=node:node /out/ ./

USER node
EXPOSE 3002

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/health/ready').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
