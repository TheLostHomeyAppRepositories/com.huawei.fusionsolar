# The widget preview images (widgets/*/preview-light.png and preview-dark.png, 1024x1024),
# drawn as schematic wireframes in the style of Homey's preview template: a card,
# placeholder bars, and the widget's own colours where they carry meaning.
#
# Athom asks for previews without text, in simple shapes, on a transparent background, in
# a light and a dark version. Drawn by hand they fell behind the widgets: 1.2.339 changed
# the colours, and the previews still showed the battery green and PV green in the chart.
# Here they come from one place that a colour change can follow.
#
#   python scripts/widget-previews.py                draws all twelve into widgets/
#   python scripts/widget-previews.py netzampel      draws one
#   python scripts/widget-previews.py --out DIR      draws into DIR instead, to compare
#   python scripts/widget-previews.py --check        changes nothing; fails when a drawn
#                                                    preview differs from the one in widgets/
#
# Needs Python 3 and Pillow (pip install Pillow). test/widget-previews.test.js runs --check
# where both are installed.
#
# Coordinates are in widget CSS pixels (343 wide, as on a phone); the card is scaled to
# 800 px wide and centred. Drawn at 2x and reduced, for smooth edges.
import argparse
import functools
import math
import os
import sys
from PIL import Image, ImageChops, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'widgets')
SS = 2                    # supersampling
W_CSS = 343
CARD_W = 800
S = CARD_W / W_CSS * SS   # css px -> drawing px

THEMES = {
    'light': dict(card=(244, 244, 248, 255), ph=(229, 229, 234, 255), ph2=(216, 216, 224, 255),
                  tile=(237, 237, 242, 255), line=(226, 226, 232, 255), knob=(255, 255, 255, 255),
                  photo=(42, 42, 46, 255)),
    'dark':  dict(card=(28, 27, 33, 255), ph=(58, 58, 66, 255), ph2=(72, 72, 80, 255),
                  tile=(40, 40, 47, 255), line=(50, 50, 58, 255), knob=(235, 235, 240, 255),
                  photo=(14, 14, 16, 255)),
}
C = dict(amber=(245, 158, 11, 255), green=(52, 199, 89, 255), red=(255, 69, 58, 255),
         blue=(0, 122, 255, 255), orange=(255, 149, 0, 255), purple=(124, 92, 255, 255),
         grey=(160, 160, 170, 255), battery=(139, 92, 246, 255))
# The app's palette (review 2026-10-11): PV amber, house blue, import red, export green,
# battery violet; orange is a state (Homey's), and figures are placeholders, never coloured.


class Pen:
    def __init__(self, img, ox, oy, theme):
        self.d = ImageDraw.Draw(img)
        self.ox, self.oy, self.t = ox, oy, theme

    def P(self, x, y):
        return (self.ox + x * S, self.oy + y * S)

    # ImageDraw writes RGBA values as they are instead of blending them, so a translucent
    # colour is mixed with the card here — every translucent shape sits on the card.
    def c(self, col):
        if col is None or len(col) < 4 or col[3] >= 255:
            return col
        a = col[3] / 255
        bg = self.t['card']
        return tuple(int(round(col[i] * a + bg[i] * (1 - a))) for i in range(3)) + (255,)

    def rect(self, x, y, w, h, fill, r=4, outline=None, width=1):
        x0, y0 = self.P(x, y)
        x1, y1 = self.P(x + w, y + h)
        self.d.rounded_rectangle([x0, y0, x1, y1], radius=r * S, fill=self.c(fill),
                                 outline=self.c(outline), width=int(width * S) if outline else 0)

    def bar(self, x, y, w, h=10, fill=None):
        self.rect(x, y, w, h, fill or self.t['ph'], r=h / 2)

    def circle(self, cx, cy, r, fill=None, outline=None, width=2):
        x0, y0 = self.P(cx - r, cy - r)
        x1, y1 = self.P(cx + r, cy + r)
        self.d.ellipse([x0, y0, x1, y1], fill=self.c(fill), outline=self.c(outline), width=int(width * S) if outline else 0)

    def line(self, pts, fill, width=2):
        self.d.line([self.P(x, y) for x, y in pts], fill=self.c(fill), width=int(width * S), joint='curve')

    def dashed(self, x0, y0, x1, y1, fill, width=2, dash=5, gap=4):
        L = math.hypot(x1 - x0, y1 - y0)
        n = int(L // (dash + gap)) + 1
        for i in range(n):
            a = i * (dash + gap) / L
            b = min(1, (i * (dash + gap) + dash) / L)
            if a >= 1:
                break
            self.line([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a), (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)], fill, width)

    def poly(self, pts, fill):
        self.d.polygon([self.P(x, y) for x, y in pts], fill=self.c(fill))


