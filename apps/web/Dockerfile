FROM node:24-bookworm-slim AS build

COPY --from=ghcr.io/pnpm/pnpm:12.10.1 /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @movie-hub/contract build

ARG VITE_API_BASE_URL
RUN test -n "$VITE_API_BASE_URL" \
    && VITE_API_BASE_URL="$VITE_API_BASE_URL" pnpm --filter @movie-hub/web build

FROM nginx:stable-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist/ /usr/share/nginx/html/

RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 80