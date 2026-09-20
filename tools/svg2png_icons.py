#!/usr/bin/env python3
"""Rasterize the 4 linear SVG tab icons into 81x81 PNGs (gray + green),
faithfully reproducing stroke geometry. Uses only PIL (no SVG rasterizer).

Fixes the previous tokenizer bug: a '-'/'+' starts a NEW number only when it
begins a number (buffer empty) or follows an exponent 'e'/'E'; when preceded
by a digit it ends the current number (e.g. "6-2" -> 6, -2 ; "v-5" -> v, -5).

Sizing fix (2026-09-20): instead of parking the artwork in a small centered
"drawable" region (which left ~35% transparent padding and made the tab icon
look tiny once WeChat scales the whole 81px canvas into its fixed box), we now
measure each icon's true ink bounding box and fit it to FILL (0.84) of the
canvas. This makes the visible icon ~40% larger and matches the v15 prototype's
"icon fills its box" ratio, while preserving the original stroke:artwork
proportion (1.83 / 24).
"""
import re
import os
import math
from PIL import Image, ImageDraw

SVG_DIR = "/Users/daisymao2025/work/git/DaisyMaoqy/mini-community-stroll/miniprogram/assets/icons"
OUT_DIR = "/tmp/tabgen"

# final icon canvas size (WeChat standard 81x81)
FINAL = 81
SS = 5                      # supersample factor for anti-aliasing
BIG = FINAL * SS            # 405
FILL = 0.84                 # artwork (incl. stroke) fills this fraction of canvas

GRAY = (147, 162, 154, 255)   # #93A29A  (tabBar unselected, matches app.json color)
GREEN = (47, 182, 124, 255)   # #2FB67C  (tabBar selected, matches app.json selectedColor)
STROKE_SVG = 1.83


def T(p):
    return (p[0], p[1])


def parse_path(d):
    """Split path data into [(letter, [nums]), ...] keeping multi-number commands."""
    cmds = []
    cur_letter = None
    cur_nums = []
    i, n = 0, len(d)
    while i < n:
        c = d[i]
        if c in 'MmLlHhVvCcSsQqTtAaZz':
            if cur_letter is not None:
                cmds.append((cur_letter, cur_nums))
            cur_letter = c
            cur_nums = []
            i += 1
        elif c in '0123456789.+-eE' or c.isspace() or c == ',':
            if c in ' ,':
                i += 1
                continue
            j = i
            num = ''
            in_exp = False
            while j < n and d[j] in '0123456789.+-eE':
                ch = d[j]
                if ch.isdigit() or ch == '.':
                    num += ch
                    in_exp = False
                    j += 1
                elif ch in 'eE':
                    num += ch
                    in_exp = True
                    j += 1
                elif ch in '+-':
                    if num == '':
                        num += ch
                        j += 1
                    elif in_exp and num and num[-1] in 'eE':
                        num += ch
                        in_exp = False
                        j += 1
                    else:
                        break  # sign begins a new number
                else:
                    break
            if num != '':
                cur_nums.append(float(num))
            i = j
        else:
            i += 1
    if cur_letter is not None:
        cmds.append((cur_letter, cur_nums))
    return cmds


def to_segments(cmds):
    """Convert command list into absolute-coordinate primitives per subpath."""
    subpaths = []
    cur = []
    cx = cy = 0.0
    sx = sy = 0.0
    prev_ctrl = None

    def moveto(x, y):
        nonlocal cx, cy, sx, sy
        cur.append(('M', x, y))
        cx, cy = x, y
        sx, sy = x, y

    i = 0
    while i < len(cmds):
        letter, nums = cmds[i]
        a = letter.isupper()
        if letter in 'Mm':
            pts = nums
            mx, my = pts[0], pts[1]
            ax, ay = (mx, my) if a else (cx + mx, cy + my)
            moveto(ax, ay)
            k = 2
            while k + 1 < len(pts):
                px, py = pts[k], pts[k + 1]
                lx, ly = (px, py) if a else (cx + px, cy + py)
                cur.append(('L', lx, ly))
                cx, cy = lx, ly
                k += 2
            prev_ctrl = None
        elif letter in 'Ll':
            k = 0
            while k + 1 < len(nums):
                px, py = nums[k], nums[k + 1]
                lx, ly = (px, py) if a else (cx + px, cy + py)
                cur.append(('L', lx, ly))
                cx, cy = lx, ly
                k += 2
            prev_ctrl = None
        elif letter in 'Hh':
            for v in nums:
                lx = v if a else cx + v
                cur.append(('L', lx, cy))
                cx = lx
            prev_ctrl = None
        elif letter in 'Vv':
            for v in nums:
                ly = v if a else cy + v
                cur.append(('L', cx, ly))
                cy = ly
            prev_ctrl = None
        elif letter in 'Cc':
            k = 0
            while k + 5 < len(nums):
                x1, y1, x2, y2, x, y = nums[k:k + 6]
                if a:
                    ax1, ay1, ax2, ay2, ax, ay = x1, y1, x2, y2, x, y
                else:
                    ax1, ay1, ax2, ay2, ax, ay = cx + x1, cy + y1, cx + x2, cy + y2, cx + x, cy + y
                cur.append(('C', ax1, ay1, ax2, ay2, ax, ay))
                prev_ctrl = (ax2, ay2)
                cx, cy = ax, ay
                k += 6
        elif letter in 'Ss':
            k = 0
            while k + 3 < len(nums):
                x2, y2, x, y = nums[k:k + 4]
                if prev_ctrl is not None:
                    rx, ry = 2 * cx - prev_ctrl[0], 2 * cy - prev_ctrl[1]
                else:
                    rx, ry = cx, cy
                ax2, ay2, ax, ay = (x2, y2, x, y) if a else (cx + x2, cy + y2, cx + x, cy + y)
                cur.append(('C', rx, ry, ax2, ay2, ax, ay))
                prev_ctrl = (ax2, ay2)
                cx, cy = ax, ay
                k += 4
        elif letter in 'Zz':
            cur.append(('Z',))
            cx, cy = sx, sy
            prev_ctrl = None
        else:
            prev_ctrl = None
        i += 1
    if cur:
        subpaths.append(cur)
    return subpaths


