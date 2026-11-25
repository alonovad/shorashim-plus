#!/usr/bin/env python3
"""Plan set generator for a Shorashim Plus shed project (mono-pitch flat trusses
on longitudinal lattice girders). Every number is read from the project JSON
exported from the app, so the drawing, the quantities and the app agree.
Usage: gen.py project.json out_dir
"""
import json, math, sys, os, hashlib, datetime, html

src, out = sys.argv[1], sys.argv[2]
P = json.load(open(src, encoding='utf-8'))
pr, d = P['project'], P['project']['dims']
rows = P['rows']

# ── model (mirrors buildplan-geom.js) ─────────────────────────────────────
W = 1 + d['waste'] / 100.0
span, length = d['span'], d['length']
rise = span * math.tan(math.radians(d['pitch']))
raf = math.hypot(span, rise)
bays = max(1, round(length / d['bay']))
bay = length / bays
frames = bays + 1
ce = d['colEvery'] if d['colEvery'] > 1 else 1
colF = [i for i in range(frames) if i % ce == 0 or i == frames - 1]
tPan = max(4, round(raf / 1.17))
tPL = raf / tPan                      # along slope
tDx = span / tPan                     # plan projection
tD = d['trussDepth']
gD = d['girderD'] or 1.0
gPan = max(2, round(length / 1.0))
gPL = length / gPan
purlins = math.ceil(raf / d['purlinSp']) + 1
colTop = d['colH']                    # existing poles stop here
# levels
A_gTop = colTop                       # low side: girder between the poles
A_gBot = colTop - gD
B_gBot = colTop                       # high side: girder on the pole heads
B_gTop = colTop + gD
T_A_bot = A_gTop                      # truss bears on the low girder top
T_A_top = T_A_bot + tD
T_B_top = d['eaves'] + rise           # model ridge
T_B_bot = T_B_top - tD
shim = B_gTop - T_B_bot               # negative = gap to pack
slope_pc = rise / span * 100
axes = [str(i + 1) for i in range(frames)]

def zbot(x): return T_A_bot + (T_B_bot - T_A_bot) * x / span
def ztop(x): return T_A_top + (T_B_top - T_A_top) * x / span

steel_extra = {'L 50x5': 3.77, 'מוט פלדה Ø16': 1.58}
kg_sections = sum(r['kg'] for r in rows)
kg_extra = sum(r['qty'] * steel_extra.get(r['name'], 0) for r in rows)
kg_plates = sum(r['qty'] for r in rows if r['unit'] == 'ק"ג')
kg_total = kg_sections + kg_extra + kg_plates
cost_total = sum(r['qty'] * r['price'] for r in rows)

E = html.escape
def f1(x): return ('%.1f' % x).rstrip('0').rstrip('.') if abs(x - round(x)) > 1e-9 else '%d' % round(x)
def f2(x): return '%.2f' % x
def lvl(z): return ('+%.2f' % z)

# ── SVG helpers ───────────────────────────────────────────────────────────
C_STEEL = '#1f3a5f'; C_WEB = '#3d6fa8'; C_PUR = '#b5651d'; C_COL = '#555'
C_DIM = '#444'; C_BR = '#2e7d32'; C_AX = '#9e9e9e'

class S:
    def __init__(self, w, h): self.w, self.h, self.o = w, h, []
    def line(self, x1, y1, x2, y2, c='#000', sw=1, dash=None, op=1):
        self.o.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" stroke-width="%.2f"%s%s/>' % (
            x1, y1, x2, y2, c, sw, (' stroke-dasharray="%s"' % dash) if dash else '', (' opacity="%s"' % op) if op != 1 else ''))
    def rect(self, x, y, w, h, c='#000', sw=1, fill='none', dash=None):
        self.o.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" stroke="%s" stroke-width="%.2f" fill="%s"%s/>' % (
            x, y, w, h, c, sw, fill, (' stroke-dasharray="%s"' % dash) if dash else ''))
    def circ(self, x, y, r, c='#000', fill='#fff', sw=1):
        self.o.append('<circle cx="%.2f" cy="%.2f" r="%.2f" stroke="%s" fill="%s" stroke-width="%.2f"/>' % (x, y, r, c, fill, sw))
    def poly(self, pts, c='#000', fill='none', sw=1, op=1):
        self.o.append('<polygon points="%s" stroke="%s" fill="%s" stroke-width="%.2f" opacity="%s"/>' % (
            ' '.join('%.2f,%.2f' % p for p in pts), c, fill, sw, op))
    def text(self, x, y, t, size=11, anchor='middle', c='#111', bold=False, rot=0, rtl=False, mono=False):
        tr = ' transform="rotate(%.1f %.2f %.2f)"' % (rot, x, y) if rot else ''
        fam = 'DejaVu Sans Mono,monospace' if mono else 'DejaVu Sans,Arial,sans-serif'
        self.o.append('<text x="%.2f" y="%.2f" font-size="%.1f" text-anchor="%s" fill="%s" font-family="%s"%s%s%s>%s</text>' % (
            x, y, size, anchor, c, fam, ' font-weight="700"' if bold else '', tr,
            ' direction="rtl" unicode-bidi="plaintext"' if rtl else '', E(t)))
    def svg(self):
        return '<svg viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" style="direction:ltr;width:100%%;height:auto">%s</svg>' % (
            self.w, self.h, ''.join(self.o))

