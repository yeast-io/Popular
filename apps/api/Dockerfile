FROM node:24-bookworm-slim AS build

COPY --from=ghcr.io/pnpm/pnpm:12.10.1 /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @movie-hub/contract build
RUN pnpm --filter @movie-hub/api build

RUN pnpm --filter @movie-hub/api --prod deploy /out

# Ensure compiled application and workspace dependency are included.
RUN mkdir -p /out/dist /out/node_modules/@movie-hub/contract/dist \
    && cp -a apps/api/dist/. /out/dist/ \
    && cp -a packages/contract/dist/. /out/node_modules/@movie-hub/contract/dist/

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app
COPY --from=build --chown=node:node /out/ ./

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]