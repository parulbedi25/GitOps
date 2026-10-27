"""Diagram E — which directory produces what, and who applies it."""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import _draw as d

fig, ax = d.canvas(16.5, 10.6)

d.heading(
    ax,
    "ShopStack · what lives where",
    "Every row is a directory you can render locally. The last column is the only thing that ever applies it.",
)

cols = [
    ("/ path", 3.0, 33.0),
    ("/ renders", 37.0, 30.0),
    ("/ layer", 68.6, 8.4),
    ("/ applied by", 78.4, 20.6),
]

rows = [
    ("packages/telemetry", "shared runtime: logs, metrics, probes, errors", "—", "baked into every image", d.INK),
    ("apps/<service>", "5 Fastify services + Dockerfile", "—", "GitHub Actions → ghcr.io", d.INK),
    ("gitops/environments/<env>", "namespace, quota, limit range, netpol, RBAC", "0", "kubectl apply -k", d.SLATE),
    ("gitops/platform/controllers", "ingress-nginx, cert-manager, ESO, Kyverno, Rollouts", "1", "Argo CD (wave 0)", d.SLATE),
    ("gitops/charts/shopstack-service", "the one chart: Deployment/Rollout + 14 templates", "4", "Kustomize helmCharts", d.GOLD),
    ("gitops/apps/overlays/<env>/<svc>", "15 Kustomizations — the promotion surface", "5–7", "Argo CD ApplicationSet", d.RUST),
    ("gitops/clusters/<env>", "AppProjects + ApplicationSet + 4 Applications", "4", "kubectl apply -k (once)", d.GOLD),
    ("security/policies/<env>", "10 Kyverno ClusterPolicies", "2", "Argo CD (wave 5)", d.PLUM),
    ("gitops/platform/observability", "Prometheus, Grafana, 4 dashboards, 16 alerts", "3", "Argo CD (wave 10)", d.MOSS),
    ("scripts/", "dev-stack.sh · smoke-local.mjs · validate-manifests.sh", "—", "you, before every PR", d.ACCENT),
]

x0, y0 = 2.4, 9.6
row_h = 4.45
w = 96.0

# Header
ax.add_patch(d.FancyBboxPatch((x0, y0 - 0.5), w, 3.6, boxstyle="round,pad=0,rounding_size=0.5",
                              linewidth=0, facecolor=d.tint(d.INK, 0.07), zorder=2))
for label, cx, _ in cols:
    ax.text(x0 + cx - 2.4 + 1.4, y0 + 1.3, label.upper().lstrip("/ "), fontsize=6.8, fontweight="bold",
            color=d.darken(d.INK, 0.1), va="center", zorder=3)

for index, (path, renders, layer, applied_by, colour) in enumerate(rows):
    y = y0 + 3.6 + index * row_h
    if index % 2 == 1:
        ax.add_patch(d.FancyBboxPatch((x0, y), w, row_h, boxstyle="round,pad=0,rounding_size=0",
                                      linewidth=0, facecolor=d.tint(d.INK, 0.028), zorder=1))
    ax.plot([x0 + 0.2, x0 + 0.2], [y + 0.7, y + row_h - 0.7], color=colour, linewidth=2.4,
            solid_capstyle="round", zorder=2)
    ax.text(x0 + cols[0][1] - 2.4 + 1.2, y + row_h / 2, path, fontsize=7.6, family=d.MONO,
            color=d.darken(colour, 0.25), va="center", zorder=3)
    ax.text(x0 + cols[1][1] - 2.4 + 1.2, y + row_h / 2, renders, fontsize=7.4, color=d.INK,
            va="center", zorder=3)
    if layer != "—":
        cx = x0 + cols[2][1] - 2.4 + 1.2
        ax.add_patch(d.FancyBboxPatch((cx, y + row_h / 2 - 1.15), 5.0, 2.3,
                                      boxstyle="round,pad=0,rounding_size=1.1", linewidth=0,
                                      facecolor=d.tint(colour, 0.16), zorder=3))
        ax.text(cx + 2.5, y + row_h / 2 + 0.05, layer, fontsize=6.8, fontweight="bold",
                color=d.darken(colour, 0.2), ha="center", va="center", zorder=4)
    ax.text(x0 + cols[3][1] - 2.4 + 1.2, y + row_h / 2, applied_by, fontsize=7.2,
            color=d.MUTED, va="center", zorder=3)

bottom = y0 + 3.6 + len(rows) * row_h
d.pill(ax, 2.4, bottom + 1.2, "one chart, five services, three environments", d.MOSS, w=42.0)
d.pill(ax, 45.6, bottom + 1.2, "no manifest is ever applied by hand twice", d.ACCENT, w=42.0)

d.footer(
    ax,
    "Layers 0–2 own the machinery and are applied directly once per cluster; layers 3–7 are declared as Argo CD Applications and reconciled forever.",
    bottom + 5.4,
)

d.save(fig, "04-repo-map")
