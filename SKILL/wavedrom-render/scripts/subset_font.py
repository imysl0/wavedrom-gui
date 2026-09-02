#!/usr/bin/env python3
"""Subset a TTF to just the given characters, output a base64 data-URI-ready TTF.

Usage:
    subset_font.py <in.ttf> <out.ttf> <chars-file>

`chars-file` is a UTF-8 text file whose entire content is the set of characters
to keep. Exits non-zero (without writing output) if fontTools is unavailable, so
the caller can fall back to embedding the full font.
"""
import sys


def main(argv):
    if len(argv) < 4:
        sys.stderr.write("usage: subset_font.py <in.ttf> <out.ttf> <chars-file>\n")
        return 2
    src, dst, charsfile = argv[1], argv[2], argv[3]
    try:
        from fontTools import subset
    except ImportError:
        sys.stderr.write("fontTools not installed\n")
        return 3
    with open(charsfile, encoding="utf-8") as f:
        text = f.read()
    # Always keep basic ASCII so Latin labels/ticks survive even if `text` is CJK-only.
    keep = set(text) | set(chr(c) for c in range(0x20, 0x7f))
    unicodes = sorted(ord(ch) for ch in keep)
    args = [
        src,
        "--output-file=" + dst,
        "--unicodes=" + ",".join(hex(u)[2:] for u in unicodes),
        "--layout-features=*",
        "--drop-tables+=DSIG",
        "--no-hinting",
        "--desubroutinize",
        "--recalc-bounds",
    ]
    subset.main(args)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
