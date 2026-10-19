"""Interim app icon: the `front_hand` Material Symbol ("מחכה לך") on a neutral tile.

Not a logo. design-taste §3 asks for an original logo, which is separate work; until then this
glyph from the app's own icon set stands in, because Android requires a launcher icon.
Usage: python3 tool/make_icons.py <static Material Symbols Rounded TTF with FILL=1>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1]
ROOT = os.path.join(os.path.dirname(__file__), '..')
GLYPH = ''  # front_hand
BG = (240, 240, 237, 255)  # --surface-2
FG = (26, 27, 29, 255)  # --text


def tile(size, glyph_ratio=0.56, radius_ratio=0.0, bg=BG):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if radius_ratio:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=bg)
    else:
        d.rectangle([0, 0, size, size], fill=bg)
    font = ImageFont.truetype(FONT, int(size * glyph_ratio))
    box = d.textbbox((0, 0), GLYPH, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), GLYPH, font=font, fill=FG)
    return img


def fg_only(size, glyph_ratio):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * glyph_ratio))
    box = d.textbbox((0, 0), GLYPH, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), GLYPH, font=font, fill=FG)
    return img


# Web
web = os.path.join(ROOT, 'web')
tile(32, 0.66).save(os.path.join(web, 'favicon.png'))
for s in (192, 512):
    tile(s).save(os.path.join(web, 'icons', f'Icon-{s}.png'))
    tile(s, 0.42).save(os.path.join(web, 'icons', f'Icon-maskable-{s}.png'))

# Android legacy mipmaps + adaptive foreground (108dp canvas, 72dp safe zone)
res = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
for name, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
    d = os.path.join(res, f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    tile(px, 0.56, radius_ratio=0.5).save(os.path.join(d, 'ic_launcher.png'))
    fg_only(int(px * 108 / 48), 0.30).save(os.path.join(d, 'ic_launcher_foreground.png'))