def dim_h(s, x1, x2, y, label, off=0, size=10):
    s.line(x1, y, x2, y, C_DIM, 0.8)
    for x in (x1, x2):
        s.line(x - 3, y + 3, x + 3, y - 3, C_DIM, 1)
        s.line(x, y - 6 - off, x, y + 6, C_DIM, 0.5)
    s.text((x1 + x2) / 2, y - 3, label, size, mono=True)

def dim_v(s, x, y1, y2, label, size=10):
    s.line(x, y1, x, y2, C_DIM, 0.8)
    for y in (y1, y2):
        s.line(x - 3, y + 3, x + 3, y - 3, C_DIM, 1)
        s.line(x - 6, y, x + 6, y, C_DIM, 0.5)
    s.text(x - 4, (y1 + y2) / 2, label, size, rot=-90, mono=True)

def bubble(s, x, y, t, r=9):
    s.circ(x, y, r, '#333', '#fff', 1)
    s.text(x, y + 4, t, 10, bold=True)

def level_mark(s, x, y, z, side='r'):
    s.poly([(x, y), (x - 5, y - 7), (x + 5, y - 7)], '#000', '#000', 0.6)
    s.text(x + (8 if side == 'r' else -8), y - 2, lvl(z), 9.5, anchor='start' if side == 'r' else 'end', mono=True)

# ══ 1. ROOF PLAN ══════════════════════════════════════════════════════════
def roof_plan():
    sc = 34.0; ox, oy = 120, 70          # x(length) right, y(span) down: A at top (low)
    s = S(int(ox + length * sc + 150), int(oy + span * sc + 110))
    X = lambda y_len: ox + y_len * sc
    Y = lambda x_span: oy + x_span * sc
    # roof outline (sheets 14.3)
    s.rect(X(0), Y(0) - 0.13 * sc, length * sc, (span + 0.26) * sc, '#bbb', 0.6, '#f4f1ea')
    # purlins
    for k in range(purlins):
        xs = k * tDx
        s.line(X(0), Y(xs), X(length), Y(xs), C_PUR, 1.4)
    # L50 ties on bottom chords (3 lines)
    for q in (0.25, 0.5, 0.75):
        s.line(X(0), Y(span * q), X(length), Y(span * q), C_BR, 0.9, '7,4')
    # roof X-bracing in end bays (two bays deep), two panels across
    nb = max(1, round(5.0 / bay))          # X panels about 5 m long, one per end
    for (a0, a1) in ((0, nb * bay), (length - nb * bay, length)):
        for (s0, s1) in ((0, span / 2), (span / 2, span)):
            s.line(X(a0), Y(s0), X(a1), Y(s1), C_BR, 1.1)
            s.line(X(a0), Y(s1), X(a1), Y(s0), C_BR, 1.1)
    # girders on lines A and B
    for xs in (0, span):
        s.line(X(0), Y(xs), X(length), Y(xs), C_STEEL, 4.2)
    # trusses
    for i in range(frames):
        s.line(X(i * bay), Y(0), X(i * bay), Y(span), C_STEEL, 3)
        bubble(s, X(i * bay), Y(0) - 38, axes[i])
        s.line(X(i * bay), Y(0) - 29, X(i * bay), Y(0) - 6, C_AX, 0.6, '4,3')
    # columns
    for i in colF:
        for xs in (0, span):
            s.circ(X(i * bay), Y(xs), 0.273 / 2 * sc + 2.5, '#000', '#777', 1)
    for xs, t in ((0, 'A'), (span, 'B')):
        bubble(s, X(0) - 40, Y(xs), t)
        s.line(X(0) - 31, Y(xs), X(0) - 6, Y(xs), C_AX, 0.6, '4,3')
    # dimension chains
    yb = Y(span) + 34
    for i in range(bays):
        dim_h(s, X(i * bay), X((i + 1) * bay), yb, f2(bay))
    dim_h(s, X(0), X(length), yb + 26, f2(length) + ' m', size=11)
    dim_v(s, X(length) + 40, Y(0), Y(span), f2(span) + ' m', size=11)
    # slope arrow
    xm = X(length / 2 - bay / 2)
    s.line(xm, Y(span * 0.8), xm, Y(span * 0.2), '#c62828', 1.6)
    s.poly([(xm, Y(span * 0.8) + 2), (xm - 5, Y(span * 0.8) - 8), (xm + 5, Y(span * 0.8) - 8)], '#c62828', '#c62828')
    s.text(xm + 8, Y(span * 0.5), '%.1f%%' % slope_pc, 11, anchor='start', c='#c62828', bold=True, mono=True)
    s.text(X(length) + 12, Y(0) + 4, 'A  ' + lvl(T_A_top), 9.5, anchor='start', mono=True)
    s.text(X(length) + 12, Y(span) + 4, 'B  ' + lvl(T_B_top), 9.5, anchor='start', mono=True)
    return s.svg()

