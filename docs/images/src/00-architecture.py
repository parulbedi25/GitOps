"""Diagram A — the tool interaction map.

Reads as a snake: the delivery pipeline runs left to right along the top, returns
right to left through the cluster on the second row, then the runtime request path
and the feedback loop sit underneath. Each number is walked in the README.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import _draw as d

fig, ax = d.canvas(16.5, 10.3)

d.heading(
    ax,
    "ShopStack · how the tools talk to each other",
    "1→2→3→4 is the delivery pipeline; 4→5→6→7→8 is what happens inside the cluster, "
    "and 9→11 is the loop that keeps it honest. Each number is walked below.",
)

Y1, H1 = 9.0, 13.0
Y2, H2 = 26.5, 13.0
Y3, H3 = 44.5, 11.0

# ── Row 1 · delivery pipeline (left to right) ───────────────────────────────
d.zone(ax, 1.6, Y1, 22.0, H1, "1 · Source of truth", d.INK, note="github.com")
d.card(ax, 3.0, Y1 + 2.8, 19.2, None, "Git repository",
       ["main = deployable truth", "PR = the only way in", "validated by scripts/"], d.INK,
       title_size=10.0, sub_size=7.6, mono="validate-manifests.sh")

d.zone(ax, 26.4, Y1, 22.0, H1, "2 · CI pipeline", d.ACCENT, note="actions")
d.card(ax, 27.8, Y1 + 2.8, 19.2, None, "GitHub Actions",
       ["test · build · scan", "cosign sign + SBOM", "opens promotion PR"], d.ACCENT,
       title_size=10.0, sub_size=7.6, mono="trivy · syft · cosign")

d.zone(ax, 51.2, Y1, 20.6, H1, "3 · Artifact store", d.SLATE, note="ghcr.io")
d.card(ax, 52.6, Y1 + 2.8, 17.8, None, "Container registry",
       ["signed image by digest", "immutable: sha256:…"], d.SLATE,
       title_size=10.0, sub_size=7.6, mono="shopstack/<service>:x.y.z")

d.zone(ax, 74.6, Y1, 23.8, H1, "4 · GitOps controller", d.MOSS, note="argocd")
d.card(ax, 76.0, Y1 + 2.8, 20.8, None, "Argo CD",
       ["kustomize build --enable-helm", "app-of-apps + ApplicationSet"], d.MOSS,
       title_size=10.0, sub_size=7.6, mono="sync waves -20 → 30")

# ── Row 2 · inside the cluster (right to left) ──────────────────────────────
d.zone(ax, 74.6, Y2, 23.8, H2, "6 · API server", d.GOLD, note="etcd")
d.card(ax, 76.0, Y2 + 2.8, 20.8, None, "kube-apiserver",
       ["receives every apply", "asks Kyverno first", "persists desired state"], d.GOLD,
       title_size=10.0, sub_size=7.6)

d.zone(ax, 51.2, Y2, 20.6, H2, "5 · Admission gate", d.PLUM, note="kyverno")
d.card(ax, 52.6, Y2 + 2.8, 17.8, None, "Kyverno webhook",
       ["verifies signature", "checks registry + root", "audit → enforce"], d.PLUM,
       title_size=10.0, sub_size=7.6, mono="10 ClusterPolicies")

d.zone(ax, 26.4, Y2, 22.0, H2, "7 · Workloads", d.RUST, note="shopstack-*")
d.card(ax, 27.8, Y2 + 2.8, 19.2, None, "Rollout · Service · Ingress",
       ["Deployment (dev) or Rollout", "Pods · HPA · PDB · NetPol"], d.RUST,
       title_size=9.2, sub_size=7.3, mono="3 replicas behind a Service")

d.zone(ax, 1.6, Y2, 22.0, H2, "8 · Observability", d.MOSS, note="observability")
d.card(ax, 3.0, Y2 + 2.8, 19.2, None, "Prometheus · Grafana",
       ["scrapes /metrics every 30s", "4 dashboards · 16 alerts", "SLO rules · Alertmanager"], d.MOSS,
       title_size=9.8, sub_size=7.6)

# ── Row 3 · runtime request path + feedback ────────────────────────────────
d.zone(ax, 1.6, Y3, 46.0, H3, "9 · Runtime request path", d.SLATE, note="browser → order")
d.card(ax, 3.0, Y3 + 3.2, 8.4, 6.4, "browser", "TLS 1.3", d.SLATE, title_size=9.0, sub_size=7.2, align="center")
d.card(ax, 13.4, Y3 + 3.2, 10.2, 6.4, "ingress-nginx", "cert-manager", d.SLATE, title_size=8.4, sub_size=7.2, align="center")
d.card(ax, 25.6, Y3 + 3.2, 9.4, 6.4, "storefront", ":8080", d.SLATE, title_size=9.0, sub_size=7.2, align="center")
d.card(ax, 37.0, Y3 + 3.2, 9.2, 6.4, "checkout", "saga", d.SLATE, title_size=9.0, sub_size=7.2, align="center")

d.zone(ax, 48.8, Y3, 29.6, H3, "10 · Feedback loop", d.ACCENT, note="rollouts")
d.card(ax, 50.2, Y3 + 3.2, 12.4, 6.4, "AnalysisRun", "PromQL every 30s", d.ACCENT, title_size=8.4, sub_size=7.0, align="center")
d.card(ax, 64.0, Y3 + 3.2, 13.0, 6.4, "promote / abort", "100% or rollback", d.ACCENT, title_size=8.4, sub_size=7.0, align="center")
d.zone(ax, 79.8, Y3, 18.6, H3, "11 · Secrets", d.PLUM, note="ESO")
d.card(ax, 81.2, Y3 + 3.2, 15.8, 6.4, "ExternalSecret → Secret", ["cloud store → pod env"], d.PLUM,
       title_size=8.4, sub_size=7.0, align="center")


# ── Arrows: row 1 (left → right) ───────────────────────────────────────────
d.arrow(ax, (23.6, Y1 + 7.0), (26.4, Y1 + 7.0), d.ACCENT, "push", label_off=(0, -1.25))
d.arrow(ax, (26.4, Y1 + 12.2), (23.6, Y1 + 12.2), d.ACCENT, "promotion PR", rad=0.3, dashed=True, label_off=(0, -1.7))
d.arrow(ax, (48.4, Y1 + 7.0), (51.2, Y1 + 7.0), d.ACCENT, "sign + push", label_off=(0, -1.25))
d.arrow(ax, (71.8, Y1 + 7.0), (74.6, Y1 + 7.0), d.MOSS, "pull", label_off=(0, -1.25))

# ── Arrows: Argo CD → API server → Kyverno → workloads ─────────────────────
d.arrow(ax, (86.0, Y1 + 12.8), (86.0, Y2 + 2.8), d.MOSS, "server-side apply", label_off=(-1.6, -2.0), label_ha="right")
d.arrow(ax, (76.0, Y2 + 6.2), (70.4, Y2 + 6.2), d.PLUM, "admission", label_off=(-1.6, -1.4), label_ha="right", both=True)

d.arrow(ax, (51.2, Y2 + 7.0), (48.4, Y2 + 7.0), d.GOLD, "creates", label_off=(0, -1.3))

d.arrow(ax, (26.4, Y2 + 6.2), (23.6, Y2 + 6.2), d.MOSS, "scrape /metrics", label_off=(0, -1.35), both=True)


# ── Arrows: workloads → runtime path ────────────────────────────────────────
d.arrow(ax, (34.0, Y2 + 13.0), (30.3, Y3 + 3.2), d.SLATE, "serves", label_off=(-4.6, -0.6))
d.arrow(ax, (11.4, Y3 + 6.4), (13.4, Y3 + 6.4), d.SLATE)
d.arrow(ax, (23.6, Y3 + 6.4), (25.6, Y3 + 6.4), d.SLATE)
d.arrow(ax, (35.0, Y3 + 6.4), (37.0, Y3 + 6.4), d.SLATE)
d.arrow(ax, (46.2, Y3 + 6.4), (50.2, Y3 + 6.4), d.SLATE, "signals", label_off=(0, 1.45), label_size=7.0)
d.arrow(ax, (62.6, Y3 + 6.4), (64.0, Y3 + 6.4), d.ACCENT)
d.arrow(ax, (78.0, Y3 + 4.2), (78.0, Y2 + 13.0), d.ACCENT, "abort → rollback", rad=0.0, dashed=True, label_off=(-1.4, 0.1), label_ha="right")


# ── Legend ─────────────────────────────────────────────────────────────────
d.pill(ax, 1.6, 57.4, "solid = control path", d.MOSS, w=17.5)
d.pill(ax, 20.4, 57.4, "dashed = data / feedback", d.ACCENT, w=21.0)
d.footer(
    ax,
    "Every arrow is a real mechanism here: GitHub push + PR, Argo CD's repository poller, "
    "the Kyverno admission webhook, Prometheus scrape configs and Argo Rollouts AnalysisRuns.",
    62.2,
)

d.save(fig, "00-architecture")
