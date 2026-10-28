"""Diagram D — what happens when a shopper buys something.

Column layout: the shopper's request enters on the left, the saga orchestrates in
the middle, and the three domain services sit on the right.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import _draw as d

fig, ax = d.canvas(16.5, 9.4)

d.heading(
    ax,
    "ShopStack · a shopper buys something",
    "Every arrow is an HTTP call with its own deadline, retry policy and metric. "
    "The bottom band is what happens when a step fails.",
)

# ── Column 1 · edge ─────────────────────────────────────────────────────────
d.zone(ax, 1.6, 8.0, 24.0, 34.0, "1 · Edge", d.SLATE, note="one public entry")
d.card(ax, 3.0, 10.6, 21.2, 6.4, "browser", ["TLS 1.3 · HttpOnly cart cookie"], d.SLATE,
       title_size=9.0, sub_size=7.0)
d.card(ax, 3.0, 19.6, 21.2, 6.4, "ingress-nginx", ["rate limit · cert-manager cert"], d.SLATE,
       title_size=9.0, sub_size=7.0)
d.card(ax, 3.0, 28.6, 21.2, 11.8, "storefront :8080",
       ["GET / · /product/:slug", "POST /cart/items · /checkout"], d.SLATE,
       title_size=9.2, sub_size=7.2, mono="calls catalog · cart · checkout")

# ── Column 2 · orchestrator ────────────────────────────────────────────────
d.zone(ax, 28.0, 8.0, 34.0, 34.0, "2 · Orchestrator", d.GOLD, note="checkout saga")
d.card(ax, 29.4, 10.6, 31.2, 29.4, "checkout-service :8084",
       ["1  load_cart        → cart", "2  lock_cart        → cart", "3  reserve_stock    → catalog",
        "4  authorize_payment → payments", "5  capture_payment  → payments", "6  commit_stock     → catalog",
        "7  persist_order    → own store"], d.GOLD,
       title_size=9.6, sub_size=7.4, mono="POST /api/checkout + Idempotency-Key")

# ── Column 3 · domain services ─────────────────────────────────────────────
d.zone(ax, 64.6, 8.0, 33.8, 34.0, "3 · Domain services", d.MOSS, note="namespace-local")
d.card(ax, 66.0, 10.6, 31.0, 9.2, "cart-service :8082",
       ["GET  /internal/carts/:id", "POST /internal/carts/:id/lock", "POST /internal/carts/:id/clear"], d.MOSS,
       title_size=9.0, sub_size=7.0, mono="memory or Redis")
d.card(ax, 66.0, 21.6, 31.0, 9.2, "catalog-service :8081",
       ["GET  /api/products", "POST /internal/stock/reservations", "POST /internal/stock/…/commit"], d.MOSS,
       title_size=9.0, sub_size=7.0, mono="in-memory or Postgres")
d.card(ax, 66.0, 32.6, 31.0, 9.2, "payments-service :8083",
       ["POST /api/payments", "POST /api/payments/:id/capture", "POST /api/payments/:id/refund"], d.MOSS,
       title_size=9.0, sub_size=7.0, mono="idempotency-key required")

# ── Arrows ─────────────────────────────────────────────────────────────────
d.arrow(ax, (13.6, 17.0), (13.6, 19.6), d.SLATE, "https", label_off=(2.4, 0), label_ha="left")
d.arrow(ax, (13.6, 26.0), (13.6, 28.6), d.SLATE, "proxy", label_off=(2.4, 0), label_ha="left")
d.arrow(ax, (24.2, 34.4), (29.4, 34.4), d.GOLD, "POST /api/checkout", label_off=(-0.6, -1.35), label_ha="right")
d.arrow(ax, (60.6, 14.0), (66.0, 14.0), d.MOSS, "2 · 3", label_off=(0, -1.2))
d.arrow(ax, (60.6, 25.4), (66.0, 25.4), d.MOSS, "1 · 6", label_off=(0, -1.2))
d.arrow(ax, (60.6, 36.4), (66.0, 36.4), d.MOSS, "4 · 5", label_off=(0, -1.2))

# ── Failure band ───────────────────────────────────────────────────────────
d.zone(ax, 1.6, 44.6, 96.8, 10.4, "4 · When a step fails", d.PLUM, note="compensation", fill=d.tint(d.PLUM, 0.05))
d.card(ax, 3.0, 47.0, 29.2, 6.8, "card declined → 402", ["release_stock · unlock_cart"], d.PLUM,
       title_size=8.6, sub_size=7.0)
d.card(ax, 34.0, 47.0, 30.4, 6.8, "out of stock → 409", ["unlock_cart · nothing charged"], d.PLUM,
       title_size=8.6, sub_size=7.0)
d.card(ax, 66.0, 47.0, 30.4, 6.8, "dependency down → 503/504", ["saga stops, every prior step undone"], d.PLUM,
       title_size=8.6, sub_size=7.0)
ax.text(97.0, 45.6, "each compensation is metered", fontsize=6.9, color=d.PLUM, ha="right", va="center")

d.footer(
    ax,
    "A decline is a normal outcome, not an exception: stock goes back, the cart unlocks, and the shopper sees a page that says no money was taken.",
    57.4,
)

d.save(fig, "03-request-path")
