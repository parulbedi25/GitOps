# Argo CD application is degraded

**Alerts** `ShopStackArgoCDAppDegraded` · **Severity** critical · **Owner** the platform team
**Dashboard** Grafana → `shopstack-platform` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

An Application has been `Degraded` for **15 minutes**: the resources exist but are not
healthy — pods crash-looping, a Rollout that cannot make progress, a Service with no
endpoints.

Degraded is the alert that means users are affected. Out-of-sync is a Git problem;
degraded is a runtime problem.

## First five minutes

1. `kubectl -n argocd get app <app> -o jsonpath='{.status.resources}'` — which object is unhealthy?
2. Follow that object: `kubectl -n <ns> describe pod <pod>` or `kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -30`.
3. If the app is a platform controller (Kyverno, cert-manager, ingress-nginx), check its own namespace first — every other alert after that is noise.
4. `kubectl -n argocd logs deploy/argocd-application-controller --tail=100` if several apps degrade together.

## Confirm it is still happening

```promql
argocd_app_info{health_status="Degraded"}
```

```promql
kube_pod_container_status_waiting_reason{namespace="shopstack-prod"}
```

## Fix

Fix the underlying resource, not the status. The paths are the same as for any workload:
[rollout-stuck](rollout-stuck.md), [pod-crashloop](pod-crashloop.md),
[quota-saturated](quota-saturated.md).

If the Application itself is the problem (a bad manifest that cannot apply), revert the
commit that introduced it — Argo CD will prune back to the last good revision.

If Argo CD itself is unhealthy, that is the platform emergency: `kubectl -n argocd get
pods` and the `argocd-server` logs, and treat every other alert as stale.

## Escalate

Page the platform team immediately. If `argocd-server` or the application controller is
down, no environment can be trusted to reflect Git.