def with_alpha(c, a):
    return (c[0], c[1], c[2], a)


# ── one function per widget: (height in css px, draw(pen, theme)) ─────────────────────

def solar_power_flow(p, t):
    W = 343 - 16
    ox, oy = 8, 8
    cx, cy = ox + W / 2, oy + 118
    # lines
    p.dashed(cx, oy + 66, cx, cy - 16, C['amber'], 2)
    p.dashed(cx, cy + 16, cx, oy + 170, C['blue'], 2)
    p.dashed(ox + 92, cy, cx - 16, cy, C['green'], 2)
    p.dashed(cx + 16, cy, ox + W - 92, cy, C['battery'], 2)
    p.circle(cx, cy, 16, fill=t['ph'], outline=C['green'], width=2)
    def node(x, y, color, sub=False):
        p.circle(x, y - 26, 9, fill=color)
        p.bar(x - 34, y - 10, 68, 14, t['ph2'])
        p.bar(x - 22, y + 10, 44, 9)
        if sub:
            p.bar(x - 26, y + 28, 52, 9, with_alpha(color, 160))
    node(cx, oy + 33, C['amber'])
    node(ox + W * 0.16, cy, C['green'], True)
    node(ox + W * 0.84, cy, C['battery'], True)
    node(cx, oy + 203, C['blue'])


def netzampel(p, t):
    p.circle(16 + 24, 16 + 30, 24, fill=C['green'])
    p.circle(16 + 24, 16 + 30, 30, outline=with_alpha(C['green'], 110), width=2)
    p.bar(80, 20, 90, 10)
    p.bar(80, 38, 120, 22, t['ph2'])
    p.bar(80, 68, 60, 10)
    p.rect(16, 100, 311, 1, t['line'], r=0)
    for i, col in enumerate([C['amber'], C['battery'], C['blue']]):
        x = 16 + i * 108
        p.circle(x + 8, 124, 7, fill=col)
        p.bar(x + 22, 119, 64, 10, t['ph2'])


def energy_balance(p, t):
    rows = [(C['amber'], 1.0), (C['green'], 0.45), (C['red'], 0.15), (C['blue'], 0.7)]
    y = 16
    for col, frac in rows:
        p.circle(20, y + 9, 4, fill=col)
        p.bar(30, y + 4, 110, 10)
        p.bar(327 - 60, y + 4, 60, 10, t['ph2'])
        p.rect(16, y + 24, 311, 6, t['ph'], r=3)
        p.rect(16, y + 24, 311 * frac, 6, col, r=3)
        y += 42
    for i in range(2):
        x = 16 + i * 159
        p.rect(x, y, 152, 54, None, r=6, outline=t['line'], width=1.5)
        p.bar(x + 12, y + 10, 80, 9)
        p.bar(x + 12, y + 28, 50, 16, t['ph2'])
    y += 62
    for i, col in enumerate([C['battery'], C['battery']]):
        x = 16 + i * 159
        p.rect(x, y, 152, 46, None, r=6, outline=t['line'], width=1.5)
        p.circle(x + 18, y + 14, 5, fill=col)
        p.bar(x + 28, y + 9, 60, 9)
        p.bar(x + 12, y + 26, 56, 11, t['ph2'])


def daily_yield(p, t):
    p.circle(21, 23, 5, fill=C['amber'])
    p.bar(30, 18, 86, 10)
    p.bar(16, 38, 120, 30, t['ph2'])
    p.bar(142, 54, 28, 10)
    p.bar(327 - 56, 30, 56, 10)
    p.bar(327 - 80, 50, 80, 14, t['ph2'])
    p.rect(16, 88, 311, 1, t['line'], r=0)
    p.circle(24, 112, 7, fill=C['green'])
    p.bar(36, 107, 50, 10, t['ph2'])
    p.bar(92, 107, 70, 10)
    p.circle(220, 112, 4, fill=C['green'])
    p.bar(230, 107, 96, 10)


