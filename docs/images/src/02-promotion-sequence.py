"""Diagram C — one promotion through the whole pipeline.

Sequence diagram: every arrow is a message between two real components, and the
numbering matches the request-path steps in the README.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import _draw as d

fig, ax = d.canvas(16.5, 11.0)

d.heading(
    ax,
    "ShopStack · one promotion, end to end",
    "A developer merges a commit. Twenty minutes later production is running it — or has rolled itself back.",
)

actors = [
    ("Developer", "pull request", d.INK),
    ("GitHub", "main branch", d.INK),
    ("Actions", "CI runner", d.ACCENT),
    ("Registry", "ghcr.io", d.SLATE),
    ("Argo CD", "repo poller", d.MOSS),
    ("Kyverno", "admission", d.PLUM),
    ("Kubernetes", "workloads", d.RUST),
    ("Prometheus", "metrics", d.MOSS),
    ("Grafana", "dashboards", d.MOSS),
]

TOP = 11.4
LANE_H = 3.72
X0, X1 = 7.4, 94.0
xs = [X0 + i * (X1 - X0) / (len(actors) - 1) for i in range(len(actors))]

for i, (name, role, colour) in enumerate(actors):
    d.card(ax, xs[i] - 4.9, TOP, 9.8, None, name, [role], colour,
           title_size=8.6, sub_size=6.8, align="center")
    ax.plot([xs[i], xs[i]], [TOP + 6.2, TOP + 6.2 + LANE_H * 13], color=d.LINE,
            linewidth=1.0, linestyle=(0, (3, 3)), zorder=0)

L = lambda i: xs[i]  # noqa: E731


def step(n, y, src, dst, label, colour=d.MUTED, dashed=False, ret=True):
    """Draw one message; `ret` draws the reply as a dashed arrow on the same row."""
    a, b = L(src), L(dst)
    if abs(a - b) < 0.01:  # self-message
        ax.add_patch(d.FancyArrowPatch((a, y), (a + 3.0, y), arrowstyle="-|>", mutation_scale=10,
                                       color=colour, linewidth=1.2, connectionstyle="arc3,rad=-0.9", zorder=2))
        ax.text(a + 3.4, y - 0.1, label, fontsize=7.4, color=d.darken(colour, 0.05), va="center")
    else:
        d.arrow(ax, (a, y), (b, y), colour, None, dashed=dashed, lw=1.2, zorder=2)
        ax.text((a + b) / 2, y - 1.15, label, fontsize=7.3, color=d.darken(colour, 0.05),
                ha="center", va="center",
                bbox=dict(facecolor=d.PAPER, edgecolor="none", pad=1.2), zorder=3)
    if n:
        ax.text(2.0, y, f"{n:02d}", fontsize=7.6, fontweight="bold", color=colour, va="center")


y = TOP + 7.4
rows = [
    (1, 0, 1, "push commit", d.INK),
    (2, 1, 2, "workflow_dispatch: test · lint · build", d.ACCENT),
    (3, 2, 3, "push image + cosign sign", d.ACCENT),
    (4, 2, 1, "open promotion PR (bumps newTag)", d.ACCENT, True),
    (5, 0, 1, "review + merge", d.INK),
    (6, 4, 1, "poll Git every 2m → new commit", d.MOSS),
    (7, 4, 5, "admission review (signature, registry)", d.PLUM),
    (8, 5, 6, "allow / deny", d.PLUM),
    (9, 4, 6, "apply Rollout at 5% canary", d.MOSS),
    (10, 7, 6, "scrape /metrics every 30s", d.MOSS, True),
    (11, 4, 7, "AnalysisRun: success ≥ 99.5%", d.ACCENT, True),
    (12, 4, 6, "setWeight 25 → 50 → 100 (or abort)", d.ACCENT),
    (13, 7, 8, "dashboards query the SLO series", d.MOSS, True),
]
for row in rows:
    n, src, dst, label, colour = row[:5]
    dashed = len(row) > 5 and row[5]
    step(n, y, src, dst, label, colour, dashed=dashed)
    y += LANE_H

d.footer(
    ax,
    "Numbers 01–13 correspond to the workflow steps in the README. The canary only reaches 100% when Prometheus agrees the new version is healthy; otherwise Argo Rollouts aborts and the old ReplicaSet keeps serving.",
    y + 2.0,
)

d.save(fig, "02-promotion-sequence")
