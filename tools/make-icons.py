#!/usr/bin/env python
"""
make-icons.py - builds the app icon set from your own artwork.

Put the source image at  icons/source-logo.png  (any size; it gets cropped to a
square from the centre), then run:

    python tools/make-icons.py

It writes icon.png, icon-180/192/512.png and icon-maskable-512.png, each with
"SAT" set across the artwork. The maskable version keeps the wordmark inside
Android's safe circle so it is not clipped on a home screen.
"""
import os

from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, "icons")
SOURCE = os.path.join(ICONS, "source-logo.png")

# Windows ships these; fall back through the list until one loads.
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\ariblk.ttf",     # Arial Black - heaviest, reads best small
    r"C:\Windows\Fonts\seguibl.ttf",    # Segoe UI Black
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def square(img):
    """Centre-crop to a square, biased slightly upward to favour a face."""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = max(0, int((h - side) * 0.35))
    return img.crop((left, top, left + side, top + side))


def draw_wordmark(img, text="SAT", safe=1.0):
    """
    Lay `text` across the artwork. `safe` shrinks the wordmark toward the centre
    for maskable icons, whose corners get cut off.
    """
    size = img.size[0]
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    target_w = size * 0.74 * safe
    pt = int(size * 0.30)
    font = load_font(pt)
    for _ in range(40):
        box = draw.textbbox((0, 0), text, font=font)
        if box[2] - box[0] >= target_w or pt > size:
            break
        pt += max(1, size // 100)
        font = load_font(pt)

    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    x = (size - tw) / 2 - box[0]
    y = size * (0.60 if safe == 1.0 else 0.56) - th / 2 - box[1]

    # A soft dark plate keeps the letters readable over the busy line art.
    pad = size * 0.05
    plate = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        [x - pad, y - pad * 0.55, x + tw + pad, y + th + pad * 0.75],
        radius=int(size * 0.045),
        fill=(10, 14, 22, 170),
    )
    plate = plate.filter(ImageFilter.GaussianBlur(size * 0.012))
    img = Image.alpha_composite(img, plate)

    draw = ImageDraw.Draw(layer)
    stroke = max(1, int(size * 0.012))
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255),
              stroke_width=stroke, stroke_fill=(8, 12, 20, 255))
    return Image.alpha_composite(img, layer)


def rounded(img, radius_ratio=0.22):
    size = img.size[0]
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def placeholder(size):
    """Plain dark tile, used until real artwork is dropped in."""
    img = Image.new("RGBA", (size, size), (23, 28, 38, 255))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)],
               fill=(int(31 + 14 * t), int(38 + 18 * t), int(52 + 24 * t), 255))
    return img


def main():
    if os.path.exists(SOURCE):
        base = square(Image.open(SOURCE).convert("RGBA"))
    else:
        print("  ! icons/source-logo.png not found - using a plain placeholder.")
        print("    Save your artwork there and re-run to use it.")
        base = placeholder(512)

    # Square icons with rounded corners, for the browser tab and the app shell.
    for size, name in [(64, "icon.png"), (180, "icon-180.png"),
                       (192, "icon-192.png"), (512, "icon-512.png")]:
        img = base.resize((size, size), Image.LANCZOS)
        img = draw_wordmark(img)
        img = rounded(img)
        img.save(os.path.join(ICONS, name))
        print(f"  wrote icons/{name}")

    # Maskable: full bleed, wordmark pulled in so Android's circle cannot clip it.
    m = base.resize((512, 512), Image.LANCZOS)
    m = draw_wordmark(m, safe=0.72)
    m.save(os.path.join(ICONS, "icon-maskable-512.png"))
    print("  wrote icons/icon-maskable-512.png")


if __name__ == "__main__":
    main()