# ══ 2. CROSS SECTION ═════════════════════════════════════════════════════
def truss_lines(s, X, Z, x0=0.0):
    nodes = [(k * tDx) for k in range(tPan + 1)]
    s.line(X(0), Z(ztop(0)), X(span), Z(ztop(span)), C_STEEL, 2.6)
    s.line(X(0), Z(zbot(0)), X(span), Z(zbot(span)), C_STEEL, 3.0)
    for x in nodes:
        s.line(X(x), Z(zbot(x)), X(x), Z(ztop(x)), C_WEB, 1.2)
    half = tPan // 2
    for k in range(tPan):
        a, b = nodes[k], nodes[k + 1]
        if k < half:   # Pratt: top at the outer node, bottom toward mid
            s.line(X(a), Z(ztop(a)), X(b), Z(zbot(b)), C_WEB, 1.2)
        else:
            s.line(X(a), Z(zbot(a)), X(b), Z(ztop(b)), C_WEB, 1.2)
    return nodes

def cross_section(with_cols):
    sc = 40.0; ox, oy = 110, 40; zmax = T_B_top + 0.6
    s = S(int(ox + span * sc + 200), int(oy + zmax * sc + 80))
    X = lambda x: ox + x * sc
    Z = lambda z: oy + (zmax - z) * sc
    s.line(X(-1.5), Z(0), X(span + 1.5), Z(0), '#000', 1.2)
    for k in range(int((span + 3) / 0.5)):
        x = -1.5 + k * 0.5
        s.line(X(x), Z(0), X(x) - 6, Z(0) + 6, '#999', 0.6)
    # girders in section (box)
    s.rect(X(0) - 0.08 * sc, Z(A_gTop), 0.16 * sc, gD * sc, C_STEEL, 1.4, '#dfe7f1')
    s.rect(X(span) - 0.08 * sc, Z(B_gTop), 0.16 * sc, gD * sc, C_STEEL, 1.4, '#dfe7f1')
    if with_cols:
        for xs in (0, span):
            s.rect(X(xs) - 0.1365 * sc, Z(colTop), 0.273 * sc, colTop * sc, '#000', 1, '#cfcfcf')
        # knee braces (schematic)
        s.line(X(0.1365), Z(colTop - 1.0), X(1.2), Z(zbot(1.2)), '#6a1b9a', 2)
        s.line(X(span - 0.1365), Z(colTop - 1.0), X(span - 1.2), Z(zbot(span - 1.2)), '#6a1b9a', 2)
    else:
        for xs in (0, span):
            s.rect(X(xs) - 0.1365 * sc, Z(colTop), 0.273 * sc, colTop * sc, '#999', 0.8, 'none', '4,3')
    nodes = truss_lines(s, X, Z)
    for x in nodes:   # purlins on every top node
        zt = ztop(x)
        s.rect(X(x) - 0.06 * sc, Z(zt) - 0.12 * sc, 0.12 * sc, 0.12 * sc, C_PUR, 1, '#f3d9c0')
    # roof sheet
    s.line(X(-0.13), Z(ztop(0) + 0.13 - 0.009), X(span + 0.13), Z(ztop(span) + 0.13 + 0.009), '#777', 1.6)
    # levels
    for z, x, side in ((A_gBot, -0.4, 'l'), (A_gTop, -0.4, 'l'), (T_A_top, -0.4, 'l'), (0, -0.4, 'l'),
                       (B_gBot, span + 0.4, 'r'), (B_gTop, span + 0.4, 'r'), (T_B_top, span + 0.4, 'r')):
        level_mark(s, X(x), Z(z), z, side)
    dim_h(s, X(0), X(span), Z(0) + 32, f2(span) + ' m', size=11)
    for xs, t in ((0, 'A'), (span, 'B')):
        bubble(s, X(xs), Z(0) + 60, t)
    s.text(X(span / 2), Z(ztop(span / 2)) - 22, 'T1 · %d × %.3f · %s / %s / %s' % (
        tPan, tPL, d['rafterProfile'], d['trussBotProfile'], d['trussWebProfile']), 10.5, mono=True, bold=True)
    s.text(X(span / 2), Z(ztop(span / 2)) - 38, '%s @ %s' % (d['purlinProfile'], f2(tPL)), 10, mono=True, c=C_PUR)
    s.text(X(0) + 6, Z(A_gBot) + 16, 'G-A', 10, anchor='start', mono=True, bold=True)
    s.text(X(span) - 6, Z(B_gBot) + 16, 'G-B', 10, anchor='end', mono=True, bold=True)
    if abs(shim) > 0.004:
        s.text(X(span) - 14, Z(B_gTop) - 6, 'shim %d mm' % round(abs(shim) * 1000), 9, anchor='end', mono=True, c='#c62828')
    return s.svg()

