# Namespace quota nearly exhausted

**Alerts** `ShopStackNamespaceQuotaSaturated` · **Severity** warning · **Owner** the platform team
**Dashboard** Grafana → `shopstack-platform` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

An environment is at **90 % of a ResourceQuota** (CPU, memory, or pod count). The next
pod to be scheduled is rejected, and a rollout will stall with `Pending` replicas.

Dev is deliberately small (4 CPU / 8 Gi) so this alert is common there. In prod it means
capacity planning missed something.

## First five minutes

1. `kubectl -n shopstack-prod describe resourcequota shopstack-quota` — used vs hard, per resource.
2. `kubectl -n shopstack-prod get pods --sort-by=.spec.containers[0].resources.requests.cpu` — who is asking for the most?
3. Leftover ReplicaSets from aborted rollouts are the usual hidden consumer: `kubectl -n shopstack-prod get rs`.
4. Compare requests with actual usage: `kubectl -n shopstack-prod top pods`. Over-requested containers waste the quota even when idle.

## Confirm it is still happening

```promql
kube_resourcequota{namespace="shopstack-prod", type="used"} / kube_resourcequota{namespace="shopstack-prod", type="hard"}
```

```promql
sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})
```

## Fix

- **Right-size the requests** in the overlay. Requests should be near the observed p95
  usage, not the limit.
- **Raise the quota** — a change to `gitops/environments/<env>/kustomization.yaml`,
  which is exactly the kind of change that should be reviewed by someone who pays the
  bill.
- **Clean up** — old ReplicaSets disappear on their own after
  `revisionHistoryLimit`; aborted Rollouts do not, so `kubectl argo rollouts abort`
  followed by deleting the failed ReplicaSet is a legitimate cleanup.

## Escalate

If prod cannot schedule a replacement pod during a rollout, page the platform team: the
quota must be raised before the next failure.
