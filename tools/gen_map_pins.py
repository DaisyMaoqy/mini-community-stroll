#!/usr/bin/env python3
"""Generate circular-badge map pins (4x: 120x152) for the 4 spot categories.

Each pin = white outline ring + colored disc + category icon + pointer tail
whose tip sits at the bottom-center (matches <map> marker anchor x:0.5,y:1).

Icons are rendered from the existing linear SVGs via the proven renderer in
svg2png_icons.py (pure PIL, no rasterizer). Category colors come from the app's
CAT palette in pages/map/index.js so the pins stay consistent with the legend.

The 邨巴 (bus) icon is detailed (body + windows + wheels); at ~14px display it
collapses into a blob as a hairline outline, so it is rendered as a SOLID white
silhouette (filled body + wheels) with thin window lines cut in the badge color.

Resolution & anti-aliasing (2026-09-22 fix for the "mosaic"/aliased edges):
- The <map> marker renders at width:30 height:38 (pages/map/index.js). To stay
  crisp on 2x/3x/4x screens we emit the PNG at SS=4 -> 120x152.
- The badge ring/disc/pointer used to be drawn directly with PIL
  ImageDraw.ellipse/polygon at 60x76 (these are NOT anti-aliased) -> jagged,
  blocky edges. Now we draw on an AASx supersampled canvas (240x304) and
  downscale with LANCZOS, so the edges are smooth at any device pixel ratio.
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

# 显示尺寸（与 <map> marker width/height 对齐）
DISPLAY_W, DISPLAY_H = 30, 38
SS = 4                                  # 最终像素 = 显示 ×4 = 120×152
AAS = 2                                 # 额外超采样（绘制画布倍数）
SRC_W, SRC_H = DISPLAY_W * SS * AAS, DISPLAY_H * SS * AAS   # 240 × 304
OUT_W, OUT_H = DISPLAY_W * SS, DISPLAY_H * SS               # 120 × 152

# 旧逻辑坐标（基于 60×76 尺度）映射到超采样绘制画布的缩放系数
KX = SRC_W / 60.0
KY = SRC_H / 76.0
WHITE = (255, 255, 255, 255)


def _pt(ox, oy):
    return (ox * KX, oy * KY)


def make_pin(color):
    img = Image.new("RGBA", (SRC_W, SRC_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = _pt(30, 25)
    # 白色外圈（圆环）+ 彩色内填充（圆盘），按旧坐标等比重映射
    Rwhite = 25 * KX
    Rcolor = 23 * KX
    d.ellipse([cx - Rwhite, cy - Rwhite, cx + Rwhite, cy + Rwhite], fill=WHITE)
    # 指针尾巴三角（白）
    d.polygon([_pt(21, 38), _pt(39, 38), _pt(30, 75)], fill=WHITE)
    # 彩色圆盘（内缩约 2px@旧尺度，留出白环）
    d.ellipse([cx - Rcolor, cy - Rcolor, cx + Rcolor, cy + Rcolor], fill=color)
    # 彩色指针（内缩）
    d.polygon([_pt(23, 40), _pt(37, 40), _pt(30, 73)], fill=color)
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
    # 旧：icon 缩到 32×32、贴到 (14,9)；按超采样系数等比放大到绘制尺度
    iw = int(round(32 * KX)); ih = int(round(32 * KY))
    icon = icon.resize((iw, ih), Image.LANCZOS)
    tl = (int(round(14 * KX)), int(round(9 * KY)))
    pin.paste(icon, tl, icon)
    return pin


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, (svg, color) in CATS.items():
        pin = make_pin(color)                       # 240×304 超采样画布
        pin = paste_icon(pin, svg, color)
        pin = pin.resize((OUT_W, OUT_H), Image.LANCZOS)  # 平滑缩到 120×152
        path = os.path.join(OUT, f"pin-{name}.png")
        pin.save(path, "PNG")
        c = pin.getpixel((OUT_W // 2, int(OUT_H * (25.0 / 76.0))))
        print(f"wrote {path}  size={pin.size}  center={c}")


if __name__ == "__main__":
    main()
