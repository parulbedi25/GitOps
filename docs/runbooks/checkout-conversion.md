# Checkout conversion dropped

**Alerts** `ShopStackCheckoutConversionDrop` · **Severity** critical · **Owner** the checkout team
**Dashboard** Grafana → `shopstack-overview` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

Fewer than **half of the checkouts started are completing**. `shopstack:checkout_conversion:ratio15m`
compares `shopstack_storefront_checkout_completed_total` with
`…_checkout_started_total`.

This is the most expensive alert in the repository: errors are visible, lost revenue is
not. A conversion drop with a flat error rate is the worst case — something is failing
_silently_.

## First five minutes

1. Break it down by result: `sum by (result) (rate(shopstack_storefront_checkout_completed_total[15m]))`. A `declined` spike is a payments story; `error` is a saga story.
2. `sum by (step, reason) (rate(shopstack_saga_compensations_total[15m]))` — which step is compensating, and why?
3. Look at the storefront's own 5xx rate and its p95. A slow checkout form that times out client-side never reaches this service.
4. Check the inventory side: a `409 out_of_stock` on a popular SKU stops checkouts without erroring.

## Confirm it is still happening

```promql
shopstack:checkout_conversion:ratio15m
```

```promql
sum by (result) (rate(shopstack_storefront_checkout_completed_total[15m]))
```

```promql
sum by (step, reason) (rate(shopstack_saga_compensations_total[15m]))
```

## Fix

Follow the compensation mix to the responsible step:

- **`load_cart` / `lock_cart`** → cart-service. See [saga-compensation](saga-compensation.md).
- **`reserve_stock`** → catalog-service, usually an inventory data problem.
- **`authorize_payment` / `capture_payment`** → payments-service. Declines are a
  normal outcome; _errors_ are not. See [payment-declines](payment-declines.md).
- **`persist_order`** → checkout-service itself; check its database or store.

Remember the design contract: a failed checkout must leave the cart unlocked and the
stock restored. If `shopstack_saga_compensations_total` is flat while conversions are
down, compensation is not running — that is a bug, not a load problem.

## Escalate

Page the checkout team immediately, and the platform team if the storefront itself is
serving errors.
