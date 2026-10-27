#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Move an image tag (or digest) through dev → QA → prod.
#
#   scripts/promote.sh --service cart-service --tag 1.0.0-a1b2c3d --env dev
#   scripts/promote.sh --service all --tag 1.0.0-a1b2c3d --env qa
#   scripts/promote.sh --service checkout-service --digest sha256:… --env prod
#
# Flags:
#   --service NAME   cart-service | catalog-service | payments-service |
#                    checkout-service | storefront | all            (required)
#   --tag TAG        image tag to pin                              (or --digest)
#   --digest SHA     immutable digest to pin instead of a tag
#   --env LIST       comma-separated: dev,qa,prod                    (required)
#   --verify         render every touched overlay with kind/helm afterwards
#   --dry-run        print the diff, write nothing
#   --yes            skip the production confirmation prompt
#
# The only thing a promotion changes is the `images:` block of
# gitops/apps/overlays/<env>/<service>/kustomization.yaml. Nothing else in the
# overlay is touched, so the diff *is* the release note.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICES=(cart-service catalog-service payments-service checkout-service storefront)
ENVS=(dev qa prod)

service=""
tag=""
digest=""
env_list=""
verify=0
dry_run=0
assume_yes=0

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
    --service) service="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --digest) digest="${2:-}"; shift 2 ;;
    --env | --to) env_list="${2:-}"; shift 2 ;;
    --verify) verify=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --yes | -y) assume_yes=1; shift ;;
    -h | --help) usage 0 ;;
    *) die "unknown flag: $1 (try --help)" ;;
  esac
done

[[ -n "$service" ]] || die "--service is required"
[[ -n "$env_list" ]] || die "--env is required"
[[ -n "$tag" || -n "$digest" ]] || die "one of --tag or --digest is required"
[[ -z "$tag" || -z "$digest" ]] || die "--tag and --digest are mutually exclusive"

if [[ "$digest" == sha256:* ]]; then
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "--digest must be sha256:<64 hex characters>"
elif [[ -n "$digest" ]]; then
  die "--digest must start with sha256:"
fi

# Floating tags defeat the point of a pinned release: refuse them early instead
# of letting Kyverno's disallow-latest-tag policy reject the sync later.
case "$tag" in
  "" | latest | stable | main | master | edge)
    [[ -z "$tag" ]] || die "refusing floating tag '$tag' — pin an immutable tag or a digest"
    ;;
esac

if [[ "$service" != "all" ]]; then
  [[ " ${SERVICES[*]} " == *" $service "* ]] || die "unknown service '$service' (one of: ${SERVICES[*]}, all)"
  targets=("$service")
else
  targets=("${SERVICES[@]}")
fi

IFS=',' read -r -a requested_envs <<<"$env_list"
for env in "${requested_envs[@]}"; do
  [[ " ${ENVS[*]} " == *" $env "* ]] || die "unknown environment '$env' (one of: dev,qa,prod)"
done

command -v python3 >/dev/null 2>&1 || die "python3 is required"

if [[ " ${requested_envs[*]} " == *" prod "* && $dry_run -eq 0 && $assume_yes -eq 0 ]]; then
  printf 'Promote %s to PRODUCTION with %s? [y/N] ' "$service" "${digest:-tag $tag}"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "aborted"
fi

