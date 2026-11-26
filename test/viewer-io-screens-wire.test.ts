import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import type { NavEntry, NavPart, NavWireframe, WireRef } from '../src/types';

// W11 (b307): viewer/ioScreens.js draws a screen from its measured wireframe boxes (band.wire, set by ioView.layout). The module runs alone
// in a vm (no DOM: boxes go in, rects come out, C6); S.measure(band) gets a hand-built band, S.draw(dc, band) a fake dc that logs each
// fill / stroke / text with the colour token, the line dash and the rect of its path.

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'viewer', 'ioScreens.js'), 'utf8');
function load(): any {
  const win: any = {};
  vm.runInNewContext(SRC, { window: win });
  return win.C4PM_IO_SCREENS;
}

const part = (fqn: string, kind: string, parts: NavPart[] = []): NavPart => ({ fqn, uid: null, kind, title: fqn.split('.').pop()!, status: null, parts });
const screen = (fqn: string, rank: number, parts: NavPart[], wireframe?: NavWireframe): NavEntry =>
  ({ kind: 'screen', fqn, uid: null, title: fqn, status: null, rank, order: 0, parent: null, parts, ...(wireframe ? { wireframe } : {}) });
const ref = (r: string, fqn: string | null, problem?: 'unknown' | 'ambiguous'): WireRef => ({ ref: r, fqn, ...(problem ? { problem } : {}) });

// s.home: a top bar (logo, search, a menu shown only sometimes), the HUD on two corners (one ref, two elements), a state ref, an unknown ref
const HOME = screen('s.home', 0, [
  part('s.home.top', 'region', [part('s.home.top.logo', 'control'), part('s.home.top.menu', 'control')]),
  part('s.home.hud', 'control', [part('s.home.hud.busy', 'state')]),
  part('s.home.body', 'region'),
  part('s.home.err', 'state'),
], {
  file: 'io/s.home.html', html: '<div></div>', missing: ['s.home.body'],
  refs: [ref('top', 's.home.top'), ref('logo', 's.home.top.logo'), ref('menu', 's.home.top.menu'), ref('hud', 's.home.hud'), ref('busy', 's.home.hud.busy'), ref('gone', null, 'unknown')],
});
const BOXES = [
  { ref: 'menu', x: 1000, y: 60, w: 200, h: 300, hidden: true, order: 0 },   // first in the document, but hidden: drawn last
  { ref: 'top', x: 0, y: 0, w: 1280, h: 60, hidden: false, order: 1 },
  { ref: 'logo', x: 20, y: 10, w: 120, h: 40, hidden: false, order: 2 },
  { ref: 'hud', x: 20, y: 700, w: 100, h: 80, hidden: false, order: 3 },
  { ref: 'hud', x: 1160, y: 700, w: 100, h: 80, hidden: false, order: 4 },
  { ref: 'busy', x: 30, y: 710, w: 10, h: 10, hidden: false, order: 5 },
  { ref: 'gone', x: 600, y: 400, w: 80, h: 40, hidden: false, order: 6 },
];
const OK = { ok: true, viewport: { w: 1280, h: 800 }, boxes: BOXES };
// a screen with no wireframe (strips), with the usual shape: two regions, controls, a control state and a screen state
const PLAIN = screen('s.plain', 1, [
  part('s.plain.a', 'region', [part('s.plain.a.x', 'control', [part('s.plain.a.x.st', 'state')]), part('s.plain.a.y', 'control')]),
  part('s.plain.b', 'region', [part('s.plain.b.z', 'control')]),
  part('s.plain.err', 'state'),
]);

function band(entries: NavEntry[], wire: Record<string, unknown> = {}, mark: Record<string, string> = {}): any {
  return { family: 'screen', group: { fqn: 's', title: 'S', technology: null, word: 'App', entries }, entries, io: {}, edges: [], word: 'App', w: 0, h: 0, local: {}, x: 0, y: 0, wire, mark };
}

