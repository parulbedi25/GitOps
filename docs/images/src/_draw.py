"""Shared drawing helpers for the ShopStack README diagrams.

Matplotlib only: it renders text as vector paths in the SVG output, so the
diagrams look identical on GitHub, in the Arena viewer and in a slide deck
without any font dependency.
"""
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

PAPER = "#fbf9f5"
INK = "#16130f"
MUTED = "#5b5347"
LINE = "#d9d2c5"
WHITE = "#ffffff"
MOSS = "#2f5d3a"
ACCENT = "#c2410c"
GOLD = "#b07d2b"
SLATE = "#1f4e5f"
PLUM = "#5b3f55"
RUST = "#9a3412"

FONT = "DejaVu Sans"
MONO = "DejaVu Sans Mono"

matplotlib.rcParams.update({
    "font.family": FONT,
    "svg.fonttype": "path",
    "text.antialiased": True,
})


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def tint(h, a=0.10):
    """Blend a colour toward the paper background (a=0 -> paper, 1 -> colour)."""
    r, g, b = _rgb(h)
    pr, pg, pb = _rgb(PAPER)
    return (r * a + pr * (1 - a), g * a + pg * (1 - a), b * a + pb * (1 - a))


def darken(h, a=0.25):
    r, g, b = _rgb(h)
    return (r * (1 - a), g * (1 - a), b * (1 - a))


def canvas(width_in=16.0, height_in=10.0):
    fig = plt.figure(figsize=(width_in, height_in))
    fig.patch.set_facecolor(PAPER)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_facecolor(PAPER)
    ax.set_xlim(0, 100)
    ax.set_ylim(height_in * 6.25, 0)  # y grows downward, 1 unit == 0.16 in
    ax.axis("off")
    return fig, ax


def heading(ax, title, subtitle=None, y=3.4):
    ax.text(2, y, title, fontsize=17, fontweight="bold", color=INK, va="center")
    if subtitle:
        ax.text(2, y + 2.5, subtitle, fontsize=9.2, color=MUTED, va="center")


def zone(ax, x, y, w, h, title, color=SLATE, note=None, fill=None, dashed=False):
    patch = FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0,rounding_size=1.0",
        linewidth=1.1,
        edgecolor=color if not dashed else color,
        facecolor=fill if fill else tint(color, 0.045),
        linestyle=(0, (5, 3)) if dashed else "-",
        zorder=1,
    )
    ax.add_patch(patch)
    ax.text(x + 1.7, y + 2.1, title.upper(), fontsize=7.0, color=darken(color, 0.1),
            fontweight="bold", va="center")
    if note:
        ax.text(x + w - 1.7, y + 2.1, note, fontsize=7.2, color=MUTED, va="center",
                ha="right", family=MONO)


def card_height(sub=None, mono=None, sub_gap=1.8):
    """Height a card needs for its content, so text can never outgrow its box."""
    subs = 0 if sub is None else (len(sub) if isinstance(sub, list) else 1)
    return 2.75 + subs * sub_gap + (2.4 if mono else 0) + 1.15


def card(ax, x, y, w, h, title, sub=None, color=MOSS, mono=None, dashed=False,
         title_size=10.2, sub_size=8.0, align="left", fill=None, badge=None,
         title_color=None, zorder=3):
    h = h if h is not None else card_height(sub, mono)
    patch = FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0,rounding_size=0.7",
        linewidth=1.3,
        edgecolor=color,
        facecolor=fill if fill else WHITE,
        linestyle=(0, (4, 2.5)) if dashed else "-",
        zorder=zorder,
    )
    ax.add_patch(patch)
    # Accent bar on the left edge anchors the eye like the storefront cards do.
    if align == "left":
        ax.plot([x + 0.02, x + 0.02], [y + 0.9, y + h - 0.9], color=color, linewidth=2.6,
                solid_capstyle="round", zorder=zorder + 1)

    subs = [] if sub is None else (sub if isinstance(sub, list) else [sub])

    tx = x + 2.0 if align == "left" else x + w / 2
    ha = "left" if align == "left" else "center"
    # Lay the block out from the top edge so a long card can never push its own
    # title through the border.
    ty = y + 2.75

    if badge:
        ax.add_patch(plt.Circle((x + 2.1, ty), 1.15, facecolor=color, edgecolor="none", zorder=zorder + 2))
        ax.text(x + 2.1, ty + 0.05, badge, fontsize=8.4, color=WHITE, ha="center", va="center",
                fontweight="bold", zorder=zorder + 3)
        tx = x + 4.0
    ax.text(tx, ty, title, fontsize=title_size, fontweight="bold",
            color=title_color or INK, va="center", ha=ha, zorder=zorder + 2)
    cy = ty + 2.15
    for line in subs:
        ax.text(tx, cy, line, fontsize=sub_size, color=MUTED, va="center", ha=ha, zorder=zorder + 2)
        cy += 1.8
    if mono:
        ax.text(tx, cy + 0.2, mono, fontsize=7.3, color=darken(color, 0.15), va="center", ha=ha,
                family=MONO, zorder=zorder + 2)


def arrow(ax, start, end, color=MUTED, label=None, rad=0.0, dashed=False, lw=1.3,
          label_off=(0, -1.15), label_size=7.7, both=False, style="-|>", zorder=2,
          label_ha="center"):
    patch = FancyArrowPatch(
        start, end,
        arrowstyle=("<|-|>" if both else style),
        mutation_scale=11,
        linewidth=lw,
        color=color,
        linestyle=(0, (4, 3)) if dashed else "-",
        connectionstyle=f"arc3,rad={rad}",
        shrinkA=0, shrinkB=0,
        zorder=zorder,
    )
    ax.add_patch(patch)
    if label:
        mx = (start[0] + end[0]) / 2 + label_off[0]
        my = (start[1] + end[1]) / 2 + label_off[1]
        ax.text(mx, my, label, fontsize=label_size, color=darken(color, 0.05), ha=label_ha,
                va="center", zorder=zorder + 1,
                bbox=dict(facecolor=PAPER, edgecolor="none", pad=1.1))


def pill(ax, x, y, text, color=MOSS, w=None, size=7.6, h=2.6):
    w = w if w else max(6.0, len(text) * size * 0.145 + 2.4)
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=1.2",
                                linewidth=0, facecolor=tint(color, 0.16), zorder=4))
    ax.text(x + w / 2, y + h / 2 + 0.05, text, fontsize=size, color=darken(color, 0.2),
            ha="center", va="center", fontweight="bold", zorder=5)
    return w


def code_block(ax, x, y, w, lines, color=MOSS, size=7.2, h=None):
    h = h if h else 1.2 + len(lines) * 1.55
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.5",
                                linewidth=0, facecolor=tint(color, 0.07), zorder=3))
    cy = y + 1.4
    for line in lines:
        ax.text(x + 1.2, cy, line, fontsize=size, family=MONO, color=darken(INK, 0.0),
                va="center", zorder=4)
        cy += 1.55
    return h


def footer(ax, text, y):
    ax.text(2, y, text, fontsize=7.4, color=MUTED, va="center", style="italic")


def save(fig, name, out_dir=None):
    out_dir = out_dir or str(pathlib.Path(__file__).resolve().parents[1])
    import os
    os.makedirs(out_dir, exist_ok=True)
    fig.savefig(f"{out_dir}/{name}.png", dpi=150, facecolor=PAPER)
    fig.savefig(f"{out_dir}/{name}.svg", facecolor=PAPER)
    plt.close(fig)
    print(f"wrote {out_dir}/{name}.png/.svg")
