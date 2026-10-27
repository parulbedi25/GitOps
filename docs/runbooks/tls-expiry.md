# TLS certificate expiring

**Alerts** `ShopStackCertificateExpiringSoon` · **Severity** warning · **Owner** the platform team
**Dashboard** Grafana → `shopstack-platform` · **Rules** `gitops/platform/observability/rules/prometheus-rules.yaml`

## What this means

A certificate expires in **under 14 days**. cert-manager renews at 30 days remaining, so
this alert means renewal is _failing_, not that it is late.

An expired certificate on the public entry point is a total outage for every customer.

## First five minutes

1. `kubectl get certificate -A | grep -v True` — list the ones not Ready.
2. `kubectl -n shopstack-prod describe certificate <name>` — read the `Issuing`/`Ready` conditions.
3. `kubectl -n shopstack-prod describe order,challenge -A | tail -40` — the ACME challenge is where every failure lives.
4. `kubectl -n cert-manager logs deploy/cert-manager --tail=50 | grep -i error`.

## Confirm it is still happening

```promql
certmanager_certificate_expiration_timestamp_seconds - time()
```

```promql
certmanager_certificate_ready_status{condition="False"}
```

## Fix

- **Challenge failing (DNS or HTTP)** — `letsencrypt-prod` uses HTTP-01: the ingress must
  be reachable on port 80 from the internet. A private cluster cannot use it; switch
  that environment to the staging issuer while testing, and use DNS-01 in production.
- **Rate limited by Let's Encrypt** — stop retrying (every retry counts against the
  limit) and switch to `letsencrypt-staging` until the configuration is fixed.
- **Wrong issuer** — the ClusterIssuer name in the ingress annotation is a one-line
  values change in the overlay.

Never disable TLS to work around an expiry. The `server.insecure` setting in this repo
is about TLS _termination_, not about running without it.

## Escalate

If any certificate has **less than 3 days** left, page the platform team and prepare to
rotate manually with a self-signed certificate as a last resort.