# ══ 3. LONGITUDINAL ELEVATIONS ═══════════════════════════════════════════
def long_elev(line):
    sc = 30.0; ox, oy = 70, 30
    top = (T_A_top if line == 'A' else T_B_top) + 0.3
    s = S(int(ox + length * sc + 120), int(oy + top * sc + 70))
    X = lambda y: ox + y * sc
    Z = lambda z: oy + (top - z) * sc
    s.line(X(-1), Z(0), X(length + 1), Z(0), '#000', 1.2)
    gb, gt = (A_gBot, A_gTop) if line == 'A' else (B_gBot, B_gTop)
    for i in colF:
        s.rect(X(i * bay) - 0.1365 * sc, Z(colTop), 0.273 * sc, colTop * sc, '#000', 1, '#cfcfcf')
    s.line(X(0), Z(gt), X(length), Z(gt), C_STEEL, 2.6)
    s.line(X(0), Z(gb), X(length), Z(gb), C_STEEL, 2.6)
    for k in range(gPan + 1):
        s.line(X(k * gPL), Z(gb), X(k * gPL), Z(gt), C_WEB, 1)
    # Pratt per span between column frames, mirrored about each span's middle
    spans = [(colF[j] * bay, colF[j + 1] * bay) for j in range(len(colF) - 1)]
    for (a, b) in spans:
        n = round((b - a) / gPL); h = n // 2
        for k in range(n):
            x0, x1 = a + k * gPL, a + (k + 1) * gPL
            if k < h: s.line(X(x0), Z(gt), X(x1), Z(gb), C_WEB, 1)
            else:     s.line(X(x0), Z(gb), X(x1), Z(gt), C_WEB, 1)
    # trusses bearing on top chord (seen end-on) + purlin end
    for i in range(frames):
        zt = T_A_bot if line == 'A' else T_B_bot
        s.rect(X(i * bay) - 0.05 * sc, Z(zt + tD), 0.1 * sc, tD * sc, C_STEEL, 1, '#dfe7f1')
        bubble(s, X(i * bay), Z(0) + 44, axes[i])
    for z in (0, gb, gt):
        level_mark(s, X(length) + 30, Z(z), z)
    for (a, b) in spans:
        dim_h(s, X(a), X(b), Z(0) + 20, f2(b - a))
    note = ('קורה בין העמודים' if line == 'A' else 'קורה על ראשי העמודים')
    s.text(X(length / 2), Z(gb) + 16, 'G-%s · %s / %s · %d × %s · %s' % (line, d['girderProfile'], d['trussWebProfile'], gPan, f2(gPL), note), 10, mono=False)
    return s.svg()

# ══ 4. TRUSS DETAIL ══════════════════════════════════════════════════════
def truss_detail():
    sc = 52.0; ox, oy = 50, 40
    s = S(int(ox + raf * sc + 60), int(oy + tD * sc + 110))
    # drawn along its own axis (unrotated)
    X = lambda u: ox + u * sc
    Z = lambda v: oy + (tD - v) * sc
    s.line(X(0), Z(tD), X(raf), Z(tD), C_STEEL, 3)
    s.line(X(0), Z(0), X(raf), Z(0), C_STEEL, 3.4)
    half = tPan // 2
    for k in range(tPan + 1):
        s.line(X(k * tPL), Z(0), X(k * tPL), Z(tD), C_WEB, 1.4)
        s.text(X(k * tPL), Z(tD) - 8, str(k), 9, mono=True)
    for k in range(tPan):
        a, b = k * tPL, (k + 1) * tPL
        if k < half: s.line(X(a), Z(tD), X(b), Z(0), C_WEB, 1.4)
        else:        s.line(X(a), Z(0), X(b), Z(tD), C_WEB, 1.4)
    for k in range(tPan):
        dim_h(s, X(k * tPL), X((k + 1) * tPL), Z(0) + 22, '%.3f' % tPL, size=8.5)
    dim_h(s, X(0), X(raf), Z(0) + 48, '%.3f m' % raf, size=10.5)
    dim_v(s, X(raf) + 26, Z(tD), Z(0), f2(tD), size=9.5)
    return s.svg()

