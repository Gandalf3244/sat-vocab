#!/usr/bin/env python3
"""
make-cb-mark.py - cuts the acorn out of icons/CollegeBoard_logo.png and writes
icons/cb-acorn.png, the mark shown beside the greeting.

The source is a wide lockup, acorn + wordmark, drawn in near-black on an opaque
white background - despite being an RGBA file, nothing in it is transparent.
So there are three jobs here:

  · split the acorn off the wordmark. They are separated by the widest vertical
    gutter in the image, which is easy to find by column ink profile and does
    not care about the exact pixel widths of this particular export.
  · key out the white. Alpha comes from ink darkness, which keeps the edge
    antialiasing intact - a hard threshold would leave the acorn jagged at the
    size it is displayed.
  · recolour the ink white, because the app is dark-only and near-black on
    #0f1117 is an invisible logo.

    python tools/make-cb-mark.py
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'icons', 'CollegeBoard_logo.png')
DEST = os.path.join(ROOT, 'icons', 'cb-acorn.png')

SIZE = 96          # 3x the 32px slot it renders in
PAD = 0.05         # breathing room, as a fraction of the square
INK = (255, 255, 255)
DARK = 128         # luminance below this counts as ink


def column_ink(im):
    """Ink pixel count per column."""
    w, h = im.size
    px = im.load()
    out = []
    for x in range(w):
        n = 0
        for y in range(h):
            r, g, b = px[x, y]
            if (r + g + b) / 3 < DARK:
                n += 1
        out.append(n)
    return out


def acorn_box(im):
    """Everything left of the widest gutter, trimmed to its ink."""
    cols = column_ink(im)
    w, h = im.size

    runs, start = [], None
    for x, n in enumerate(cols):
        if n == 0 and start is None:
            start = x
        elif n and start is not None:
            runs.append((start, x - start))
            start = None
    gutters = [r for r in runs if r[1] >= 5]
    if not gutters:
        raise SystemExit('  ! could not separate the acorn from the wordmark')
    split = gutters[0][0]

    left = next(x for x in range(split) if cols[x])
    right = max(x for x in range(split) if cols[x])
    band = im.crop((left, 0, right + 1, h))
    top, bottom = band.convert('L').point(lambda v: 255 if v < DARK else 0).getbbox()[1::2]
    return (left, top, right + 1, bottom)


def main():
    if not os.path.exists(SRC):
        raise SystemExit(f'  ! missing {SRC}')
    im = Image.open(SRC).convert('RGB')
    box = acorn_box(im)
    mark = im.crop(box)
    print(f'  acorn at {box}  ({mark.size[0]}x{mark.size[1]})')

    # Alpha from darkness: black ink opaque, white paper gone, greys in between
    # keep their antialiasing. Normalised against the darkest pixel actually
    # present - the source ink is #212121, not black, so a plain 255-v inversion
    # tops out around 87% and the mark renders grey instead of white.
    grey = mark.convert('L')
    darkest = min(grey.getdata())
    span = max(1, 255 - darkest)
    alpha = grey.point(lambda v: min(255, round((255 - v) * 255 / span)))
    print(f'  darkest ink {darkest} -> alpha normalised x{255 / span:.2f}')
    mark = Image.merge('RGBA', (*Image.new('RGB', mark.size, INK).split(), alpha))

    inner = int(SIZE * (1 - 2 * PAD))
    mark.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(mark, ((SIZE - mark.size[0]) // 2, (SIZE - mark.size[1]) // 2), mark)
    canvas.save(DEST, 'PNG', optimize=True)
    print(f'  wrote icons/cb-acorn.png ({SIZE}x{SIZE}, {os.path.getsize(DEST)} bytes)')


if __name__ == '__main__':
    main()
