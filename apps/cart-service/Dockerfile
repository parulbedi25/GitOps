# syntax=docker/dockerfile:1.7
# Cart service image.
#
# Build from the REPOSITORY ROOT so npm workspaces can resolve the shared
# @shopstack/telemetry package:
#
#   docker build -f apps/cart-service/Dockerfile -t ghcr.io/parulbedi25/shopstack/cart-service:1.0.0 .
#
# The image is hardened by the platform: non-root UID, read-only root filesystem,
# no service-account token, dropped capabilities (see gitops/apps/overlays).
ARG NODE_VERSION=22.11.0

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY packages/telemetry/package.json packages/telemetry/
COPY apps/cart-service/package.json apps/cart-service/
RUN npm ci --omit=dev --workspace @shopstack/cart-service --include-workspace-root

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="shopstack/cart-service" \
      org.opencontainers.image.description="ShopStack cart service — session carts, pricing and checkout locking" \
      org.opencontainers.image.source="https://github.com/parulbedi25/GitOps" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="ShopStack"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SERVICE_NAME=cart-service
# `tini` forwards SIGTERM and reaps zombies, keeping graceful termination honest
# for a shell-less Node process (important during canary rollouts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/telemetry ./packages/telemetry
COPY apps/cart-service ./apps/cart-service
RUN chown -R node:node /app
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/cart-service/src/index.js"]