# ══ 5. ISOMETRIC ═════════════════════════════════════════════════════════
def iso():
    a = math.radians(28); sc = 15.0
    def pj(x, y, z):   # x = span, y = length, z = up
        u = (y * math.cos(a) - x * math.cos(a))
        v = (y * math.sin(a) + x * math.sin(a)) - z * 1.0
        return u, v
    pts = []
    segs = []
    def seg(p, q, c, w): segs.append((p, q, c, w))
    for i in colF:
        for xs in (0, span):
            seg((xs, i * bay, 0), (xs, i * bay, colTop), C_COL, 2.2)
    for xs, gb, gt in ((0, A_gBot, A_gTop), (span, B_gBot, B_gTop)):
        seg((xs, 0, gb), (xs, length, gb), C_STEEL, 1.6); seg((xs, 0, gt), (xs, length, gt), C_STEEL, 1.6)
        for k in range(gPan + 1):
            seg((xs, k * gPL, gb), (xs, k * gPL, gt), C_WEB, 0.6)
    for i in range(frames):
        y = i * bay
        seg((0, y, ztop(0)), (span, y, ztop(span)), C_STEEL, 1.3)
        seg((0, y, zbot(0)), (span, y, zbot(span)), C_STEEL, 1.3)
        for k in range(tPan + 1):
            x = k * tDx; seg((x, y, zbot(x)), (x, y, ztop(x)), C_WEB, 0.5)
        for k in range(tPan):
            x0, x1 = k * tDx, (k + 1) * tDx
            if k < tPan // 2: seg((x0, y, ztop(x0)), (x1, y, zbot(x1)), C_WEB, 0.5)
            else:             seg((x0, y, zbot(x0)), (x1, y, ztop(x1)), C_WEB, 0.5)
    for k in range(purlins):
        x = k * tDx; seg((x, 0, ztop(x) + 0.08), (x, length, ztop(x) + 0.08), C_PUR, 0.9)
    allp = [pj(*p) for sgm in segs for p in sgm[:2]] + [pj(0, 0, 0), pj(span, length, 0), pj(span, 0, 0), pj(0, length, 0)]
    mnu = min(p[0] for p in allp); mnv = min(p[1] for p in allp)
    mxu = max(p[0] for p in allp); mxv = max(p[1] for p in allp)
    s = S(int((mxu - mnu) * sc + 40), int((mxv - mnv) * sc + 40))
    T = lambda p: ((pj(*p)[0] - mnu) * sc + 20, (pj(*p)[1] - mnv) * sc + 20)
    s.poly([T((0, 0, 0)), T((span, 0, 0)), T((span, length, 0)), T((0, length, 0))], '#c9b79c', '#efe7da', 0.8)
    segs.sort(key=lambda g: -(g[0][0] + g[1][0]) + (g[0][1] + g[1][1]) * 0.01)
    for p, q, c, w in segs:
        (x1, y1), (x2, y2) = T(p), T(q)
        s.line(x1, y1, x2, y2, c, w)
    for xs, t in ((0, 'A'), (span, 'B')):
        x, y = T((xs, -1.2, 0)); s.text(x, y, t, 12, bold=True)
    return s.svg()

