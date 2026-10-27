# Pod has been unready for 15 minutes

**Alerts** `ShopStackPodNotReady` · **Severity** warning · **Owner** the service team
**Dashboard** Grafana → `shopstack-service-red` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

A pod has been `NotReady` for **15 minutes** — its readiness probe is failing, so it is
not receiving traffic. If enough replicas are unready, the Service degrades even though
no pod is crashing.

`NotReady` is the quiet version of an outage: no restarts, no error logs, just a pod the
load balancer skips.

## First five minutes

1. `kubectl -n shopstack-prod describe pod <pod> | grep -A10 Conditions` — which probe fails, and when did it last succeed?
2. `kubectl -n shopstack-prod exec <pod> -- wget -qO- localhost:8080/health/ready` — readiness usually checks its dependencies.
3. `/health/ready` returns `503` with a `dependencies` map: the failing dependency is named in the payload.
4. Check for a zero-downtime trap: a probe `initialDelaySeconds` shorter than the app's startup time marks a healthy pod unready for minutes.

## Confirm it is still happening

```promql
kube_pod_status_ready{namespace="shopstack-prod", condition="false"} == 1
```

```promql
shopstack_dependency_up{namespace="shopstack-prod"} == 0
```

## Fix

- **Dependency down** → the dependency's runbook. This pod is being honest.
- **Probe misconfigured** → fix `probes.*` in the chart values (`initialDelaySeconds`,
  `timeoutSeconds`, `failureThreshold`) via the overlay; a 1 s timeout on a 2 s check
  guarantees flapping.
- **App stuck** → restart the pod and read the startup logs; if it repeats, treat it as
  [pod-crashloop](pod-crashloop.md).

## Escalate

If more than half the replicas are unready, the service is effectively down: page the
owner.
