#!/usr/bin/env python3
"""Before|after image for the QA log: light half of two 3x bubble renders, scaled to 2x,
side by side with a label strip, saved as a palette PNG to keep the repo lean.
Usage: pair.py <before.png> <after.png> <out.png> [--full]"""
import sys
from PIL import Image, ImageDraw, ImageFont

b_path, a_path, out = sys.argv[1:4]
full = '--full' in sys.argv


def load(p):
    im = Image.open(p).convert('RGB')
    if not full:
        im = im.crop((0, 0, im.width // 2, im.height))
    return im.resize((im.width * 2 // 3, im.height * 2 // 3), Image.LANCZOS)


B, A = load(b_path), load(a_path)
gap, top = 16, 44
W = Image.new('RGB', (B.width + A.width + gap, max(B.height, A.height) + top), (255, 255, 255))
d = ImageDraw.Draw(W)
try:
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
except OSError:
    f = None
d.text((12, 10), 'BEFORE (main)', fill=(176, 0, 32), font=f)
d.text((B.width + gap + 12, 10), 'AFTER', fill=(0, 120, 60), font=f)
W.paste(B, (0, top))
W.paste(A, (B.width + gap, top))
W.quantize(colors=128, method=Image.Quantize.MEDIANCUT).save(out, optimize=True)
print(out)
