#!/usr/bin/env python3
"""Rasterize an SVG file to PNG using cairosvg.

Usage:
    svg2png.py <in.svg> <out.png> [scale] [--width W] [--height H]

`scale` multiplies the SVG's intrinsic pixel size (default 2). If --width /
--height are given, they override scale and set the output size directly.
"""
import sys


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: svg2png.py <in.svg> <out.png> [scale] [--width W] [--height H]\n")
        return 2
    src, dst = argv[1], argv[2]
    scale = 2.0
    width = height = None
    i = 3
    rest = argv[3:]
    # optional positional scale
    if rest and not rest[0].startswith("--"):
        try:
            scale = float(rest[0])
        except ValueError:
            pass
        rest = rest[1:]
    j = 0
    while j < len(rest):
        if rest[j] == "--width" and j + 1 < len(rest):
            width = float(rest[j + 1]); j += 2
        elif rest[j] == "--height" and j + 1 < len(rest):
            height = float(rest[j + 1]); j += 2
        else:
            j += 1
    try:
        import cairosvg
    except ImportError:
        sys.stderr.write("cairosvg not installed (pip install cairosvg)\n")
        return 3
    kwargs = {"url": src, "write_to": dst}
    if width is not None:
        kwargs["output_width"] = int(round(width))
    if height is not None:
        kwargs["output_height"] = int(round(height))
    if width is None and height is None:
        kwargs["scale"] = scale
    cairosvg.svg2png(**kwargs)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
