#!/usr/bin/env python3
"""Regenerate miniprogram/components/svg-icon/icons.js from assets/icons/i-*-icon.svg.

The svg-icon component renders each icon by using the SVG as a CSS mask
(-webkit-mask-image); the real color comes from background-color, so the stroke
color in the source SVG is irrelevant at runtime. The committed icons.js
nonetheless uses stroke="#000" for consistency, so this generator normalizes it.

Key derivation: filename sans the `i-` prefix and `-icon` suffix.
    i-baby-icon.svg     -> "baby"
    i-slide-icon.svg    -> "slide"
    i-bus-ui-icon.svg   -> "bus"   (see EXCLUDE note below)

Note on the bus: `i-bus-icon.svg` is the SOURCE FOR THE MAP PIN — it was copied
from the user's bus.svg and is rendered by tools/gen_map_pins.py as a filled
silhouette with a window-band cut. It is intentionally NOT used for the in-UI
svg-icon bus, which keeps its own cleaner source `i-bus-ui-icon.svg` -> "bus".
Hence i-bus-icon.svg is excluded from this generator.
"""
import os
import re
import sys
import json

ROOT = "/Users/daisymao2025/work/git/DaisyMaoqy/mini-community-stroll"
SRC_DIR = os.path.join(ROOT, "miniprogram", "assets", "icons")
OUT = os.path.join(ROOT, "miniprogram", "components", "svg-icon", "icons.js")

HEADER = (
    "// AUTO-GENERATED from assets/icons/i-*-icon.svg —— "
    "供 svg-icon 组件做 CSS mask 用，勿手改。\n"
)

NAME_RE = re.compile(r"^i-(.+?)(?:-ui)?-icon\.svg$")
# i-bus-icon.svg is the map-pin source, not a UI icon — skip it.
EXCLUDE = {"i-bus-icon.svg"}

WS_RE = re.compile(r"\s+")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
STROKE_RGB_RE = re.compile(
    r'stroke="rgb\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)"'
)
STROKE_HEX_RE = re.compile(r'stroke="#[0-9A-Fa-f]{3,8}"')


def key_of(filename):
    m = NAME_RE.match(filename)
    return m.group(1) if m else None


def normalize(svg):
    svg = COMMENT_RE.sub("", svg)
    svg = svg.strip()
    # normalize stroke color to black for consistent generated output
    svg = STROKE_RGB_RE.sub('stroke="#000"', svg)
    svg = STROKE_HEX_RE.sub('stroke="#000"', svg)
    # collapse whitespace, then remove spaces between tags -> one compact line
    svg = WS_RE.sub(" ", svg)
    svg = re.sub(r">\s+<", "><", svg)
    return svg


def main():
    icons = {}
    for fn in sorted(os.listdir(SRC_DIR)):
        if not fn.endswith(".svg"):
            continue
        if fn in EXCLUDE:
            continue
        key = key_of(fn)
        if not key:
            print(f"skip (not i-*-icon.svg): {fn}", file=sys.stderr)
            continue
        with open(os.path.join(SRC_DIR, fn), encoding="utf-8") as f:
            svg = f.read()
        icons[key] = normalize(svg)

    if not icons:
        print("no icon source SVGs found in", SRC_DIR, file=sys.stderr)
        sys.exit(1)

    body = json.dumps(icons, ensure_ascii=False, indent=2, sort_keys=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(HEADER + "module.exports = " + body + ";\n")

    print(f"wrote {OUT}  ({len(icons)} icons)")


if __name__ == "__main__":
    main()
