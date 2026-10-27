# Canary is failing

**Alerts** `ShopStackCanaryDegraded` · **Severity** critical · **Owner** the service team that opened the release
**Dashboard** Grafana → `shopstack-progressive-delivery` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

The canary pods are returning **more than 5 % 5xx** while the stable version is fine.
Argo Rollouts' `AnalysisTemplate <service>-canary` queries Prometheus during every
pause step; this alert fires in parallel so a human sees it even if the analysis is
misconfigured.

This is progressive delivery working: 5 % of production traffic is unhappy, not 100 %.

## First five minutes

1. `kubectl argo rollouts get rollout <service> -n shopstack-prod --watch` — current step, weight, and analysis run status.
2. `kubectl argo rollouts list analysisruns -n shopstack-prod` — the failed run names the query that failed.
3. `kubectl -n shopstack-prod logs -l app.kubernetes.io/name=<service> --tail=50` filtered to the canary pod.
4. Compare metrics: `shopstack:canary_error_ratio:ratio5m{service="<service>"}` against the stable series on the same panel.

## Confirm it is still happening

```promql
shopstack:canary_error_ratio:ratio5m{service="<service>"}
```

```promql
sum by (track) (rate(shopstack_http_requests_total{service="<service>", status_class="5xx"}[5m]))
```

## Fix

Abort before it spreads:

```bash
kubectl argo rollouts abort <service> -n shopstack-prod
```

`abort` sends all traffic back to the stable ReplicaSet immediately; the bad
ReplicaSet stays around at zero traffic for inspection. Then revert the promotion
commit in Git so the next sync does not restart the rollout:

```bash
git revert <promote-commit> && git push
```

Do not `promote` past a failing analysis. The whole point of the pause is that a human
decides with the numbers in front of them.

## Escalate

Page the release owner. If the canary is failing because of a platform dependency
(Prometheus down, ingress misrouting), page the platform team instead.
