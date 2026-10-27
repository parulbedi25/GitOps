#!/usr/bin/env bash
# Starts the whole ShopStack application locally (no Kubernetes required).
#
#   ./scripts/dev-stack.sh            # start all five services
#   ./scripts/dev-stack.sh --stop     # stop them
#
# Each service talks to the others over localhost, exactly as it does in-cluster
# over Service DNS. Data lives in memory unless you point DATABASE_URL/REDIS_URL at
# real instances (see docker/docker-compose.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

stop_all() {
  if [[ -d "$RUN_DIR" ]]; then
    for pidfile in "$RUN_DIR"/*.pid; do
      [[ -e "$pidfile" ]] || continue
      pid="$(cat "$pidfile")"
      kill "$pid" 2>/dev/null || true
      rm -f "$pidfile"
    done
  fi
  echo "stopped"
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_all
  exit 0
fi

stop_all >/dev/null

export NODE_ENV=development
export LOG_PRETTY=true
export ALLOW_CHAOS=true
export DEPLOYMENT_ENVIRONMENT=local
export SERVICE_VERSION="${SERVICE_VERSION:-1.0.0-local}"
export CART_URL=http://localhost:8082
export CATALOG_URL=http://localhost:8081
export PAYMENTS_URL=http://localhost:8083
export CHECKOUT_URL=http://localhost:8084

start() {
  local name="$1" port="$2" entry="$3"
  PORT="$port" SERVICE_NAME="$name" node "$entry" >"$RUN_DIR/$name.log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
  echo "  ↳ $name on http://localhost:$port (logs: .run/$name.log)"
}

echo "starting ShopStack…"
start catalog-service 8081 apps/catalog-service/src/index.js
start cart-service 8082 apps/cart-service/src/index.js
PSP_WEBHOOK_SECRET=local-dev-webhook-secret-please-change start payments-service 8083 apps/payments-service/src/index.js
start checkout-service 8084 apps/checkout-service/src/index.js

# Give the APIs a moment to bind before the BFF starts calling them.
for port in 8081 8082 8083 8084; do
  for _ in $(seq 1 40); do
    if curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
done

start storefront 8080 apps/storefront/src/index.js
for _ in $(seq 1 40); do
  if curl -fsS http://localhost:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo
echo "ShopStack is up:  http://localhost:8080"
echo "Metrics:          http://localhost:8080/metrics"
echo "Stop with:        ./scripts/dev-stack.sh --stop"
