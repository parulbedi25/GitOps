# High error rate

**Alerts** `ShopStackHighErrorRate` · **Severity** critical · **Owner** the owning service team
**Dashboard** Grafana → `shopstack-service-red` · `shopstack-overview` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

A service is returning `5xx` for more than **2 % of requests over 5 minutes**. That is
four times the 99.5 % availability objective and burns the 30-day budget in hours.

Errors counted here are _server_ errors. A `4xx` is the caller's problem (a bad card,
an empty cart) and is tracked separately on the same dashboard.

## First five minutes

1. `kubectl -n shopstack-prod get pods -l app.kubernetes.io/name=<service>` — are all replicas Ready, or is one crash-looping?
2. `kubectl -n shopstack-prod logs deploy/<service> --tail=100 | grep -i error` — the first error line is usually the real one; the flood is the consequence.
3. Check whether the errors started at the same minute as a rollout: `kubectl -n shopstack-prod rollout history deploy/<service>` (or `kubectl argo rollouts get rollout <service>` in QA/prod).
4. Look at the dependency panel: `shopstack_dependency_up{dependency="catalog"}` at 0 means the errors are borrowed, not owned.

## Confirm it is still happening

```promql
shopstack:http_error_ratio:ratio5m{service="<service>"}
```

```promql
sum by (status_class, route) (rate(shopstack_http_requests_total{service="<service>"}[5m]))
```

## Fix

If the errors began with a deploy, **roll back first and diagnose second**:

```bash
# QA / prod (Argo Rollouts)
kubectl argo rollouts undo rollout/<service> -n shopstack-prod
# dev (plain Deployment)
kubectl -n shopstack-dev rollout undo deploy/<service>
```

Then, and this is the part that matters, revert the promotion commit in Git so the
cluster and the repository agree again — otherwise Argo CD's self-heal puts the bad
version straight back:

```bash
git revert <promote-commit> && git push   # the diff is the fix
```

If the errors are a dependency outage rather than a bad release, the fix belongs to
that dependency's runbook; this service is just reporting it.

## Escalate

Page the service owner if the error ratio stays above 5 % after a rollback, or if two
services alert within ten minutes — that pattern is a platform problem, not an app one.
