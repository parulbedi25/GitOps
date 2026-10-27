#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Validate every manifest in the repository locally — the same checks CI runs.
#
#   scripts/validate-manifests.sh              # full run (needs Helm repo access)
#   scripts/validate-manifests.sh --offline    # skip upstream chart downloads
#   scripts/validate-manifests.sh --verbose
#
# Checks:
#   1. the ShopStack Helm chart lints and renders for dev, QA and prod values
#   2. every Kustomize overlay renders (environment overlays + 15 app overlays)
#   3. platform stacks render (upstream charts inflated when online)
#   4. all YAML is lint-clean (yamllint, config in .yamllint)
#   5. Grafana dashboards are valid JSON with unique uids
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OFFLINE=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --verbose) VERBOSE=1 ;;
    -h | --help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

CHART_DIR="gitops/charts/shopstack-service"
APP_OVERLAYS="gitops/apps/overlays"
ENVIRONMENTS="gitops/environments"
PLATFORM_DIRS="gitops/platform/controllers gitops/platform/observability"
CLUSTER_DIRS="gitops/clusters/dev gitops/clusters/qa gitops/clusters/prod"

pass=0
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() {
  pass=$((pass + 1))
  printf '  \033[32mok\033[0m   %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  printf '       %s\n' "$2" | head -6
}
run() { # run <label> <command...>
  local label="$1"
  shift
  local out
  if out="$("$@" 2>&1)"; then
    ok "$label"
    if [ "$VERBOSE" = 1 ]; then printf '%s\n' "$out" | sed 's/^/       /'; fi
  else
    bad "$label" "$out"
  fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 127
  }
}
need helm
need kubectl
need python3

echo "▸ Helm chart ($CHART_DIR)"
run "helm lint" helm lint "$CHART_DIR"
KUBE_VERSION=1.30.0
for env in dev qa prod; do
  overlays=()
  while IFS= read -r d; do overlays+=("$d"); done < <(find "$APP_OVERLAYS/$env" -mindepth 1 -maxdepth 1 -type d | sort)
  for o in "${overlays[@]}"; do
    service="$(basename "$o")"
    run "helm template $service ($env)" helm template "$service" "$CHART_DIR" \
      --kube-version "$KUBE_VERSION" \
      --namespace "shopstack-$env" \
      --values "$o/values.yaml"
  done
done

echo "▸ Environment overlays ($ENVIRONMENTS)"
for env in dev qa prod; do
  run "kustomize $env" kubectl kustomize "$ENVIRONMENTS/$env"
done

echo "▸ Application overlays ($APP_OVERLAYS)"
for env in dev qa prod; do
  for o in "$APP_OVERLAYS/$env"/*/; do
    run "kustomize apps/$env/$(basename "$o")" kubectl kustomize --enable-helm "$o"
  done
done

echo "▸ Cluster overlays"
for c in $CLUSTER_DIRS; do
  run "kustomize $c" kubectl kustomize "$c"
done

echo "▸ Cluster policies"
for env in dev qa prod; do
  run "kustomize security/policies/overlays/$env" kubectl kustomize "security/policies/overlays/$env"
done

echo "▸ Platform stacks"
for d in $PLATFORM_DIRS; do
  if [ "$OFFLINE" = 0 ] && kubectl kustomize --enable-helm "$d" >/dev/null 2>"$tmp/err"; then
    ok "kustomize $d (upstream charts)"
  elif [ "$OFFLINE" = 0 ] && ! grep -q "not a valid chart repository\|cannot be reached\|isn't a valid chart" "$tmp/err"; then
    bad "kustomize $d" "$(cat "$tmp/err")"
  else
    # Offline: remove helmCharts and render the hand-written resources only.
    copy="$tmp/$(basename "$d")"
    mkdir -p "$copy"
    cp -r "$d"/. "$copy"/
    python3 - "$copy/kustomization.yaml" <<'PY'
import pathlib, sys
import yaml  # noqa: S506 - local validation only
p = pathlib.Path(sys.argv[1])
doc = yaml.safe_load(p.read_text())
doc.pop("helmCharts", None)
p.write_text(yaml.safe_dump(doc, sort_keys=False))
PY
    run "kustomize $d (offline, hand-written resources)" kubectl kustomize "$copy"
  fi
done

echo "▸ Dashboards"
if python3 - <<'PY'
import json, pathlib, sys
seen, bad = {}, []
for f in sorted(pathlib.Path('gitops/platform/observability/dashboards').glob('*.json')):
    try:
        d = json.loads(f.read_text())
    except json.JSONDecodeError as exc:
        bad.append(f"{f}: {exc}")
        continue
    if d.get('uid') in seen:
        bad.append(f"{f}: duplicate uid {d.get('uid')} (also {seen[d['uid']]})")
    seen[d.get('uid')] = f
    if not d.get('panels'):
        bad.append(f"{f}: no panels")
    if d['uid'] != f.stem:
        bad.append(f"{f}: uid '{d['uid']}' does not match file name")
if bad:
    print("\n".join(bad))
    sys.exit(1)
print(f"{len(seen)} dashboards, unique uids, non-empty panels: " + ", ".join(seen))
PY
then
  ok "dashboard JSON"
else
  bad "dashboard JSON" "see the errors above"
fi

echo "▸ YAML lint"
if command -v yamllint >/dev/null 2>&1; then
  run "yamllint" yamllint -c .yamllint .
else
  echo "  skipped (yamllint not installed)"
fi

echo
if [ "$fail" -gt 0 ]; then
  printf '\033[31m%s checks failed\033[0m (%s passed)\n' "$fail" "$pass"
  exit 1
fi
printf '\033[32mAll %s checks passed\033[0m\n' "$pass"
