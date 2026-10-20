import sys, os, glob
from PIL import Image, ImageDraw
before, after, out = sys.argv[1:4]
light_only = '--both' not in sys.argv
os.makedirs(out, exist_ok=True)
for a in sorted(glob.glob(os.path.join(after, '*.png'))):
    n = os.path.basename(a)
    b = os.path.join(before, n)
    A = Image.open(a).convert('RGB')
    B = Image.open(b).convert('RGB') if os.path.exists(b) else Image.new('RGB', A.size, 'white')
    if light_only:
        A = A.crop((0, 0, A.width // 2, A.height))
        B = B.crop((0, 0, B.width // 2, B.height))
    W = Image.new('RGB', (A.width + B.width + 12, max(A.height, B.height) + 30), (200, 200, 200))
    d = ImageDraw.Draw(W)
    W.paste(B, (0, 30)); W.paste(A, (B.width + 12, 30))
    d.text((10, 8), 'BEFORE (main)', fill=(160, 0, 0)); d.text((B.width + 22, 8), 'AFTER', fill=(0, 110, 0))
    W.save(os.path.join(out, n))
print('ok')
