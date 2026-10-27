# Pod is restarting repeatedly

**Alerts** `ShopStackPodCrashLooping` · **Severity** warning · **Owner** the owning service team
**Dashboard** Grafana → `shopstack-service-red` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

A container has restarted more than three times in ten minutes. Kubernetes keeps
restarting it with exponential backoff, so the service may still be serving traffic
from the other replicas — which is exactly why this is a warning and not a page.

The usual causes, in order of frequency: a missing environment variable or secret, a
failed startup check, an out-of-memory kill, and an image that cannot start.

## First five minutes

1. `kubectl -n shopstack-prod describe pod <pod>` — read `Last State: Terminated` and the exit code: `1` is an application error, `137` is OOM or SIGKILL, `143` is a clean SIGTERM.
2. `kubectl -n shopstack-prod logs <pod> --previous` — the crash log, not the restart log.
3. OOM? Compare the last memory value with `resources.limits.memory` in the overlay.
4. Missing configuration? `kubectl -n shopstack-prod get externalsecret` — an `ExternalSecret` that cannot reach the secret store leaves the pod without its environment.

## Confirm it is still happening

```promql
sum by (pod) (rate(kube_pod_container_status_restarts_total{namespace="shopstack-prod"}[10m]))
```

```promql
kube_pod_container_status_last_terminated_reason{namespace="shopstack-prod", reason="OOMKilled"}
```

## Fix

- **OOM** — raise the limit in `gitops/apps/overlays/<env>/<service>/values.yaml` and
  merge; Argo CD applies it. If the growth is unbounded, that is a leak and a code fix.
- **Bad config or a missing secret** — fix the value or the secret store entry. Never
  `kubectl edit` a ConfigMap: the next self-heal removes it and the crash returns
  silently at 3 a.m.
- **Bad image** — roll back (see [high-error-rate](high-error-rate.md)).

## Escalate

If the pod is in `CrashLoopBackOff` with `restartPolicy: Always` and no replica can
start, the service is down: page the owner.