def battery_status(p, t):
    p.circle(26, 36, 9, fill=C['battery'])
    p.bar(42, 22, 58, 28, t['ph2'])
    p.rect(120, 24, 207, 12, t['ph'], r=6)
    p.rect(120, 24, 130, 12, C['battery'], r=6)
    p.bar(120, 44, 60, 9)
    p.bar(260, 44, 66, 9, t['ph2'])
    p.circle(26, 82, 9, fill=C['battery'])
    p.bar(42, 72, 70, 20, t['ph2'])
    p.bar(120, 77, 60, 10)
    for i, col in enumerate([C['battery'], C['battery']]):
        x = 16 + i * 159
        p.rect(x, 108, 152, 52, None, r=6, outline=t['line'], width=1.5)
        p.circle(x + 18, 122, 5, fill=col)
        p.bar(x + 28, 117, 86, 9)
        p.bar(x + 12, 136, 64, 13, t['ph2'])


def charger_status(p, t):
    p.rect(8, 8, 327, 348, t['photo'], r=10)
    p.circle(8 + 163, 8 + 150, 70, outline=C['blue'], width=6)
    p.circle(8 + 163, 8 + 150, 40, fill=(60, 60, 66, 255))
    p.bar(8, 370, 220, 14, t['ph2'])
    p.bar(8, 392, 150, 9)
    p.rect(8, 414, 327, 1, t['line'], r=0)
    for i in range(3):
        x = 8 + i * 118
        p.bar(x, 426, 64, 14, t['ph2'])
        p.bar(x, 448, 50, 9)


def session_history(p, t):
    p.rect(16, 16, 311, 52, None, r=6, outline=C['blue'], width=1.5)
    p.circle(30, 30, 4, fill=C['blue'])
    p.bar(40, 25, 200, 10, t['ph2'])
    p.bar(28, 46, 140, 10, t['ph2'])
    p.rect(16, 76, 311, 52, None, r=6, outline=C['orange'], width=1.5)
    p.circle(30, 90, 4, fill=C['orange'])
    p.bar(40, 85, 180, 10, t['ph2'])
    p.bar(28, 106, 120, 10, t['ph2'])
    y = 144
    for i in range(3):
        p.bar(16, y, 170, 10, t['ph2'])
        p.bar(327 - 90, y, 90, 9)
        p.bar(16, y + 18, 110, 9)
        p.bar(327 - 70, y + 18, 70, 9)
        if i < 2:
            p.rect(16, y + 38, 311, 1, t['line'], r=0)
        y += 48


def sensor_chart(p, t):
    p.rect(8, 14, 14, 3, C['amber'], r=1)
    p.bar(26, 10, 110, 10)
    p.bar(140, 10, 34, 10, t['ph2'])
    p.rect(8, 34, 14, 3, C['battery'], r=1)
    p.bar(26, 30, 40, 10)
    p.circle(250, 22, 13, outline=t['line'], width=1.5)
    p.bar(270, 17, 28, 10, t['ph2'])
    p.circle(318, 22, 13, outline=t['line'], width=1.5)
    top, h, left, w = 60, 168, 54, 273
    for i in range(5):
        p.rect(left, top + i * h / 4, w, 1, t['line'], r=0)
        p.bar(14, top + i * h / 4 - 5, 28, 9)
    pts = []
    for i in range(61):
        x = left + w * i / 60
        v = max(0, math.sin((i / 60) * math.pi * 1.1 - 0.25)) * 0.85
        pts.append((x, top + h - v * h))
    p.poly(pts + [(left + w, top + h), (left, top + h)], with_alpha(C['amber'], 50))
    p.line(pts, C['amber'], 2.2)
    pts2 = []
    for i in range(61):
        x = left + w * i / 60
        v = 0.12 + (0.55 if 44 <= i <= 47 else 0) + 0.03 * math.sin(i)
        pts2.append((x, top + h - v * h))
    p.line(pts2, C['battery'], 2.2)
    for i in range(5):
        p.bar(min(left + w - 32, max(left, left + w * i / 4 - 16)), top + h + 12, 32, 9)