const C: any = { method: {} };
['ink', 'muted', 'line', 'panel', 'panel2', 'accent', 'edge', 'screen', 'screenSoft', 'screenLine', 'control', 'findings'].forEach(k => { C[k] = k; });
interface Op { op: string; style: string; dash: string; alpha: number; rect: { x: number; y: number; w: number; h: number } | null }
interface Pt { x: number; y: number }
interface Curve { P: Pt[]; style: string }   // W14: one path: its moveTo start + the points of its bezierCurveTo calls (kept out of ops: the digests stay)
function makeDc(s = 1) {
  const ops: Op[] = [], texts: string[] = [], curves: Curve[] = [], labels: string[] = [], textAt: Array<{ t: string; x: number; y: number }> = [];
  let last: Op['rect'] = null, dash: number[] = [], at: Pt = { x: 0, y: 0 }, cur: Curve | null = null;
  const t: any = { globalAlpha: 1 };
  const ctx = new Proxy(t, {
    get: (_o, k: string) => {
      if (k === 'moveTo') return (x: number, y: number) => { at = { x, y }; cur = null; };
      if (k === 'bezierCurveTo') return (...a: number[]) => {
        if (!cur) curves.push(cur = { P: [at], style: String(t.strokeStyle) });
        cur.P.push({ x: a[0], y: a[1] }, { x: a[2], y: a[3] }, { x: a[4], y: a[5] });
      };
      if (k === 'measureText') return (q: string) => ({ width: String(q).length * 6 });
      if (k === 'fillText') return (q: string, x: number, y: number) => { texts.push(String(q)); textAt.push({ t: String(q), x, y }); ops.push({ op: 'text:' + q, style: String(t.fillStyle), dash: dash.join(','), alpha: t.globalAlpha, rect: null }); };
      if (k === 'setLineDash') return (d: number[]) => { dash = d.slice(); };
      if (k === 'fill' || k === 'stroke') return () => ops.push({ op: k, style: String(t[k === 'fill' ? 'fillStyle' : 'strokeStyle']), dash: dash.join(','), alpha: t.globalAlpha, rect: last });
      if (k in t) return t[k];
      return () => undefined;
    },
    set: (_o, k: string, v) => { t[k] = v; return true; },
  });
  const dc: any = {
    ctx, C, cam: { s, tx: 0, ty: 0 }, cw: 5000, ch: 5000, now: 0, sel: null, hi: null, font: 'sans', status: {},
    glow: { out: 'out', in: 'in', hi: 'hi', arrow: 8 },
    rr: (x: number, y: number, w: number, h: number) => { last = { x, y, w, h }; },
    toPx: (r: any) => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s }),
    offScreen: () => false, word: (k: string) => k, tag: (k: string) => k, fit: (q: string) => String(q),
    rows: () => undefined, kindOf: () => null, statusOf: () => null, dash: () => [],
    entryBegin: () => undefined, entryEnd: () => undefined, hits: [] as Array<{ id: string; R: any }>, labels: [], label: (o: { text: string }) => { labels.push(o.text); },
  };
  return { dc, ops, texts, curves, labels, textAt };
}
const near = (a: any, b: any) => ['x', 'y', 'w', 'h'].forEach(k => expect(a[k]).toBeCloseTo(b[k], 9));