def cubic(p0, c1, c2, p1, N=28):
    pts = []
    for t in range(N + 1):
        tt = t / N
        mt = 1 - tt
        x = mt**3*p0[0] + 3*mt*mt*tt*c1[0] + 3*mt*tt*tt*c2[0] + tt**3*p1[0]
        y = mt**3*p0[1] + 3*mt*mt*tt*c1[1] + 3*mt*tt*tt*c2[1] + tt**3*p1[1]
        pts.append((x, y))
    return pts


def draw_round_line(draw, p0, p1, w, color):
    draw.line([p0, p1], fill=color, width=int(round(w)))
    r = w / 2
    for p in (p0, p1):
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)


def draw_round_poly(draw, pts, w, color):
    draw.line(pts, fill=color, width=int(round(w)), joint='curve')
    r = w / 2
    for p in pts:
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)


def compute_bbox(subpaths, circles):
    minx = miny = 1e9
    maxx = maxy = -1e9

    def inc(x, y):
        nonlocal minx, miny, maxx, maxy
        if x < minx: minx = x
        if x > maxx: maxx = x
        if y < miny: miny = y
        if y > maxy: maxy = y

    for sub in subpaths:
        for prim in sub:
            for k in range(1, len(prim) - 1, 2):
                inc(prim[k], prim[k + 1])
    for (cx, cy, r) in circles:
        inc(cx - r, cy - r)
        inc(cx + r, cy + r)
    return minx, miny, maxx, maxy


def draw_svg(svg_text, color):
    # circles
    circles = []
    for m in re.finditer(r'<circle\b[^>]*>', svg_text):
        tag = m.group(0)
        cx = float(re.search(r'cx="([^"]+)"', tag).group(1))
        cy = float(re.search(r'cy="([^"]+)"', tag).group(1))
        r = float(re.search(r'r="([^"]+)"', tag).group(1))
        circles.append((cx, cy, r))
    # paths
    subpaths = []
    for m in re.finditer(r'<path\b[^>]*\bd="([^"]+)"', svg_text):
        subpaths.extend(to_segments(parse_path(m.group(1))))

    if not subpaths and not circles:
        return Image.new("RGBA", (FINAL, FINAL), (0, 0, 0, 0))

    # true ink bounding box, expanded by half the stroke so the stroke's outer
    # edge (not just the centerline) is what we fit to FILL.
    minx, miny, maxx, maxy = compute_bbox(subpaths, circles)
    pad = STROKE_SVG / 2.0
    minx -= pad; miny -= pad; maxx += pad; maxy += pad
    cw = maxx - minx
    ch = maxy - miny

    target_big = FINAL * FILL * SS
    scale_big = target_big / max(cw, ch)
    ccx = (minx + maxx) / 2.0
    ccy = (miny + maxy) / 2.0
    ox = BIG / 2.0 - ccx * scale_big
    oy = BIG / 2.0 - ccy * scale_big

    def T2(p):
        return (p[0] * scale_big + ox, p[1] * scale_big + oy)

    W_big = STROKE_SVG * scale_big
    w = int(round(W_big))

    img = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for (cx, cy, r) in circles:
        x0, y0 = T2((cx - r, cy - r))
        x1, y1 = T2((cx + r, cy + r))
        d.ellipse([x0, y0, x1, y1], outline=color, width=w)

    for sub in subpaths:
        cur = None
        start = None
        for prim in sub:
            if prim[0] == 'M':
                cur = (prim[1], prim[2])
                if start is None:
                    start = cur
            elif prim[0] == 'L':
                tgt = (prim[1], prim[2])
                draw_round_line(d, T2(cur), T2(tgt), W_big, color)
                cur = tgt
            elif prim[0] == 'C':
                c1 = (prim[1], prim[2]); c2 = (prim[3], prim[4]); tgt = (prim[5], prim[6])
                pts = cubic(cur, c1, c2, tgt)
                draw_round_poly(d, [T2(p) for p in pts], W_big, color)
                cur = tgt
            elif prim[0] == 'Z':
                if start is not None:
                    draw_round_line(d, T2(cur), T2(start), W_big, color)
                    cur = start

    final = img.resize((FINAL, FINAL), Image.LANCZOS)
    return final


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icons = {
        "home": "i-home-icon.svg",
        "vaccine": "i-vaccine-icon.svg",
        "map": "i-map-icon.svg",
        "mine": "i-user-icon.svg",
    }
    for name, fname in icons.items():
        with open(os.path.join(SVG_DIR, fname)) as f:
            svg = f.read()
        for suffix, color in (("", GRAY), ("-on", GREEN)):
            out = draw_svg(svg, color)
            path = os.path.join(OUT_DIR, f"{name}{suffix}.png")
            out.save(path)
            print("wrote", path, out.size)


if __name__ == "__main__":
    main()
