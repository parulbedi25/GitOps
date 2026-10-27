# Runbooks

One page per alert family. Every alert in
[`gitops/platform/observability/rules/prometheus-rules.yaml`](../../gitops/platform/observability/rules/prometheus-rules.yaml)
carries a `runbook_url` that points here and a `dashboard_url` that points at the Grafana
board to open first.

Sixteen alerts, fifteen runbooks: `ShopStackLatencyBudgetBurn` and
`ShopStackLatencyObjectiveBreach` share one page because the first five minutes are
identical.

## Start here

| Alert                              | Severity | Runbook                                       | If you read only one thing                         |
| ---------------------------------- | -------- | --------------------------------------------- | -------------------------------------------------- |
| `ShopStackHighErrorRate`           | critical | [high-error-rate](high-error-rate.md)         | roll back first, diagnose second                   |
| `ShopStackLatencyBudgetBurn`       | warning  | [high-latency](high-latency.md)               | check CPU throttling before anything else          |
| `ShopStackLatencyObjectiveBreach`  | warning  | [high-latency](high-latency.md)               | p95 above 500 ms is a product decision, not a knob |
| `ShopStackSLOBurnRateHigh`         | warning  | [error-budget-burn](error-budget-burn.md)     | stop non-critical releases                         |
| `ShopStackPodCrashLooping`         | warning  | [pod-crashloop](pod-crashloop.md)             | exit code 137 means memory, 1 means config         |
| `ShopStackCheckoutConversionDrop`  | critical | [checkout-conversion](checkout-conversion.md) | the most expensive alert in the repo               |
| `ShopStackPaymentDeclineSpike`     | warning  | [payment-declines](payment-declines.md)       | never retry a decline automatically                |
| `ShopStackSagaCompensationsHigh`   | warning  | [saga-compensation](saga-compensation.md)     | fix the dependency, not the saga                   |
| `ShopStackCanaryDegraded`          | critical | [canary-failure](canary-failure.md)           | `argo rollouts abort`, then revert Git             |
| `ShopStackRolloutStuck`            | warning  | [rollout-stuck](rollout-stuck.md)             | `Pending` is quota, `ImagePullBackOff` is the tag  |
| `ShopStackArgoCDAppOutOfSync`      | warning  | [argocd-out-of-sync](argocd-out-of-sync.md)   | read `status.operationState.message`               |
| `ShopStackArgoCDAppDegraded`       | critical | [argocd-degraded](argocd-degraded.md)         | out-of-sync is Git, degraded is runtime            |
| `ShopStackCertificateExpiringSoon` | warning  | [tls-expiry](tls-expiry.md)                   | renewal is failing, not late                       |
| `ShopStackPolicyViolations`        | warning  | [policy-violation](policy-violation.md)       | fix the manifest, never the exception list         |
| `ShopStackNamespaceQuotaSaturated` | warning  | [quota-saturated](quota-saturated.md)         | aborted Rollouts leave ReplicaSets behind          |
| `ShopStackPodNotReady`             | warning  | [pod-not-ready](pod-not-ready.md)             | `/health/ready` names the broken dependency        |

## The shape of every runbook

1. **What this means** — the mechanism, not just the symptom.
2. **First five minutes** — four commands, in order, that narrow the search.
3. **Confirm it is still happening** — the PromQL the alert uses, so you can check the
   data instead of trusting the notification.
4. **Fix** — what to change, and specifically _whether it belongs in Git_.
5. **Escalate** — the threshold at which this stops being your problem alone.

## The rule that applies to all of them

The cluster is reconciled from Git. A `kubectl edit` that makes an alert go away is
undone within two minutes by Argo CD's self-heal — which turns one incident into two.
Every fix in these pages ends in a commit, a revert, or an explicit Rollout operation
(`abort` / `undo`); nothing ends in a hand-edited object.