describe('a screen drawn from its wireframe boxes', () => {
  const S = load();
  const b = band([HOME, PLAIN], { 's.home': OK });
  S.measure(b);
  const F = b.local['s.home'];

  it('exports the scale and the title row height', () => {
    expect(S.WORLD_PER_PX).toBe(0.25);
    expect(S.TB).toBe(24);
  });

  it('frame = viewport x WORLD_PER_PX under the title row (+ the states strip, the screen has a state)', () => {
    expect(F.w).toBe(1280 * S.WORLD_PER_PX);
    expect(F.h).toBe(S.TB + 800 * S.WORLD_PER_PX + 18);
  });

  it('a box sits at frame origin + (0, TB) + box x WORLD_PER_PX', () => {
    near(b.local['s.home.top.logo'], { x: F.x + 20 * 0.25, y: F.y + 24 + 10 * 0.25, w: 30, h: 10 });
    near(b.local['s.home.top'], { x: F.x, y: F.y + 24, w: 320, h: 15 });
  });

  it('one ref on two elements: two boxes, one union rect', () => {
    expect(b.boxes['s.home.hud']).toHaveLength(2);
    near(b.local['s.home.hud'], { x: F.x + 5, y: F.y + 24 + 175, w: (1260 - 20) * 0.25, h: 20 });
  });

  it('a state ref and an unknown ref get no rect; a part with no box gets none from the module', () => {
    expect(b.local['s.home.hud.busy']).toBeUndefined();
    expect(b.local['s.home.body']).toBeUndefined();
    expect(Object.keys(b.boxes).sort()).toEqual(['s.home.hud', 's.home.top', 's.home.top.logo', 's.home.top.menu']);
    expect(b.boxes['s.home.top.menu'][0].hidden).toBe(true);
  });

  describe('draw', () => {
    const { dc, ops, texts } = makeDc(1);
    S.draw(dc, b);
    const strokeAt = (id: string, i = 0) => {
      const R = b.boxes[id][i];
      return ops.findIndex(o => o.op === 'stroke' && o.rect && Math.abs(o.rect.x - (b.x + R.x)) < 1e-9 && Math.abs(o.rect.y - (b.y + R.y)) < 1e-9 && Math.abs(o.rect.w - R.w) < 1e-9);
    };

    it('every box of a part is a hit: the HUD twice, the state and the unknown ref never', () => {
      const ids = dc.hits.map((h: any) => h.id);
      expect(ids.filter((i: string) => i === 's.home.hud')).toHaveLength(2);
      expect(ids).not.toContain('s.home.hud.busy');
      expect(ids.filter((i: string) => i === 's.home.top.menu')).toHaveLength(1);
    });

    it('shown before hidden, regions before controls: top, then logo and the HUD, the hidden menu last (dashed, faint fill)', () => {
      const top = strokeAt('s.home.top'), logo = strokeAt('s.home.top.logo'), hud = strokeAt('s.home.hud', 1), menu = strokeAt('s.home.top.menu');
      expect([top, logo, hud, menu].every(i => i >= 0)).toBe(true);
      expect(top).toBeLessThan(logo);
      expect(logo).toBeLessThan(hud);
      expect(hud).toBeLessThan(menu);
      expect(ops[menu].dash).toBe('4,3');
      expect(ops[logo].dash).toBe('');
      expect(ops[menu - 1]).toMatchObject({ op: 'fill', style: 'panel' });
      expect(ops[menu - 1].alpha).toBeLessThan(ops[menu].alpha);
    });

    it('an unknown ref draws a findings outline and "? <ref>"', () => {
      expect(texts).toContain('? gone');
      expect(ops.find(o => o.op === 'text:? gone')!.style).toBe('findings');
      expect(ops.some(o => o.op === 'stroke' && o.style === 'findings')).toBe(true);
    });

    it('the title row shows the viewport size; colours are only dc.C tokens', () => {
      expect(texts).toContain('1280 x 800');
      const tokens = new Set(Object.keys(C).filter(k => k !== 'method'));
      ops.forEach(o => expect(tokens.has(o.style)).toBe(true));
    });
  });
});