# ── payload: the model behind every drawing ───────────────────────────────
payload = {
    'schema': 'shorashim-plan/1',
    'kind': 'buildplan-shed',
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'project': {'id': pr['id'], 'name': pr['name'], 'client': pr['client'], 'type': pr['type'], 'maintId': pr.get('maintId')},
    'dims': d, 'boq': pr['boq'], 'notes': pr['notes'],
    'takeoff': [{'name': r['name'], 'qty': r['qty'], 'unit': r['unit']} for r in rows],
    'totals': {'sectionsKg': round(kg_sections), 'steelKg': round(kg_total), 'cost': P['tot']['cost']},
    'derived': {'trusses': frames, 'trussPanels': tPan, 'panelAlongSlope': round(tPL, 4), 'purlinRows': purlins,
                'columnFrames': [i + 1 for i in colF], 'levels': {'A_girder': [A_gBot, A_gTop], 'B_girder': [B_gBot, B_gTop],
                'truss_top_A': round(T_A_top, 3), 'truss_top_B': round(T_B_top, 3)}, 'slopePct': round(slope_pc, 2)},
}
canon = json.dumps({k: payload[k] for k in ('project', 'dims', 'boq', 'takeoff')}, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
payload['hash'] = hashlib.sha256(canon.encode('utf-8')).hexdigest()[:16]
DRAW_NO = 'SP-%d-%s' % (pr['id'], sys.argv[3] if len(sys.argv) > 3 else '01')
REV = payload['hash'][:6].upper()
TODAY = datetime.date.today().strftime('%d.%m.%Y')

# ── HTML ──────────────────────────────────────────────────────────────────
def tb(title, sheet, n):
    return '''<div class="tb">
  <div class="tb-l"><div class="brand">שורשים פלוס · מחלקת תחזוקה</div><div class="own">תוכנית עצמית לביצוע ולתמחור · אינה תוכנית מהנדס</div></div>
  <div class="tb-c"><div class="pt">%s · %s</div><div class="st">%s</div></div>
  <div class="tb-r"><table><tr><td>מס' תוכנית</td><td class="m">%s</td></tr><tr><td>גיליון</td><td class="m">%d / %d</td></tr>
  <tr><td>תאריך</td><td class="m">%s</td></tr><tr><td>גרסה</td><td class="m">%s</td></tr><tr><td>מידות</td><td>מטר, אלא אם צוין</td></tr></table></div>
</div>''' % (E(pr['name']), E(pr['client']), E(title), DRAW_NO, sheet, n, TODAY, REV)

N = 5
legend = '''<div class="leg"><span><i style="background:%s"></i>חגורות</span><span><i style="background:%s"></i>ניצבים ואלכסונים</span>
<span><i style="background:%s"></i>מרישים</span><span><i style="background:%s"></i>ייצוב (מוטות X, קשרי L)</span><span><i class="dot"></i>עמוד קיים</span></div>''' % (C_STEEL, C_WEB, C_PUR, C_BR)

def kv(rows_):
    return '<table class="kv">' + ''.join('<tr><td>%s</td><td>%s</td></tr>' % (E(a), b) for a, b in rows_) + '</table>'

summary = kv([
    ('מערכת', 'גג חד־שיפועי · %d אגדים שטוחים (פראט) על 2 קורות אורך מסבכיות' % frames),
    ('מידות', '<b class="m">%s × %s מ\'</b> · %d שדות × %s מ\'' % (f1(span), f1(length), bays, f2(bay))),
    ('שיפוע', '<b class="m">%.1f%%</b> (%s°) · עליה %s מ\'' % (slope_pc, f1(d['pitch']), f2(rise))),
    ('אגד T1', '<span class="m">%s × %s</span> מ\' · %d שדות × %.3f · עליון %s · תחתון %s · רשת %s' % (f2(raf), f1(tD), tPan, tPL, d['rafterProfile'], d['trussBotProfile'], d['trussWebProfile'])),
    ('קורת אורך A', 'בין העמודים <span class="m">%s – %s</span> · %s, רשת %s' % (lvl(A_gBot), lvl(A_gTop), d['girderProfile'], d['trussWebProfile'])),
    ('קורת אורך B', 'על ראשי העמודים <span class="m">%s – %s</span>' % (lvl(B_gBot), lvl(B_gTop))),
    ('עמודים', '%d קיימים <span class="m">%s</span> · צירים %s · ראש <span class="m">%s</span> · לא נכללים בכתב הכמויות' % (len(colF) * 2, d['colProfile'], ', '.join(axes[i] for i in colF), lvl(colTop))),
    ('מרישים', '%d שורות <span class="m">%s</span> על כל צומת עליון · מפתח %s מ\'' % (purlins, d['purlinProfile'], f2(bay))),
    ('קירוי', ' · '.join('%s × %s' % (f1(r['qty']), E(r['name'])) for r in rows if 'פח' in r['name'] and 'בורג' not in r['name']) or '—'),
    ('גובה גג', 'צד A <span class="m">%s</span> · צד B <span class="m">%s</span>' % (lvl(T_A_top), lvl(T_B_top))),
    ('משקל פלדה', '<b class="m">%.1f t</b> (פרופילים %.1f t + פלטות %.2f t + קשרים ומוטות %.2f t)' % (kg_total / 1000, kg_sections / 1000, kg_plates / 1000, kg_extra / 1000)),
])

checks_html = kv([(c[0] + ' · ' + c[1], '<span class="m">%.2f</span> · %s %s' % (c[2], E(c[3]), '✓' if c[2] <= 1 else '✗')) for c in P.get('checks', [])])

notes = [
    'כל המידות במטרים. מפלסים יחסית ל-±0.00 = פני קרקע ליד העמודים; יש לאמת מול מדידה בשטח.',
    'העמודים קיימים (%s). יש לבדוק את מצבם, אנכיותם ואת היסודות שלהם לפני ההרכבה.' % d['colProfile'],
    'פלדה S235, ריתוך מלא סביב. צביעה או גלוון לפי המפרט שיסוכם עם הלקוח.',
    'אגד T1: חגורות מקבילות בעומק %s מ\', %d שדות; ניצב בכל צומת ומריש על כל צומת עליון.' % (f1(tD), tPan),
    'ישיבת אגד על קורה B: מפלס תחתון מחושב %s מול ראש קורה %s; לפצות בפלטת ישיבה.' % (lvl(T_B_bot), lvl(B_gTop)) if abs(shim) > 0.004 else 'ישיבת אגד על קורות A/B בפלטת ישיבה מרותכת וברגים M16.',
    'חיבור קורה A לדופן העמודים (בין העמודים) מחייב פרט הנדסי לפני ייצור.',
    'ייצוב: מוטות X Ø16 עם מותחנים בשני השדות הקיצוניים בכל קצה, קשרי L 50x5 לאורך החגורות התחתונות.',
    'בדיקות החוזק בגיליון 5 הן בדיקת התאמה ראשונית של האפליקציה. הן אינן תכן הנדסי ואינן מחליפות מהנדס רשוי.',
]

def boq_table():
    trs = []
    for r in rows:
        trs.append('<tr><td>%s</td><td class="m n">%s</td><td>%s</td><td class="note">%s</td><td class="m n">%s</td><td class="m n">%s</td></tr>' % (
            E(r['name']), f1(r['qty']), E(r['unit']), E(r['note']), ('%d' % round(r['kg'])) if r['kg'] else '', '{:,.0f}'.format(r['qty'] * r['price'])))
    trs.append('<tr class="tot"><td colspan="4">סה"כ (מחירי קטלוג, לפני מע"מ ולפני רווח)</td><td class="m n">%d</td><td class="m n">%s</td></tr>' % (round(kg_sections), '{:,.0f}'.format(P['tot']['cost'])))
    return '<table class="boq"><thead><tr><th>פריט</th><th>כמות</th><th>יח\'</th><th>הערה</th><th>ק"ג</th><th>₪</th></tr></thead><tbody>%s</tbody></table>' % ''.join(trs)

css = '''
@page { size: A3 landscape; margin: 0; }
* { box-sizing: border-box; }
body { margin:0; font-family:'DejaVu Sans',Arial,sans-serif; color:#111; direction:rtl; }
.sheet { width:420mm; height:297mm; padding:9mm 10mm 0 10mm; position:relative; page-break-after:always; overflow:hidden; }
.frame { position:absolute; inset:6mm; border:1.2px solid #111; pointer-events:none; }
h2 { margin:0 0 3mm; font-size:15pt; } h3 { margin:0 0 2mm; font-size:11pt; color:#1f3a5f; }
.m { font-family:'DejaVu Sans Mono',monospace; direction:ltr; unicode-bidi:isolate; }
.body { height:243mm; display:flex; gap:6mm; }
.col { display:flex; flex-direction:column; gap:4mm; min-width:0; }
.box { border:1px solid #bbb; border-radius:2mm; padding:3mm; background:#fff; }
.tb { position:absolute; left:10mm; right:10mm; bottom:9mm; height:30mm; border:1.2px solid #111; display:flex; font-size:9pt; }
.tb > div { padding:2mm 3mm; }
.tb-l { width:95mm; border-left:1px solid #111; } .brand { font-weight:700; font-size:11pt; color:#1f3a5f; }
.own { margin-top:2mm; color:#b71c1c; font-weight:700; }
.tb-c { flex:1; border-left:1px solid #111; } .pt { font-size:14pt; font-weight:700; } .st { font-size:11pt; margin-top:1mm; }
.tb-r { width:85mm; } .tb-r table { width:100%; border-collapse:collapse; } .tb-r td { padding:0.4mm 1mm; } .tb-r td:first-child { color:#555; }
.kv { border-collapse:collapse; width:100%; font-size:9.3pt; } .kv td { padding:1.1mm 1.5mm; border-bottom:1px solid #e3e3e3; vertical-align:top; }
.kv td:first-child { color:#555; white-space:nowrap; width:30mm; }
.leg { display:flex; gap:5mm; font-size:8.5pt; flex-wrap:wrap; } .leg i { display:inline-block; width:9mm; height:2.2mm; margin-left:1.5mm; vertical-align:middle; }
.leg i.dot { width:3mm; height:3mm; border-radius:50%; background:#777; border:1px solid #000; }
ol { margin:0; padding-right:5mm; font-size:9pt; line-height:1.45; }
.boq { border-collapse:collapse; width:100%; font-size:8.6pt; } .boq th { background:#1f3a5f; color:#fff; padding:1.3mm; text-align:right; }
.boq td { padding:1mm 1.3mm; border-bottom:1px solid #ddd; } .boq .n { text-align:left; } .boq .note { color:#555; font-size:7.8pt; }
.boq tr.tot td { font-weight:700; border-top:1.5px solid #111; }
.box svg { max-height: var(--mh, 200mm); }
.cap { font-size:9pt; color:#333; margin-top:1mm; }
.data { font-size:8pt; color:#555; border:1px dashed #999; padding:2mm; border-radius:2mm; }
'''

def sheet(n, title, body):
    return '<div class="sheet"><div class="frame"></div><h2>%s</h2><div class="body">%s</div>%s</div>' % (E(title), body, tb(title, n, N))

pages = []
pages.append(sheet(1, 'כללי · מבט איזומטרי · נתונים',
    '<div class="col" style="flex:1.15"><div class="box">%s</div>%s</div>'
    '<div class="col" style="flex:1"><div class="box"><h3>נתוני המבנה</h3>%s</div>'
    '<div class="box"><h3>הערות כלליות</h3><ol>%s</ol></div>'
    '<div class="box"><h3>רשימת גיליונות</h3><ol><li>כללי · איזומטרי · נתונים</li><li>תוכנית גג ומערכת קונסטרוקציה</li><li>חתכי רוחב · צירי עמודים וצירי ביניים</li><li>חזיתות אורך · קורות A ו-B</li><li>פרט אגד T1 · כתב כמויות · בדיקות</li></ol></div></div>' % (
        iso(), legend, summary, ''.join('<li>%s</li>' % E(x) for x in notes))))
pages.append(sheet(2, 'תוכנית גג ומערכת קונסטרוקציה',
    '<div class="col" style="flex:1"><div class="box" style="--mh:196mm">%s</div>%s<div class="cap">אגדים בכל ציר (%d), עמודים קיימים בצירים %s בלבד. המרישים רצים לאורך המבנה על כל צומת עליון של האגדים. החץ מסמן את כיוון השיפוע מ-B (גבוה) ל-A (נמוך).</div></div>' % (
        roof_plan(), legend, frames, ', '.join(axes[i] for i in colF))))
pages.append(sheet(3, 'חתכי רוחב',
    '<div class="col" style="flex:1"><div class="box"><h3>חתך בציר עמודים (%s)</h3>%s</div></div>'
    '<div class="col" style="flex:1"><div class="box"><h3>חתך בציר ביניים (ללא עמוד)</h3>%s</div>%s'
    '<div class="cap">בצירי הביניים האגד נשען על קורות האורך בלבד. חיזוקי הפינה (סגול) רק בצירי העמודים: %d יח\' %s.</div></div>' % (
        ', '.join(axes[i] for i in colF), cross_section(True), cross_section(False), legend, len(colF) * 2, d['haunchProfile'])))
pages.append(sheet(4, 'חזיתות אורך · קורות A ו-B',
    '<div class="col" style="flex:1"><div class="box" style="--mh:98mm"><h3>קו A · צד נמוך · קורה בין העמודים</h3>%s</div>'
    '<div class="box" style="--mh:98mm"><h3>קו B · צד גבוה · קורה על ראשי העמודים</h3>%s</div>'
    '<div class="cap">קורות אורך מסבכיות בעומק %s מ\': %d שדות של %s מ\', ניצב בכל שדה, אלכסוני פראט מתהפכים באמצע כל מפתח בין עמודים.</div></div>' % (
        long_elev('A'), long_elev('B'), f1(gD), gPan, f2(gPL))))
pages.append(sheet(5, 'פרט אגד T1 · כתב כמויות · בדיקות',
    '<div class="col" style="flex:1.05"><div class="box"><h3>אגד T1 · %d יח\' · פרוש לאורך השיפוע</h3>%s<div class="cap">צמתים 0–%d. עליון %s · תחתון %s · ניצבים ואלכסונים %s. אורך ניצב %s מ\' · אלכסון %.3f מ\'.</div></div>'
    '<div class="box"><h3>בדיקות התאמה (האפליקציה)</h3>%s</div>'
    '<div class="data">בקובץ הזה מוטמע נתוני המודל (shorashim-plan.json · גרסה %s). כשמעלים אותו לפרויקט באפליקציה, הנתונים נקראים מהקובץ עצמו, בלי קריאת AI ובלי עלות, ומושווים לפרויקט ולכתב הכמויות בתחזוקה.</div></div>'
    '<div class="col" style="flex:1.25"><div class="box"><h3>כתב כמויות (מהאפליקציה, כולל %d%% פחת)</h3>%s</div></div>' % (
        frames, truss_detail(), tPan, d['rafterProfile'], d['trussBotProfile'], d['trussWebProfile'], f2(tD), math.hypot(tPL, tD),
        checks_html, REV, d['waste'], boq_table())))

doc = '<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>%s</title><style>%s</style></head><body>%s</body></html>' % (
    E(pr['name']), css, ''.join(pages))
os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'plan.html'), 'w', encoding='utf-8').write(doc)
json.dump(payload, open(os.path.join(out, 'shorashim-plan.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('ok', REV, 'kg', round(kg_total), 'cost', round(cost_total), 'shim', round(shim, 3))
