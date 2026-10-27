# Error budget nearly spent

**Alerts** `ShopStackSLOBurnRateHigh` · **Severity** warning · **Owner** the owning service team
**Dashboard** Grafana → `shopstack-overview` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

**75 % of the 30-day error budget is gone.** Nothing is on fire right now — this alert
is about the rest of the month. With a quarter of the budget left, one bad afternoon
breaks the objective.

The budget is computed from the recording rule `shopstack:slo_availability:ratio30d`
against a 99.5 % target.

## First five minutes

1. `shopstack:slo_error_budget_remaining:ratio` — how much is left, per service?
2. Find where it went: rank `shopstack:http_error_ratio:ratio5m` over the last 30 days by the largest area under the curve, not by the tallest spike.
3. Check whether the spend came from one incident (`kubectl -n observability get prometheusrule`) or from a steady drip of 5xx.

## Confirm it is still happening

```promql
shopstack:slo_error_budget_remaining:ratio
```

```promql
1 - (sum(rate(shopstack_http_requests_total{status_class!="5xx"}[30d])) / sum(rate(shopstack_http_requests_total[30d])))
```

## Fix

This is a planning signal, not an outage action. Two legitimate responses:

1. **Stop releasing non-critical changes to this service** until the budget recovers.
   That is what an error budget is _for_ — it converts an argument about risk into a
   number.
2. **Fix the largest contributor** and let the next few days repay the debt.

Raising the SLO requires the same review as any other production change, and it is a
change to `gitops/platform/observability/rules/prometheus-rules.yaml`, not a dashboard
toggle.

## Escalate

Bring it to the weekly reliability review with the burn-down chart attached.