// b606: on a wireframe a region's name never covers a box. thin: its control 10 px under its top, at the title row: no name (until zoomed
// far in, then inside); mid: free room above it: the name sits just above its top edge; tall: 100 px above its control: inside.
describe('b606: region names on a wireframe never cover a box', () => {
  const NAMES = screen('n.s', 0, [
    part('n.s.thin', 'region', [part('n.s.thin.c', 'control')]), part('n.s.mid', 'region', [part('n.s.mid.c', 'control')]),
    part('n.s.tall', 'region', [part('n.s.tall.c', 'control')]),
  ], { file: 'io/n.s.html', html: '<div></div>', missing: [], refs: ['thin', 'mid', 'tall'].flatMap(r => [ref(r, 'n.s.' + r), ref(r + '_c', 'n.s.' + r + '.c')]) });
  const NAME_OK = { ok: true, viewport: { w: 1280, h: 800 }, boxes: [
    { ref: 'thin', x: 0, y: 0, w: 1280, h: 60, hidden: false, order: 0 }, { ref: 'thin_c', x: 20, y: 10, w: 200, h: 40, hidden: false, order: 1 },
    { ref: 'mid', x: 0, y: 200, w: 1280, h: 200, hidden: false, order: 2 }, { ref: 'mid_c', x: 20, y: 210, w: 200, h: 40, hidden: false, order: 3 },
    { ref: 'tall', x: 0, y: 500, w: 1280, h: 200, hidden: false, order: 4 }, { ref: 'tall_c', x: 20, y: 600, w: 200, h: 40, hidden: false, order: 5 },
  ] };
  function names(s: number) {
    const S = load(), b = band([NAMES], { 'n.s': NAME_OK });
    S.measure(b);
    const { dc, textAt } = makeDc(s);
    S.draw(dc, b);
    const top = (id: string) => (b.y + b.local[id].y) * s;
    return { at: (t: string) => textAt.filter(q => q.t === t).map(q => q.y), top };
  }
  it('at zoom 1: thin has no name, mid has it just above its top edge, tall inside above its control', () => {
    const { at, top } = names(1), row = 8 + 2;
    expect(at('thin')).toEqual([]);
    expect(at('mid')).toEqual([top('n.s.mid') - row / 2]);
    expect(at('tall')).toEqual([top('n.s.tall') + row / 2]);
    expect(top('n.s.tall') + row).toBeLessThanOrEqual(top('n.s.tall.c'));
  });
  it('zoomed in far enough, the thin region gets its name inside, above its control', () => {
    const { at, top } = names(8), row = 12 + 2;
    expect(at('thin')).toEqual([top('n.s.thin') + row / 2]);
    expect(top('n.s.thin') + row).toBeLessThanOrEqual(top('n.s.thin.c'));
  });
});

// Today's strips: the numbers below were taken from ioScreens.js before W11 (commit f9fe3db), so a change of the strips shows here.
const TODAY_LOCAL: Record<string, number[]> = {
  's.plain': [0, 60, 320, 240], 's.plain.a': [10.5, 90.5, 299, 90], 's.plain.a.x': [15, 104, 143.5, 21], 's.plain.a.y': [161.5, 104, 143.5, 21],
  's.plain.b': [10.5, 185.5, 299, 90], 's.plain.b.z': [15, 199, 290, 21],
};
const TODAY_DRAW: Record<string, string> = {
  '0.5': '996ee0ce79ff8d74311cb8b5cf7f37e4822d0d60', '1.5': 'e59105767dd8a17f1043f2752cb2fb9a503cee42', '3': '000df5380de7100662e9a5f9cefc08ff65b614e7',
};   // sha1 of the logged ops, by zoom (levels 1, 2, 3)
const digest = (ops: Op[]) => crypto.createHash('sha1').update(JSON.stringify(ops)).digest('hex');
const localOf = (b: any) => Object.fromEntries(Object.keys(b.local).sort().map(k => [k, ['x', 'y', 'w', 'h'].map(q => b.local[k][q])]));

describe('screens without a drawn wireframe keep the strips', () => {
  it.each(Object.keys(TODAY_DRAW))('a screen without a wireframe: today\'s rects and today\'s drawing at zoom %s, exactly', z => {
    const S = load(), b = band([PLAIN]);
    S.measure(b);
    expect(localOf(b)).toEqual(TODAY_LOCAL);
    const { dc, ops } = makeDc(Number(z));
    S.draw(dc, b);
    expect(digest(ops)).toBe(TODAY_DRAW[z]);
  });

  it('an ok:false result: today\'s rects exactly (the wireframe is not drawn), and the badge says so', () => {
    const S = load(), b = band([PLAIN], { 's.plain': { ok: false, reason: 'no layout engine: DOMParser is missing', reasons: ['no layout engine: DOMParser is missing'] } }, { 's.plain': 'not-drawn' });
    S.measure(b);
    expect(localOf(b)).toEqual(TODAY_LOCAL);
    expect(b.boxes).toEqual({});
    const { dc, texts } = makeDc(1.5);
    S.draw(dc, b);
    expect(texts).toContain('wireframe not drawn');
  });

  it('next to a wireframed screen, the plain one keeps its shape; its badge comes from band.mark only', () => {
    const S = load(), b = band([HOME, PLAIN], { 's.home': OK }, { 's.plain': 'none', 's.home': 'out-of-date' });
    S.measure(b);
    const P = b.local['s.plain'];
    const rel = (id: string) => { const r = b.local[id]; return [r.x - P.x, r.y - P.y, r.w, r.h]; };
    const T = TODAY_LOCAL['s.plain'];
    expect([P.w, P.h]).toEqual([T[2], T[3]]);
    Object.keys(TODAY_LOCAL).filter(k => k !== 's.plain').forEach(k => expect(rel(k)).toEqual([TODAY_LOCAL[k][0] - T[0], TODAY_LOCAL[k][1] - T[1], TODAY_LOCAL[k][2], TODAY_LOCAL[k][3]]));
    const { dc, texts } = makeDc(1.5);
    S.draw(dc, b);
    expect(texts).toContain('no wireframe');
    expect(texts).toContain('wireframe out of date');
  });

  it('b607: when the badge text does not fit, its short mark shows: in the title row, and next to the title written above a small frame', () => {
    const LONG = screen('s.a_screen_with_a_long_name_x', 1, PLAIN.parts);   // the title is the fqn: 28 chars = 168 px with the fake measure
    const draw = (s: number, mark: string) => { const S = load(), b = band([LONG], {}, { [LONG.fqn]: mark }); S.measure(b); const d = makeDc(s); S.draw(d.dc, b); return d.texts; };
    expect(draw(1.5, 'none')).toContain('no wireframe');
    expect(draw(0.7, 'none')).toContain('∅');           // title row 16.8 px: the full text has no room right of the title
    expect(draw(0.7, 'none')).not.toContain('no wireframe');
    expect(draw(0.3, 'not-drawn')).toContain('!');      // title row 7.2 px: the title is written above the frame, the mark next to it
    expect(draw(0.3, 'not-drawn')).not.toContain('wireframe not drawn');
  });
});

