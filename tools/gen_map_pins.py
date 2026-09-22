#!/usr/bin/env python3
"""Generate circular-badge map pins (2x: 60x76) for the 4 spot categories.

Each pin = white outline ring + colored disc + category icon + pointer tail
whose tip sits at the bottom-center (matches <map> marker anchor x:0.5,y:1).

Icons are rendered from the existing linear SVGs via the proven renderer in
svg2png_icons.py (pure PIL, no rasterizer). Category colors come from the app's
CAT palette in pages/map/index.js so the pins stay consistent with the legend.

The 邨巴 (bus) icon is detailed (body + windows + wheels); at ~14px display it
collapses into a blob as a hairline outline, so it is rendered as a SOLID white
silhouette (filled body + wheels) with thin window lines cut in the badge color.
"""
import os
import re
import sys
from PIL import Image, ImageDraw

TOOLS = "/Users/daisymao2025/work/git/DaisyMaoqy/mini-community-stroll/tools"
sys.path.insert(0, TOOLS)
import svg2png_icons as S  # reuse parse_path/to_segments/cubic + constants

SVG_DIR = S.SVG_DIR
OUT = "/Users/daisymao2025/work/git/DaisyMaoqy/mini-community-stroll/miniprogram/assets/pins"

# pin name -> (svg file, category color RGBA), colors mirror CAT in index.js
CATS = {
    "vac":   ("i-vaccine-icon.svg", (240, 169, 59, 255)),   # #F0A93B 接种
    "play":  ("i-slide-icon.svg",   (47, 182, 124, 255)),   # #2FB67C 遛娃（滑梯）
    "civic": ("i-home-icon.svg",    (74, 143, 208, 255)),   # #4A8FD0 便民
    "bus":   ("i-bus-icon.svg",     (255, 158, 109, 255)),  # #FF9E6D 邨巴
}

W, H = 60, 76          # 2x of the 30x38 display size
CX, CY = 30, 25        # disc center
WHITE = (255, 255, 255, 255)


def make_pin(color):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # white outline silhouette (circle + pointer); tip reaches y=75
    d.ellipse([CX - 25, CY - 25, CX + 25, CY + 25], fill=WHITE)
    d.polygon([(CX - 9, 38), (CX + 9, 38), (CX, 75)], fill=WHITE)
    # colored fill, inset ~2px so the white shows as a uniform ring
    d.ellipse([CX - 23, CY - 23, CX + 23, CY + 23], fill=color)
    d.polygon([(CX - 7, 40), (CX + 7, 40), (CX, 73)], fill=color)
    return img


def flatten_subpath(sub):
    pts = []
    cur = None
    for prim in sub:
        if prim[0] == 'M':
            cur = (prim[1], prim[2]); pts.append(cur)
        elif prim[0] == 'L':
            cur = (prim[1], prim[2]); pts.append(cur)
        elif prim[0] == 'C':
            c1 = (prim[1], prim[2]); c2 = (prim[3], prim[4]); tgt = (prim[5], prim[6])
            seg = S.cubic(cur, c1, c2, tgt)
            pts.extend(seg[1:])
            cur = tgt
    return pts


def poly_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def draw_svg_filled(svg, color, cut):
    """Fill large closed shapes (bus body + wheels) white; draw small open
    paths (window lines) as thin cut lines in the badge color."""
    circles = []
    for m in re.finditer(r'<circle\b[^>]*>', svg):
        tag = m.group(0)
        circles.append((
            float(re.search(r'cx="([^"]+)"', tag).group(1)),
            float(re.search(r'cy="([^"]+)"', tag).group(1)),
            float(re.search(r'r="([^"]+)"', tag).group(1)),
        ))
    subs = []
    for m in re.finditer(r'<path\b[^>]*\bd="([^"]+)"', svg):
        subs.extend(S.to_segments(S.parse_path(m.group(1))))

    minx = miny = 1e9; maxx = maxy = -1e9
    def inc(x, y):
        nonlocal minx, miny, maxx, maxy
        minx = min(minx, x); maxx = max(maxx, x)
        miny = min(miny, y); maxy = max(maxy, y)
    for sub in subs:
        for prim in sub:
            for k in range(1, len(prim) - 1, 2):
                inc(prim[k], prim[k + 1])
    for (cx, cy, r) in circles:
        inc(cx - r, cy - r); inc(cx + r, cy + r)
    pad = S.STROKE_SVG / 2.0
    minx -= pad; miny -= pad; maxx += pad; maxy += pad
    cw = maxx - minx; ch = maxy - miny
    target_big = S.FINAL * S.FILL * S.SS
    scale = target_big / max(cw, ch)
    ccx = (minx + maxx) / 2.0; ccy = (miny + maxy) / 2.0
    ox = S.BIG / 2.0 - ccx * scale
    oy = S.BIG / 2.0 - ccy * scale

    def T(p):
        return (p[0] * scale + ox, p[1] * scale + oy)

    img = Image.new("RGBA", (S.BIG, S.BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for (cx, cy, r) in circles:
        x0, y0 = T((cx - r, cy - r)); x1, y1 = T((cx + r, cy + r))
        d.ellipse([x0, y0, x1, y1], fill=color)
    cut_w = max(2, int(round(1.2 * scale)))
    fill_thresh = (S.STROKE_SVG * scale) ** 2 * 8
    for sub in subs:
        pts = [T(p) for p in flatten_subpath(sub)]
        if pts[0] != pts[-1]:
            pts = pts + [pts[0]]
        area = poly_area([(p[0], p[1]) for p in pts])
        if area > fill_thresh:
            d.polygon(pts, fill=color)
        else:
            d.line(pts, fill=cut, width=cut_w, joint='curve')
    # window band cut in the badge color (upper body) — survives downscaling
    bx0, bx1 = 2.4, 17.6
    by0, by1 = 5.4, 9.6
    d.rectangle([T((bx0, by0)), T((bx1, by1))], fill=cut)
    return img.resize((S.FINAL, S.FINAL), Image.LANCZOS)


def build_icon(svg_name, color):
    with open(os.path.join(SVG_DIR, svg_name)) as f:
        svg = f.read()
    if svg_name == "i-bus-icon.svg":
        # solid silhouette for legibility at pin size
        return draw_svg_filled(svg, WHITE, color)
    return S.draw_svg(svg, WHITE)


def paste_icon(pin, svg_name, color):
    icon = build_icon(svg_name, color)
    icon = icon.resize((32, 32), Image.LANCZOS)
    tl = (CX - 16, CY - 16)
    pin.paste(icon, tl, icon)
    return pin


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, (svg, color) in CATS.items():
        pin = make_pin(color)
        pin = paste_icon(pin, svg, color)
        path = os.path.join(OUT, f"pin-{name}.png")
        pin.save(path, "PNG")
        c = pin.getpixel((CX, CY))
        print(f"wrote {path}  center={c}")


if __name__ == "__main__":
    main()