def ems_device(p, t):
    p.bar(16, 18, 140, 14, t['ph2'])
    p.rect(327 - 92, 14, 92, 24, None, r=12, outline=C['green'], width=1.5)
    p.bar(327 - 78, 21, 64, 10, with_alpha(C['green'], 200))
    y = 50
    for kind in ['on', 'select', 'off']:
        p.rect(16, y, 311, 40, None, r=6, outline=t['line'], width=1.5)
        p.bar(28, y + 15, 110 if kind != 'select' else 90, 10)
        if kind != 'select':
            on = kind == 'on'
            p.rect(327 - 56, y + 7, 44, 26, C['green'] if on else t['ph2'], r=13)
            p.circle(327 - 56 + (31 if on else 13), y + 20, 10, fill=t['knob'])
        y += 48
    p.rect(16, y, 311, 1, t['line'], r=0)
    for i in range(3):
        x = 16 + i * 112
        p.bar(x, y + 14, 64, 14, t['ph2'])
        p.bar(x, y + 36, 50, 9)
    y += 60
    p.rect(16, y, 311, 1, t['line'], r=0)
    p.circle(24, y + 20, 7, fill=t['ph2'])
    p.bar(38, y + 15, 120, 10, t['ph2'])
    p.bar(16, y + 36, 110, 9)
    p.rect(36, y + 58, 291, 10, t['ph'], r=5)
    p.rect(36, y + 58, 160, 10, C['blue'], r=5)
    p.rect(36 + 291 * 0.8, y + 55, 2, 16, t['ph2'], r=0)
    for i in range(3):
        x = 16 + i * 106
        p.rect(x, y + 80, 99, 30, None, r=15, outline=C['blue'] if i == 1 else t['line'], width=1.5)
        p.bar(x + 34, y + 90, 32, 10)


def ems_battery(p, t):
    p.bar(16, 18, 120, 14, t['ph2'])
    p.bar(327 - 48, 18, 48, 14, t['ph2'])
    p.bar(16, 42, 100, 9)
    p.rect(16, 64, 311, 16, t['ph'], r=8)
    p.rect(16, 64, 196, 16, C['battery'], r=8)
    p.rect(16 + 311 * 0.2, 60, 2, 24, t['ph2'], r=0)
    p.bar(16, 100, 80, 10)
    p.rect(104, 92, 64, 28, None, r=6, outline=t['line'], width=1.5)
    p.bar(140, 101, 20, 10, t['ph2'])
    p.rect(16, 136, 311, 1, t['line'], r=0)
    p.circle(22, 158, 4, fill=C['battery'])
    p.bar(32, 153, 160, 10)


def ems_forecast(p, t):
    p.bar(16, 18, 120, 14, t['ph2'])
    p.circle(327 - 16, 25, 16, outline=t['line'], width=1.5)
    def section(y, colors):
        p.bar(16, y, 90, 10, t['ph2'])
        p.bar(16, y + 20, 150, 9)
        p.bar(16, y + 42, 56, 9)
        p.bar(130, y + 42, 80, 9, t['ph2'])
        p.bar(327 - 56, y + 42, 56, 9)
        n = 32
        bw = 311 / n
        for i in range(n):
            v = colors(i / (n - 1))
            hgt, col = v
            if i:
                col = with_alpha(col, 128)
            p.rect(16 + i * bw, y + 66 + 56 - hgt, bw - 1.5, hgt, col, r=1)
        for i in range(6):
            p.bar(16 + i * 58, y + 128, 14, 9)
    section(48, lambda f: (max(4, math.sin(f * math.pi) * 56), C['amber']))
    p.rect(16, 196, 311, 1, t['line'], r=0)
    def price(f):
        v = 0.5 + 0.45 * math.sin(f * math.pi * 2 + 1)
        hue = (int(255 * v), int(200 * (1 - v)) + 40, 60, 255)
        return (max(4, v * 56), hue)
    section(210, price)