// W14 (b310, K4 / D5): screens in navigation columns (entry.column) and one arrow per (via, target) from the via's box. The band has the
// shape of C4PM's own: map_page (column 0, drawn from its wireframe) -> io_view / own_window (column 1) by its view button; io_view back to
// map_page and on to own_window (same column) by its own view button.
describe('navigation columns and arrows from the via box', () => {
  const col = (e: NavEntry, column: number): NavEntry => ({ ...e, column });
  const MAP = col(screen('c.map_page', 0, [part('c.map_page.top_bar', 'region', [part('c.map_page.top_bar.view_btn', 'control')])], {
    file: 'io/c.map_page.html', html: '<div></div>', missing: [], refs: [ref('top_bar', 'c.map_page.top_bar'), ref('view_btn', 'c.map_page.top_bar.view_btn')],
  }), 0);
  const MAP_OK = { ok: true, viewport: { w: 1280, h: 800 }, boxes: [
    { ref: 'top_bar', x: 0, y: 0, w: 1280, h: 60, hidden: false, order: 0 }, { ref: 'view_btn', x: 1000, y: 10, w: 160, h: 40, hidden: false, order: 1 }] };
  const IO = col(screen('c.io_view', 0, [part('c.io_view.top_bar', 'region', [part('c.io_view.top_bar.view_btn', 'control'), part('c.io_view.top_bar.help', 'control')])]), 1);
  const OWN = col(screen('c.own_window', 0, [part('c.own_window.body', 'region', [part('c.own_window.body.x', 'control')])]), 1);
  const edge = (from: string, to: string, via: string | null, label: string | null = null) => ({ from, to, via, label, ...(label ? { labelled: true } : {}) });
  const EDGES = [
    edge('c.map_page', 'c.io_view', 'c.map_page.top_bar.view_btn', 'IO view'), edge('c.map_page', 'c.own_window', 'c.map_page.top_bar.view_btn', 'own window'),
    edge('c.io_view', 'c.map_page', 'c.io_view.top_bar.view_btn', 'Architecture view'), edge('c.io_view', 'c.own_window', 'c.io_view.top_bar.view_btn', 'own window'),
  ];
  function setup(edges: unknown[], sel: string | null = null) {
    const S = load(), b = band([MAP, IO, OWN], { 'c.map_page': MAP_OK });
    b.edges = edges;
    S.measure(b);
    const d = makeDc(1);
    d.dc.sel = sel;
    d.dc.kindOf = (id: string) => (/view_btn|help/.test(id) ? 'control' : null);
    S.draw(d.dc, b);
    return { b, ...d };
  }
  const right = (r: any): Pt => ({ x: r.x + r.w, y: r.y + r.h / 2 });
  const left = (r: any): Pt => ({ x: r.x, y: r.y + r.h / 2 });
  const backIn = (r: any): Pt => ({ x: r.x + r.w, y: r.y + r.h * 0.75 });   // a back arrow comes from below: the lower part of the right edge
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const end = (c: Curve) => c.P[c.P.length - 1];
  const curveTo = (curves: Curve[], p: Pt) => curves.filter(c => same(end(c).x, p.x) && same(end(c).y, p.y));
  // every point of a path of cubic segments (21 per segment)
  const points = (c: Curve): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i + 3 < c.P.length; i += 3) for (let j = 0; j <= 20; j++) {
      const t = j / 20, u = 1 - t, k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t], Q = c.P.slice(i, i + 4);
      out.push({ x: k.reduce((a, w, n) => a + w * Q[n].x, 0), y: k.reduce((a, w, n) => a + w * Q[n].y, 0) });
    }
    return out;
  };
  const nearPt = (a: Pt, b: Pt) => { expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9); };

  const { b, curves, labels } = setup(EDGES);
  const L = b.local;

  it('screens stand in columns by entry.column: map_page alone left, io_view above own_window right of it', () => {
    expect(L['c.io_view'].x).toBeGreaterThan(L['c.map_page'].x + L['c.map_page'].w);
    expect(L['c.own_window'].x).toBe(L['c.io_view'].x);
    expect(L['c.own_window'].y).toBeGreaterThan(L['c.io_view'].y + L['c.io_view'].h);
    expect([b.cols['c.map_page'], b.cols['c.io_view'], b.cols['c.own_window']]).toEqual([0, 1, 1]);
  });

  it('b607: the arrow from map_page.view_btn leaves map_page by its nearest edge (the top) before it turns, and enters io_view at its left edge (edge colour)', () => {
    const [c] = curveTo(curves, left(L['c.io_view'])), V = L['c.map_page.top_bar.view_btn'], M = L['c.map_page'];
    nearPt(c.P[0], { x: V.x + V.w / 2, y: V.y });   // view_btn: 26.5 below the top edge, 30 left of the right edge
    expect(c.style).toBe('edge');
    // inside map_page only on the straight way up from the via; everything after is above it or right of it
    const P = points(c), inside = (q: Pt) => q.x > M.x + 1e-6 && q.x < M.x + M.w - 1e-6 && q.y > M.y + 1e-6 && q.y < M.y + M.h - 1e-6;
    P.filter(inside).forEach(q => { expect(q.x).toBeCloseTo(c.P[0].x, 6); expect(q.y).toBeLessThanOrEqual(V.y + 1e-6); });
    expect(Math.min(...P.map(q => q.y))).toBeLessThan(M.y);
  });

  it('b607: the exit edge is the nearest free one: right when it is nearer, never the top when a frame stands above in the column', () => {
    const S = load(), F = { x: 0, y: 300, w: 320, h: 224, col: 0 }, T = { x: 430, y: 300, w: 320, h: 224, col: 1 }, UP = { x: 0, y: 0, w: 320, h: 210, col: 0 };
    const nearTop = { x: 200, y: 330, w: 40, h: 10 }, nearRight = { x: 290, y: 400, w: 20, h: 10 };
    const start = (v: any, frames: any[]) => S.geom(F, T, v, frames)[0];
    nearPt(start(nearTop, [F, T]), { x: 220, y: 330 });        // top: 30, right: 80
    nearPt(start(nearRight, [F, T]), { x: 310, y: 405 });      // right: 10
    nearPt(start(nearTop, [UP, F, T]), { x: 240, y: 335 });    // a frame above: the right edge
    // a screen -> screen arrow (no via) and a back arrow keep their start at the right edge
    nearPt(start(null, [F, T]), right(F));
    nearPt(S.geom(T, F, nearTop, [F, T])[0], right(nearTop));
  });

  it('a back arrow (io_view -> map_page) enters the right edge in C.muted, going below', () => {
    const [c] = curveTo(curves, backIn(L['c.map_page']));
    nearPt(c.P[0], right(L['c.io_view.top_bar.view_btn']));
    expect(c.style).toBe('muted');
    expect(Math.max(...c.P.map(p => p.y))).toBeGreaterThan(Math.max(L['c.io_view'].y + L['c.io_view'].h, L['c.map_page'].y + L['c.map_page'].h));
  });

  it('b606: the back arrow goes around own_window (under io_view in its column): below it, never through it; it enters map_page from the right', () => {
    const [c] = curveTo(curves, backIn(L['c.map_page'])), P = points(c), O = L['c.own_window'], M = L['c.map_page'];
    const inside = (q: Pt, f: any) => q.x > f.x + 1e-6 && q.x < f.x + f.w - 1e-6 && q.y > f.y + 1e-6 && q.y < f.y + f.h - 1e-6;
    P.forEach(q => { expect(inside(q, O)).toBe(false); expect(inside(q, M)).toBe(false); });
    expect(Math.max(...P.map(q => q.y))).toBeGreaterThan(O.y + O.h);
    const E = end(c), E1 = c.P[c.P.length - 2];
    expect(E1.x).toBeGreaterThan(E.x);   // the arrowhead points left, into the right edge
    expect(E1.y).toBeCloseTo(E.y, 9);
  });

  it('a same-column arrow (io_view -> own_window) leaves to the right and enters the right edge', () => {
    const start = right(L['c.io_view.top_bar.view_btn']);
    const c = curveTo(curves, right(L['c.own_window'])).find(q => same(q.P[0].x, start.x))!;
    nearPt(c.P[0], start);
    expect(Math.min(c.P[1].x, c.P[2].x)).toBeGreaterThan(L['c.own_window'].x + L['c.own_window'].w);
    expect(c.style).toBe('edge');
  });

  it("one arrow per (via, target); each label is the via's own (no joining)", () => {
    expect(curves).toHaveLength(4);
    expect(labels.sort()).toEqual(['Architecture view', 'IO view', 'own window', 'own window']);
  });

  it('every curve stays inside the band (room for the arcs above, below and to the right)', () => {
    curves.forEach(c => points(c).forEach(q => expect(q.x >= 0 && q.x <= b.w && q.y >= 0 && q.y <= b.h).toBe(true)));
  });

  it('two vias to one target give two arrows, each from its own box; a screen -> screen edge starts at the frame', () => {
    const r = setup([
      edge('c.io_view', 'c.map_page', 'c.io_view.top_bar.view_btn', 'a'), edge('c.io_view', 'c.map_page', 'c.io_view.top_bar.help', 'b'),
      edge('c.map_page', 'c.own_window', null),
    ]);
    const into = curveTo(r.curves, backIn(r.b.local['c.map_page']));
    expect(into).toHaveLength(2);
    expect(into.map(c => c.P[0].x).sort()).toEqual([right(r.b.local['c.io_view.top_bar.view_btn']).x, right(r.b.local['c.io_view.top_bar.help']).x].sort());
    expect(r.labels.sort()).toEqual(['a', 'b']);
    const [s] = curveTo(r.curves, left(r.b.local['c.own_window']));
    nearPt(s.P[0], right(r.b.local['c.map_page']));
  });

  it('a selected control glows only its own arrows', () => {
    const r = setup([
      edge('c.io_view', 'c.map_page', 'c.io_view.top_bar.view_btn'), edge('c.io_view', 'c.map_page', 'c.io_view.top_bar.help'),
      edge('c.io_view', 'c.own_window', 'c.io_view.top_bar.view_btn'),
    ], 'c.io_view.top_bar.view_btn');
    const startOf = (c: Curve) => (same(c.P[0].x, right(r.b.local['c.io_view.top_bar.view_btn']).x) ? 'view_btn' : 'help');
    expect(r.curves.map(c => [startOf(c), c.style]).sort()).toEqual([['help', 'muted'], ['view_btn', 'out'], ['view_btn', 'out']]);
  });

  it('an entry without column (an older page) stands by rank', () => {
    const S = load(), { column: _m, ...m } = MAP, { column: _i, ...i } = IO;
    const bb = band([{ ...m, rank: 1 }, { ...i, rank: 0 }], { 'c.map_page': MAP_OK });
    S.measure(bb);
    expect([bb.cols['c.io_view'], bb.cols['c.map_page']]).toEqual([0, 1]);
  });
});
