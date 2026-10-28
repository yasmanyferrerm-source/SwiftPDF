"""Generates SwiftPDF's Android launcher icons and splash screens into resources/android/res.

Run:  python3 scripts/make-android-icons.py   (needs Pillow)
The build copies resources/android/res over the generated Android project (scripts/patch-android.cjs).
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RES = os.path.join(ROOT, 'resources', 'android', 'res')
C1 = (34, 87, 214)   # top
C2 = (20, 60, 170)   # bottom
SS = 4               # supersampling


def gradient(w, h):
    img = Image.new('RGBA', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3)) + (255,))
    return img


def draw_document(img, cx, cy, height, mono=False):
    """Page with folded corner, text lines and a signature, centred at (cx, cy)."""
    d = ImageDraw.Draw(img)
    k = height / 644.0                       # artwork was designed 444 x 644
    x1, y1 = cx - 222 * k, cy - 322 * k
    x2, y2 = cx + 222 * k, cy + 322 * k
    fold, r = 150 * k, 36 * k
    white = (255, 255, 255, 255)
    d.rounded_rectangle([x1, y1, x2 - fold, y2], radius=r, fill=white)
    d.rounded_rectangle([x1, y1 + fold, x2, y2], radius=r, fill=white)
    d.polygon([(x2 - fold - 1, y1), (x2, y1 + fold + 1), (x2 - fold - 1, y1 + fold + 1)], fill=white)
    if mono:
        # themed (monochrome) icon: only the silhouette with cut-outs
        clear = (0, 0, 0, 0)
        d.polygon([(x2 - fold, y1), (x2, y1 + fold), (x2 - fold, y1 + fold)], fill=clear)
        for i, w in enumerate([300, 250, 280]):
            yy = y1 + (140 + i * 70) * k
            d.rounded_rectangle([x1 + 70 * k, yy, x1 + (70 + w) * k, yy + 26 * k], radius=13 * k, fill=clear)
        line_col, base_col = clear, clear
    else:
        d.polygon([(x2 - fold, y1), (x2, y1 + fold), (x2 - fold, y1 + fold)], fill=(196, 214, 250, 255))
        for i, w in enumerate([300, 250, 280]):
            yy = y1 + (140 + i * 70) * k
            d.rounded_rectangle([x1 + 70 * k, yy, x1 + (70 + w) * k, yy + 26 * k], radius=13 * k, fill=(205, 214, 230, 255))
        line_col, base_col = (34, 87, 214, 255), (150, 165, 190, 255)
    pts = []
    for i in range(400):
        t = i / 399
        pts.append((x1 + (70 + t * 310) * k, y1 + (450 - 60 * math.sin(t * math.pi * 3.2) * (1 - t * 0.4) + t * 20) * k))
    d.line(pts, fill=line_col, width=max(2, int(26 * k)), joint='curve')
    d.line([(x1 + 70 * k, y1 + 540 * k), (x1 + 380 * k, y1 + 540 * k)], fill=base_col, width=max(1, int(10 * k)))


def finish(img, size):
    return img.resize((size, size), Image.LANCZOS)


def legacy_square(size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    bg = gradient(S, S)
    mask = Image.new('L', (S, S), 0)
    pad = S * 0.04
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], radius=S * 0.2, fill=255)
    img.paste(bg, (0, 0), mask)
    draw_document(img, S / 2, S / 2, S * 0.60)
    return finish(img, size)


def legacy_round(size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    mask = Image.new('L', (S, S), 0)
    pad = S * 0.04
    ImageDraw.Draw(mask).ellipse([pad, pad, S - pad, S - pad], fill=255)
    img.paste(gradient(S, S), (0, 0), mask)
    draw_document(img, S / 2, S / 2, S * 0.54)
    return finish(img, size)


def adaptive_foreground(size, mono=False):
    # 108dp canvas; launchers mask to a shape inside the central 66dp safe zone
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    draw_document(img, S / 2, S / 2, S * 0.47, mono=mono)
    return finish(img, size)


def adaptive_background(size):
    return finish(gradient(size * SS, size * SS), size)


def splash(w, h):
    img = gradient(w * 2, h * 2)
    s = min(w, h) * 2
    draw_document(img, w, h, s * 0.30)
    return img.resize((w, h), Image.LANCZOS).convert('RGB')


DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
SPLASH = {
    'drawable': (480, 320),
    'drawable-land-mdpi': (480, 320), 'drawable-land-hdpi': (800, 480), 'drawable-land-xhdpi': (1280, 720),
    'drawable-land-xxhdpi': (1600, 960), 'drawable-land-xxxhdpi': (1920, 1280),
    'drawable-port-mdpi': (320, 480), 'drawable-port-hdpi': (480, 800), 'drawable-port-xhdpi': (720, 1280),
    'drawable-port-xxhdpi': (960, 1600), 'drawable-port-xxxhdpi': (1280, 1920),
}


def save(img, rel):
    path = os.path.join(RES, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


def main():
    for name, f in DENS.items():
        legacy = round(48 * f)
        adaptive = round(108 * f)
        save(legacy_square(legacy), f'mipmap-{name}/ic_launcher.png')
        save(legacy_round(legacy), f'mipmap-{name}/ic_launcher_round.png')
        save(adaptive_foreground(adaptive), f'mipmap-{name}/ic_launcher_foreground.png')
        save(adaptive_foreground(adaptive, mono=True), f'mipmap-{name}/ic_launcher_monochrome.png')
        save(adaptive_background(adaptive), f'mipmap-{name}/ic_launcher_background.png')
    xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
"""
    for n in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        p = os.path.join(RES, 'mipmap-anydpi-v26', n)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w').write(xml)
    p = os.path.join(RES, 'values', 'ic_launcher_background.xml')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2257D6</color>\n</resources>\n')
    for folder, (w, h) in SPLASH.items():
        save(splash(w, h), f'{folder}/splash.png')
    print('Android icons written to', RES)


if __name__ == '__main__':
    main()
