#!/usr/bin/env python3
"""
make-avatars.py - turns the headshots in profile-pictures/ into small square
avatars in assets/avatars/.

The originals are 200KB-1.3MB each and up to 3000px wide; six of those is 2.5MB
of picker that has to come down the wire before you can choose one. These come
out around 20KB apiece at 320x320, which is 2x for the 160px slot they render
in.

These are press crops, and the subject is rarely in the middle of one - a plain
centre crop cuts faces in half or leaves them staring in from the edge. Each
file therefore carries its own anchor, (horizontal, vertical), where 0 is the
left/top edge and 0.5 is centred. Tune them by eye against
tools/.avatar-sheet.jpg, which this writes as a contact sheet of the results.

    python tools/make-avatars.py
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'profile-pictures')
OUT = os.path.join(ROOT, 'assets', 'avatars')

SIZE = 320
QUALITY = 82

# source file -> (output id, (horizontal anchor, vertical anchor))
PEOPLE = {
    'david-coleman-804x452.jpg':            ('coleman', (0.82, 0.30)),
    'JES Headshot[63].jpg':                 ('singer',  (0.82, 0.30)),
    'TrevorPacker.jpg':                     ('packer',  (0.76, 0.30)),
    'JeffOlson.jpg':                        ('olson',   (0.38, 0.30)),
    'mgriffin_cb_headshot_highres.jpg':     ('griffin', (0.44, 0.35)),
    'screenshot-2026-02-20-at-3.46.27-pm.png': ('cutrona', (0.67, 0.30)),
}


def square(im, anchor):
    """Crop the largest square, positioned at `anchor` within the spare space."""
    hx, vy = anchor
    w, h = im.size
    side = min(w, h)
    left = int((w - side) * hx)
    top = int((h - side) * vy)
    left = max(0, min(w - side, left))
    top = max(0, min(h - side, top))
    return im.crop((left, top, left + side, top + side))


def main():
    os.makedirs(OUT, exist_ok=True)
    made = []
    for name, (slug, anchor) in PEOPLE.items():
        path = os.path.join(SRC, name)
        if not os.path.exists(path):
            print(f'  ! missing {name}')
            continue
        im = Image.open(path).convert('RGB')
        im = square(im, anchor).resize((SIZE, SIZE), Image.LANCZOS)
        dest = os.path.join(OUT, f'{slug}.jpg')
        im.save(dest, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        made.append((slug, dest, im))
        print(f'  {slug:9s} {os.path.getsize(dest) // 1024:3d}KB  <- {name}')

    if not made:
        return
    # Contact sheet, so the crops can be checked in one look instead of six.
    sheet = Image.new('RGB', (SIZE * len(made), SIZE), (20, 24, 32))
    for i, (_, _, im) in enumerate(made):
        sheet.paste(im, (i * SIZE, 0))
    sheet.save(os.path.join(HERE, '.avatar-sheet.jpg'), 'JPEG', quality=80)
    total = sum(os.path.getsize(d) for _, d, _ in made)
    print(f'  {len(made)} avatars, {total // 1024}KB total')
    print('  contact sheet: tools/.avatar-sheet.jpg')


if __name__ == '__main__':
    main()
