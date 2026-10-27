# Rollout or deployment is stuck

**Alerts** `ShopStackRolloutStuck` · **Severity** warning · **Owner** the service team
**Dashboard** Grafana → `shopstack-progressive-delivery` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

A workload has had fewer available replicas than desired for **15 minutes** and is not
progressing. Nothing is necessarily broken for users — but the cluster is not
converging, and the next deploy will be blocked behind it.

## First five minutes

1. `kubectl argo rollouts get rollout <service> -n shopstack-prod` or `kubectl -n shopstack-prod rollout status deploy/<service>`.
2. `kubectl -n shopstack-prod get pods -o wide` — `Pending` means scheduling, `ImagePullBackOff` means registry or tag, `0/1 Running` means readiness.
3. `kubectl -n shopstack-prod describe pod <pod> | tail -20` — quota, affinity, taints, and probe failures all surface in the events.
4. Check the namespace quota: `kubectl -n shopstack-prod describe resourcequota shopstack-quota`.

## Confirm it is still happening

```promql
kube_deployment_status_replicas_unavailable{namespace="shopstack-prod"}
```

```promql
kube_resourcequota{namespace="shopstack-prod", type="used"} / kube_resourcequota{namespace="shopstack-prod", type="hard"}
```

## Fix

- **`Pending` + quota event** → [quota-saturated](quota-saturated.md).
- **`ImagePullBackOff`** → the tag does not exist or the pull secret is wrong. Verify
  with `crane manifest ghcr.io/parulbedi25/shopstack/<service>:<tag>`; if the tag is
  wrong, fix the pin in the overlay and merge.
- **Readiness probe failing** → the app is up but not ready; read its `/health/ready`
  response in the pod logs and check the dependency it checks.
- **`ProgressDeadlineExceeded`** → roll back and treat as a failed release.

## Escalate

If production has fewer ready replicas than its PDB allows for 30 minutes, page the
service owner.
