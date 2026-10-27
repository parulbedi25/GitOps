# syntax=docker/dockerfile:1.7
# Catalog service image.
#
# Build from the REPOSITORY ROOT so npm workspaces can resolve the shared
# @shopstack/telemetry package:
#
#   docker build -f apps/catalog-service/Dockerfile -t shopstack/catalog-service:1.0.0 .
#
# The image is hardened by the platform: non-root UID, read-only root filesystem,
# no service-account token, dropped capabilities (see gitops/apps/base).
ARG NODE_VERSION=22.11.0

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY packages/telemetry/package.json packages/telemetry/
COPY apps/catalog-service/package.json apps/catalog-service/
RUN npm ci --omit=dev --workspace @shopstack/catalog-service --include-workspace-root

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="shopstack/catalog-service" \
      org.opencontainers.image.description="ShopStack product catalogue and inventory reservations" \
      org.opencontainers.image.source="https://github.com/parulbedi25/GitOps" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="ShopStack"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SERVICE_NAME=catalog-service
# `tini` reaps zombies and forwards SIGTERM, which keeps Argo Rollouts' graceful
# termination honest when the container is a shell-less Node process.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/telemetry ./packages/telemetry
COPY apps/catalog-service ./apps/catalog-service
RUN chown -R node:node /app
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/catalog-service/src/index.js"]