# ── edit one overlay ────────────────────────────────────────────────────────
# Rewrites the `newTag:`/`digest:` line that belongs to the service's image.
# Line-oriented on purpose: it keeps every comment and every other value byte
# identical, so `git diff` shows exactly one changed line per environment.
edit_overlay() {
  local file="$1" repo="$2" mode="$3" value="$4" out="$5"
  REPO="$repo" MODE="$mode" VALUE="$value" IN="$file" OUT="$out" python3 - <<'PY'
import os
import re
import sys

path, out = os.environ["IN"], os.environ["OUT"]
repo, mode, value = os.environ["REPO"], os.environ["MODE"], os.environ["VALUE"]
key, rendered = ("newTag", f'"{value}"') if mode == "tag" else ("digest", value)

lines = open(path, encoding="utf-8").read().splitlines(keepends=True)
name_re = re.compile(rf"^(\s*)-\s+name:\s*{re.escape(repo)}\s*$")
start = next((i for i, line in enumerate(lines) if name_re.match(line.rstrip("\n"))), None)
if start is None:
    sys.exit(f"no image entry for {repo} in {path}")

indent = len(name_re.match(lines[start].rstrip("\n")).group(1)) + 2
key_re = re.compile(rf"^(\s*)(newTag|digest):")

end = len(lines)
for i in range(start + 1, len(lines)):
    stripped = lines[i].lstrip()
    if not stripped or stripped.startswith("#"):
        continue
    if len(lines[i]) - len(stripped) < indent and stripped.startswith("- "):
        end = i
        break

for i in range(start + 1, end):
    match = key_re.match(lines[i])
    if match:
        eol = "\n" if lines[i].endswith("\n") else ""
        lines[i] = f"{match.group(1)}{key}: {rendered}{eol}"
        break
else:
    eol = "" if not lines[start].endswith("\n") else "\n"
    lines.insert(start + 1, f"{' ' * indent}{key}: {rendered}{eol}")

with open(out, "w", encoding="utf-8") as handle:
    handle.writelines(lines)
PY
}

changed=()
for env in "${requested_envs[@]}"; do
  for target in "${targets[@]}"; do
    kfile="gitops/apps/overlays/$env/$target/kustomization.yaml"
    vfile="gitops/apps/overlays/$env/$target/values.yaml"
    [[ -f "$kfile" ]] || die "missing $kfile"
    [[ -f "$vfile" ]] || die "missing $vfile"

    registry="$(python3 - "$vfile" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding="utf-8").read()
reg = re.search(r"^\s*imageRegistry:\s*(\S+)\s*$", text, re.M)
repo = re.search(r"^\s*repository:\s*(\S+)\s*$", text, re.M)
if not reg or not repo:
    sys.exit("values file is missing global.imageRegistry or image.repository")
print(f"{reg.group(1).strip(chr(34))}/{repo.group(1).strip(chr(34))}")
PY
)" || die "could not resolve the image reference for $env/$target"

    tmp="$(mktemp)"
    if [[ -n "$digest" ]]; then
      edit_overlay "$kfile" "$registry" digest "$digest" "$tmp"
    else
      edit_overlay "$kfile" "$registry" tag "$tag" "$tmp"
    fi

    if cmp -s "$tmp" "$kfile"; then
      rm -f "$tmp"
      printf '  = %-8s %-17s already at %s\n' "$env" "$target" "${digest:-$tag}"
      continue
    fi

    if [[ $dry_run -eq 1 ]]; then
      diff -U0 "$kfile" "$tmp" | grep -E '^[+-]' | grep -vE '^(---|\+\+\+)' | sed 's|^|  |' || true
      rm -f "$tmp"
    else
      cp "$tmp" "$kfile"
      rm -f "$tmp"
    fi
    if [[ -n "$digest" ]]; then
      printf '  → %-8s %-17s %s@%s\n' "$env" "$target" "$registry" "$digest"
    else
      printf '  → %-8s %-17s %s:%s\n' "$env" "$target" "$registry" "$tag"
    fi
    changed+=("gitops/apps/overlays/$env/$target")
  done
done

echo
if ((${#changed[@]} == 0)); then
  echo "Nothing to do — every requested overlay already pins ${digest:-$tag}."
  exit 0
fi

if [[ $dry_run -eq 1 ]]; then
  echo "Dry run: ${#changed[@]} overlay(s) would change. Nothing written."
  exit 0
fi

if [[ $verify -eq 1 ]]; then
  if ! command -v helm >/dev/null 2>&1; then
    echo "skipping --verify: helm is not on PATH" >&2
  elif command -v kubectl >/dev/null 2>&1; then
    for dir in "${changed[@]}"; do
      kubectl kustomize --enable-helm "$dir" >/dev/null || die "render failed: $dir"
      printf '  ✓ %s renders\n' "$dir"
    done
  else
    echo "skipping --verify: kubectl is not on PATH" >&2
  fi
fi

echo
git --no-pager diff --stat -- "${changed[@]}"
cat <<EOF

Next:
  git add ${changed[*]}
  git commit -m "promote: ${service} ${digest:-$tag} → ${env_list}"
  git push origin HEAD
  # then open the promotion PR; Argo CD reconciles it once it merges
EOF
