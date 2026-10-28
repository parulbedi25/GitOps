#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap a cluster with Argo CD, then hand it over to Git.
#
#   gitops/bootstrap/bootstrap.sh dev                 # install + point at dev
#   gitops/bootstrap/bootstrap.sh qa  --context kind-shopstack-qa
#   gitops/bootstrap/bootstrap.sh prod --dry-run
#
# What it does, in order:
#   1. checks kubectl/helm and that the cluster answers
#   2. installs Argo CD from a pinned chart (values/argo-cd.yaml)
#   3. waits for the API server, the repo server and the controller
#   4. applies root-app-<env>.yaml — the app-of-apps entry point
#   5. prints the admin password, the port-forward and the first thing to watch
#
# This is the only imperative step in the repository. Everything after step 4 is
# reconciled from Git, including upgrades of the platform it just installed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ARGOCD_CHART_VERSION="10.11.6" # charts/argo-cd — Argo CD v3.5.6
ARGOCD_NAMESPACE="argocd"
ENVIRONMENTS=(dev qa prod)

env_name=""
context=""
dry_run=0
timeout_s=900

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit "${1:-0}"
}

while (($#)); do
  case "$1" in
    dev | qa | prod) env_name="$1"; shift ;;
    --env) env_name="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --chart-version) ARGOCD_CHART_VERSION="${2:-}"; shift 2 ;;
    --timeout) timeout_s="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[[ -n "$env_name" ]] || die "pick an environment: bootstrap.sh dev|qa|prod"
[[ " ${ENVIRONMENTS[*]} " == *" $env_name "* ]] || die "unknown environment '$env_name' (dev|qa|prod)"

kube=(kubectl)
[[ -n "$context" ]] && kube+=(--context "$context")

if [[ $dry_run -eq 0 ]]; then
  command -v kubectl >/dev/null 2>&1 || die "kubectl is required"
  command -v helm >/dev/null 2>&1 || die "helm is required (>= 3.12)"
else
  command -v kubectl >/dev/null 2>&1 || echo "note: kubectl not found — dry run only" >&2
  command -v helm >/dev/null 2>&1 || echo "note: helm not found — dry run only" >&2
fi

run() {
  printf '\n\033[1m▸ %s\033[0m\n' "$*"
  if [[ $dry_run -eq 1 ]]; then
    printf '  (dry run)\n'
    return 0
  fi
  "$@"
}

# ── 1. preflight ────────────────────────────────────────────────────────────
if [[ $dry_run -eq 0 ]]; then
  "${kube[@]}" version --request-timeout=10s >/dev/null 2>&1 ||
    die "cannot reach the cluster — check your context with: kubectl config current-context"
fi

echo "  cluster : $("${kube[@]}" config current-context 2>/dev/null || echo '<dry run>')"
echo "  env     : $env_name"
echo "  chart   : argo-cd $ARGOCD_CHART_VERSION (namespace $ARGOCD_NAMESPACE)"

# ── 2. install Argo CD ──────────────────────────────────────────────────────
run helm repo add argo https://argoproj.github.io/argo-helm --force-update
run helm repo update argo
run helm upgrade --install argo-cd argo/argo-cd \
  --version "$ARGOCD_CHART_VERSION" \
  --namespace "$ARGOCD_NAMESPACE" \
  --create-namespace \
  --values gitops/bootstrap/values/argo-cd.yaml \
  --wait --timeout "${timeout_s}s"

# ── 3. wait for the control plane ───────────────────────────────────────────
for deployment in argocd-server argocd-repo-server argocd-applicationset-controller argocd-redis; do
  run "${kube[@]}" -n "$ARGOCD_NAMESPACE" rollout status "deploy/$deployment" --timeout="${timeout_s}s"
done
run "${kube[@]}" -n "$ARGOCD_NAMESPACE" rollout status statefulset/argocd-application-controller --timeout="${timeout_s}s"

# ── 4. hand over to Git ─────────────────────────────────────────────────────
run "${kube[@]}" apply -f "gitops/bootstrap/root-app-$env_name.yaml"

# ── 5. how to watch it converge ─────────────────────────────────────────────
cat <<EOF

Argo CD is up. The cluster now belongs to Git.

  kubectl -n $ARGOCD_NAMESPACE port-forward svc/argo-cd-argocd-server 8080:443
  open https://localhost:8080          # user: admin
  kubectl -n $ARGOCD_NAMESPACE get secret argocd-initial-admin-secret \\
    -o jsonpath='{.data.password}' | base64 -d

  watch:  kubectl -n $ARGOCD_NAMESPACE get applications -w
  order:  AppProjects (-20) → namespaces (-10) → controllers (0) → policies (5)
          → observability (10) → services (20) → storefront (30)

EOF

if [[ $dry_run -eq 0 ]]; then
  printf 'Next: wait for shopstack-root to report Synced/Healthy, then\n'
  printf '  scripts/validate-manifests.sh --offline   # prove the repo still renders\n'
fi
