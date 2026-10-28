# Kyverno is blocking workloads

**Alerts** `ShopStackPolicyViolations` · **Severity** warning · **Owner** the platform team
**Dashboard** Grafana → `shopstack-platform` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

A ClusterPolicy in **Enforce** mode is rejecting resources. The workload it rejected is
not running — which in production means a rollout is stuck or a pod is missing.

That is the policy working as designed, and the fix is almost always in the manifest,
not in the policy.

## First five minutes

1. `kubectl get policyreport -A` / `kubectl get clusterpolicyreport` — which resource, which rule?
2. `kubectl -n shopstack-prod describe <resource>` — the admission error names the policy and the path.
3. In dev, the same change would have been _audited_ rather than blocked: `kubectl get policyreport -n shopstack-dev -o yaml | grep -A5 result`.
4. Check which policies are enforcing: `kubectl get clusterpolicy -o custom-columns=NAME:.metadata.name,ACTION:.spec.validationFailureAction`.

## Confirm it is still happening

```promql
sum by (policy) (kyverno_policy_results_total{rule_result="fail"})
```

```promql
sum by (policy) (kyverno_policy_execution_duration_seconds_count{resource_request_operation="create"})
```

## Fix

Fix the manifest in Git:

| policy                      | typical fix                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `require-standard-labels`   | add `app.kubernetes.io/name`, `part-of`, `managed-by`                                    |
| `require-pod-hardening`     | `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `drop: [ALL]`, `seccompProfile` |
| `require-resource-limits`   | set requests **and** limits                                                              |
| `require-probes`            | liveness + readiness on `/health/*`                                                      |
| `disallow-latest-tag`       | pin a tag, or better a digest                                                            |
| `restrict-image-registries` | images must come from `ghcr.io/parulbedi25`                                              |
| `verify-image-signatures`   | build through the release workflow, promote the digest                                   |

Do not add an `exceptions` block to make a deployment go through. If the policy is
genuinely wrong, change it in `security/policies/base/` and let the overlay ratchet
decide where it enforces.

## Escalate

If a production rollout is blocked by a policy that fired on a manifest which passed CI,
page the platform team: the render checks and the cluster disagree.
