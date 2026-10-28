# Checkout is compensating a lot

**Alerts** `ShopStackSagaCompensationsHigh` · **Severity** warning · **Owner** the checkout team
**Dashboard** Grafana → `shopstack-overview` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

Checkout is undoing steps at more than **0.2 per second**. Compensation is the
mechanism that keeps a distributed transaction honest — stock released, cart unlocked,
payment refunded — so a _high_ rate means the saga is frequently failing part-way
through.

Each compensation is correct. A flood of them means a dependency is unhealthy.

## First five minutes

1. `sum by (step, reason) (rate(shopstack_saga_compensations_total[10m]))` — which step fails first?
2. Compensation before `authorize_payment` costs nothing but a retry; after `capture_payment` it costs a refund. Prioritise accordingly.
3. Check the failing dependency's error rate and latency on the same dashboard.
4. `STEP_TIMEOUT_MS` (4 s in prod) vs the dependency's p99 — a timeout is a compensation with a good reason.

## Confirm it is still happening

```promql
sum by (step, reason) (rate(shopstack_saga_compensations_total[10m]))
```

```promql
shopstack:http_error_ratio:ratio5m{service=~"cart-service|catalog-service|payments-service"}
```

## Fix

Fix the dependency that is failing, not the saga. The saga is doing its job.

If compensations are caused by timeouts while the dependency is healthy, the timeout is
too tight for the current latency: that is a values change in the overlay
(`config.STEP_TIMEOUT_MS`), reviewed like any other.

If compensations are _not_ happening while failures are, the saga itself is broken —
that is a code bug and a rollback candidate.

## Escalate

If compensations exceed 1/s with `reason="processor_error"`, page payments; with
`reason="timeout"`, page the slow dependency's owner.
