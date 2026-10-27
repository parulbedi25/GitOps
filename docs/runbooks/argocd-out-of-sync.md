# Argo CD application is out of sync

**Alerts** `ShopStackArgoCDAppOutOfSync` · **Severity** warning · **Owner** the platform team
**Dashboard** Grafana → `shopstack-platform` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

An Application has been `OutOfSync` for **30 minutes**. Automated sync with self-heal is
enabled everywhere, so this means Argo CD is trying and failing, or something is
permanently blocking the apply.

The usual culprits: an admission policy rejecting the object (Kyverno), a missing CRD,
an immutable field that needs manual deletion, or a cluster that cannot reach Git.

## First five minutes

1. `kubectl -n argocd get app <app>` — read `SYNC STATUS`, `HEALTH STATUS` and the message.
2. `kubectl -n argocd get app <app> -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}'` — the real error.
3. `kubectl -n argocd get app <app> -o jsonpath='{.status.operationState.message}'` — the last sync attempt's failure.
4. A Kyverno rejection shows up as a `failed to create` with the policy name: see [policy-violation](policy-violation.md).

## Confirm it is still happening

```promql
argocd_app_info{sync_status!="Synced"}
```

```promql
argocd_app_info{health_status="Degraded"}
```

## Fix

```bash
argocd app diff <app>          # what exactly differs
argocd app sync <app> --prune # retry once, watching the output
```

If the diff shows a resource that is healthy in the cluster but absent from Git, the
fix is to delete it **from the cluster** (Git is the source of truth) or add it to Git.
If the diff shows an immutable field (`spec.selector`, most commonly), the object must
be deleted and recreated — `argocd app sync <app> --force` does that deliberately and
visibly.

Never `kubectl edit` your way to `Synced`.

## Escalate

If more than three Applications are out of sync at once, suspect the repo server or
Git connectivity rather than the manifests.
