# Payment decline spike

**Alerts** `ShopStackPaymentDeclineSpike` · **Severity** warning · **Owner** the payments team
**Dashboard** Grafana → `shopstack-overview` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

More than **10 % of payment authorisations are being declined**. Some decline rate is
normal — test cards, expired cards, insufficient funds. A spike means either the
processor is having a bad day or a code path is sending bad requests.

`shopstack:payment_decline_ratio:ratio15m` separates declines from errors on purpose:
a decline is a business outcome with a `402`, an error is a bug with a `5xx`.

## First five minutes

1. `sum by (reason) (rate(shopstack_saga_compensations_total{step="authorize_payment"}[15m]))` — `card_declined` vs `processor_error`.
2. Compare with the payments-service error rate: a 5xx surge means the processor is unreachable, not that customers are unlucky.
3. Check the test-card traffic — `4000000000000002` always declines, so a load test explains a _small_ spike.
4. `shopstack_dependency_up{dependency="payments"}` on the checkout dashboard.

## Confirm it is still happening

```promql
shopstack:payment_decline_ratio:ratio15m
```

```promql
sum by (reason) (rate(shopstack_saga_compensations_total{step="authorize_payment"}[15m]))
```

## Fix

- **Processor outage** — the circuit breaker should already be failing fast. Keep
  checkout accepting orders only if the business accepts "authorise later"; otherwise
  surface the decline honestly (`402`) and let the stock unlock.
- **A code path sending invalid requests** — roll back (see
  [high-error-rate](high-error-rate.md)) and check the request payload against the
  processor's contract.
- **A single card issuer** — usually self-resolving; watch for 30 minutes before acting.

Never retry a decline automatically. Duplicate authorisations are worse than a lost
sale.

## Escalate

If declines are above 25 % or the processor is unreachable for 15 minutes, page the
payments team and check the status page.
