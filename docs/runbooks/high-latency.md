# Latency above objective

**Alerts** `ShopStackLatencyBudgetBurn` · `ShopStackLatencyObjectiveBreach` · **Severity** warning · **Owner** the owning service team
**Dashboard** Grafana → `shopstack-service-red` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

p95 latency is above **300 ms for 10 minutes** (budget burn) or above the **500 ms
objective for 30 minutes** (breach). Fast responses still succeed; the queue behind
them is what hurts — abandoned carts, retries, and a checkout saga that times out
mid-payment.

## First five minutes

1. `shopstack:http_latency_p95:seconds5m` by service — is it one service or the whole call path?
2. Split by route: `histogram_quantile(0.95, sum by (le, route) (rate(shopstack_http_request_duration_seconds_bucket[5m])))`. A single slow route is a query; every route is a resource problem.
3. `kubectl -n shopstack-prod top pods` and the CPU throttling panel — a container at its CPU limit gets throttled, and throttling looks exactly like slowness.
4. Check the egress side: `shopstack_dependency_up` plus the client-side timeout metrics for catalog/cart/payments calls.

## Confirm it is still happening

```promql
shopstack:http_latency_p95:seconds5m{service="<service>"}
```

```promql
shopstack:http_latency_p99:seconds5m{service="<service>"}
```

```promql
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="shopstack-prod"}[5m]))
```

## Fix

- **Throttling** — raise `resources.limits.cpu` in the environment overlay, or let the
  HPA do it (`autoscaling.enabled: true`, 65 % target on storefront and checkout).
- **A slow dependency** — the dependency's own runbook; check its p95 first.
- **A slow query or an unbounded loop** — that is a code fix, which means a release:
  the change goes through CI, and the canary analysis in QA/prod will fail fast if the
  new build is no better.

Do not raise the objective to make the alert go away. The 500 ms p95 is a product
decision, and the error budget exists so you notice when reality disagrees.

## Escalate

If p99 stays above 2 s for an hour, treat it as an availability incident: conversions
drop before errors appear.