def ems_history(p, t):
    p.circle(32, 28, 16, outline=t['line'], width=1.5)
    p.bar(140, 23, 64, 10, t['ph2'])
    p.circle(272, 28, 16, outline=t['line'], width=1.5)
    p.circle(311, 28, 16, outline=t['line'], width=1.5)
    p.bar(38, 62, 50, 9)
    y = 84
    marks = [C['orange'], C['amber'], C['battery'], C['grey'], C['red'], C['green']]
    for i, col in enumerate(marks):
        if i < len(marks) - 1:
            p.rect(22.5, y + 16, 1, 36, t['line'], r=0)
        p.circle(23, y + 6, 11, fill=t['card'], outline=t['line'], width=1.2)
        p.circle(23, y + 6, 5, fill=col)
        p.bar(38, y, 130 - (i % 3) * 20, 11, t['ph2'])
        p.bar(327 - 40, y, 40, 9)
        p.bar(38, y + 20, 100 + (i % 2) * 40, 9)
        y += 52


WIDGETS = {
    'solar-power-flow': (252, solar_power_flow),
    'netzampel': (157, netzampel),
    'energy-balance': (304, energy_balance),
    'daily-yield': (145, daily_yield),
    'battery-status': (178, battery_status),
    'charger-status': (480, charger_status),
    'session-history': (300, session_history),
    'sensor-chart': (264, sensor_chart),
    'ems-device': (384, ems_device),
    'ems-battery': (193, ems_battery),
    'ems-forecast': (405, ems_forecast),
    'ems-history': (420, ems_history),
}


def render(name, theme_name):
    global S
    h_css, fn = WIDGETS[name]
    t = THEMES[theme_name]
    size = 1024 * SS
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    card_h = h_css * S
    scale = 1.0
    if card_h > 920 * SS:            # very tall widgets are drawn smaller to fit
        scale = (920 * SS) / card_h
    S0 = S
    S = S0 * scale
    card_w = W_CSS * S
    card_h = h_css * S
    ox = (size - card_w) / 2
    oy = (size - card_h) / 2
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([ox, oy, ox + card_w, oy + card_h], radius=24 * SS, fill=t['card'])
    fn(Pen(img, ox, oy, t), t)
    S = S0
    return img.resize((1024, 1024), Image.LANCZOS)


# Pixels that differ by more than a rounding step. Another Pillow version may resample an
# edge one or two steps differently; a changed colour moves thousands of pixels by far more.
def changed_pixels(a, b):
    diff = ImageChops.difference(a.convert('RGBA'), b.convert('RGBA'))
    most = functools.reduce(ImageChops.lighter, diff.split())
    return most.point(lambda v: 255 if v > 24 else 0).histogram()[255]


def main():
    ap = argparse.ArgumentParser(description='Draw the widget preview images.')
    ap.add_argument('widget', nargs='?', default='all', help='one widget, or all (default)')
    ap.add_argument('--out', help='draw into this folder instead of widgets/')
    ap.add_argument('--check', action='store_true', help='compare with widgets/, write nothing')
    args = ap.parse_args()
    if args.widget != 'all' and args.widget not in WIDGETS:
        ap.error(f'unknown widget {args.widget!r}; one of: ' + ', '.join(WIDGETS))
    missing = sorted(set(os.listdir(ROOT)) - set(WIDGETS))
    if missing:
        sys.exit('widgets without a drawing here: ' + ', '.join(missing))

    if args.out:
        os.makedirs(args.out, exist_ok=True)
    stale = []
    for name in WIDGETS:
        if args.widget != 'all' and name != args.widget:
            continue
        for theme in ('light', 'dark'):
            img = render(name, theme)
            committed = os.path.join(ROOT, name, f'preview-{theme}.png')
            if args.check:
                n = changed_pixels(img, Image.open(committed))
                if n > 50:
                    stale.append(f'{name} {theme}: {n} pixels differ')
                continue
            path = os.path.join(args.out, f'{name}-{theme}.png') if args.out else committed
            img.save(path, optimize=True)
            print('wrote', path)
    if stale:
        sys.exit('previews out of date, run python scripts/widget-previews.py\n  ' + '\n  '.join(stale))
    if args.check:
        print('previews up to date')


if __name__ == '__main__':
    main()
