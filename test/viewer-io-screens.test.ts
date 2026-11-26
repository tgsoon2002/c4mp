import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import { buildNavView } from '../src/view/navLayout';
import type { NavEntry, NavPart } from '../src/types';

// IO view, screens band (viewer/ioScreens.js): layout only. The harness measureText is fake, so nothing here may depend on text size.

const part = (fqn: string, kind: string, parts: NavPart[] = []): NavPart => ({ fqn, uid: null, kind, title: fqn.split('.').pop()!, status: null, parts, });
const ctl = (fqn: string, n = 0) => part(fqn, 'control', Array.from({ length: n }, (_, i) => part(`${fqn}.st${i}`, 'state')));
// a screen with `regions` regions of `ctls` controls each (+ one screen state)
function screen(fqn: string, rank: number, order: number, regions: number, ctls: number, status: string | null = null): NavEntry {
  const parts = Array.from({ length: regions }, (_, r) => part(`${fqn}.r${r}`, 'region', Array.from({ length: ctls }, (_, c) => ctl(`${fqn}.r${r}.c${c}`, c === 0 ? 1 : 0))));
  parts.push(part(`${fqn}.err`, 'state'));
  return { kind: 'screen', fqn, uid: null, title: fqn, status, rank, order, parent: null, parts };
}
const ENTRIES = [
  screen('a.login', 0, 0, 3, 2), screen('a.home', 1, 0, 4, 3), screen('a.list', 1, 1, 2, 1),
  screen('a.map', 2, 0, 14, 3),   // 14 regions / 42 controls: the frame must grow
  screen('a.later', 3, 0, 1, 1, 'planned'),
];

function load() {
  const m = loadSample();
  m.nav!.groups = [{ fqn: 'a', title: 'App', technology: 'React', word: 'App', entries: ENTRIES }];
  m.nav!.edges = [
    { from: 'a.login', to: 'a.home', label: 'go', labelled: true, via: 'a.login.r0.c0' },
    { from: 'a.home', to: 'a.map', label: 'map', labelled: true, via: 'a.home.r0.c0' },
    { from: 'a.map', to: 'a.login', label: 'out', labelled: true, via: 'a.map.r0.c0' },
  ];
  const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
  const V = (h.sandbox.window as any).C4PM_IOVIEW;
  return { V, S: (h.sandbox.window as any).C4PM_IO_SCREENS, rect: (id: string) => V.rect(id) as { x: number; y: number; w: number; h: number } };
}
const inside = (a: any, o: any) => a.x >= o.x - 1e-6 && a.y >= o.y - 1e-6 && a.x + a.w <= o.x + o.w + 1e-6 && a.y + a.h <= o.y + o.h + 1e-6;
const overlap = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const allParts = (p: NavPart): NavPart[] => [p, ...p.parts.flatMap(allParts)];

describe('screens band layout', () => {
  const { rect } = load();

  it('every region and control of every screen has a rect inside its screen', () => {
    ENTRIES.forEach(e => {
      const S = rect(e.fqn);
      expect(S).toBeTruthy();
      e.parts.flatMap(allParts).filter(p => p.kind === 'region' || p.kind === 'control').forEach(p => {
        const r = rect(p.fqn);
        expect(r).toBeTruthy();
        expect(inside(r, S)).toBe(true);
      });
    });
  });

  it('regions of a screen do not overlap and every control sits inside its region', () => {
    ENTRIES.forEach(e => {
      const regs = e.parts.filter(p => p.kind === 'region');
      regs.forEach((a, i) => {
        regs.slice(i + 1).forEach(b => expect(overlap(rect(a.fqn), rect(b.fqn))).toBe(false));
        a.parts.forEach(c => expect(inside(rect(c.fqn), rect(a.fqn))).toBe(true));
      });
    });
  });

  it('screens of rank r + 1 are right of rank r', () => {
    ENTRIES.forEach(a => ENTRIES.filter(b => b.rank === a.rank + 1).forEach(b => expect(rect(b.fqn).x).toBeGreaterThanOrEqual(rect(a.fqn).x + rect(a.fqn).w)));
  });

  it('screens do not overlap', () => {
    ENTRIES.forEach((a, i) => ENTRIES.slice(i + 1).forEach(b => expect(overlap(rect(a.fqn), rect(b.fqn))).toBe(false)));
  });

  it('a screen with many regions grows in height and holds all of them; a small one keeps the device height', () => {
    expect(rect('a.map').h).toBeGreaterThan(240);
    expect(rect('a.map').w).toBe(320);
    expect(rect('a.login').h).toBe(240);
    ENTRIES[3].parts.filter(p => p.kind === 'region').forEach(r => expect(inside(rect(r.fqn), rect('a.map'))).toBe(true));
  });

  it('the controls of a grown screen keep the full control height (no squeezed rows)', () => {
    ENTRIES[3].parts.filter(p => p.kind === 'region').forEach(r => r.parts.forEach(c => expect(rect(c.fqn).h).toBeGreaterThanOrEqual(24 - 3 - 1e-6)));
  });
});

describe('b607: in an app with commands, the screens get their own full-width row above the other bands', () => {
  const cmd = (fqn: string, order: number): NavEntry => ({ kind: 'command', fqn, uid: null, title: fqn, status: null, rank: 0, order, parent: null,
    parts: [part(`${fqn}.f0`, 'flag'), part(`${fqn}.f1`, 'flag')] });
  function loadMixed(nCmd: number) {
    const m = loadSample();
    const S3 = [screen('a.login', 0, 0, 3, 2), screen('a.home', 1, 0, 4, 3), screen('a.list', 1, 1, 2, 1)];
    m.nav!.groups = [{ fqn: 'a', title: 'App', technology: 'React', word: 'App', entries: [...S3, ...Array.from({ length: nCmd }, (_, i) => cmd(`a.c${i}`, i))] }];
    m.nav!.edges = [{ from: 'a.login', to: 'a.home', label: 'go', labelled: true, via: 'a.login.r0.c0' }];
    m.navView = buildNavView(m.nav!);
    const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
    const V = (h.sandbox.window as any).C4PM_IOVIEW;
    return { S3, V, rect: (id: string) => V.rect(id) as { x: number; y: number; w: number; h: number } };
  }
  const span = (rs: Array<{ x: number; y: number; w: number; h: number }>) => {
    const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
    return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
  };

  it('with many commands the screens are scaled up (same factor for every screen and part) and stand above every command', () => {
    const { S3, rect } = loadMixed(40);
    const k = rect('a.login').w / 320;
    expect(k).toBeGreaterThan(1.5);
    S3.forEach(e => {
      expect(rect(e.fqn).w).toBeCloseTo(320 * k, 6);
      e.parts.flatMap(allParts).filter(p => p.kind === 'region' || p.kind === 'control').forEach(p => expect(inside(rect(p.fqn), rect(e.fqn))).toBe(true));
    });
    const screens = span(S3.map(e => rect(e.fqn))), cmds = span(Array.from({ length: 40 }, (_, i) => rect(`a.c${i}`)));
    expect(screens.y + screens.h).toBeLessThan(cmds.y);
    // the row is as wide as the command block (minus the band paddings and the arrow room), or as tall as it when that comes first
    const F = rect('a');
    expect(screens.w / F.w > 0.6 || screens.h > 0.6 * cmds.h).toBe(true);
  });

  it('with few commands the screens keep their size (the scale is never below 1)', () => {
    const { rect } = loadMixed(1);
    expect(rect('a.login').w).toBe(320);
    expect(rect('a.login').h).toBe(240);
  });
});

describe('navigation arrows', () => {
  const { rect, S } = load();
  const EDGES: [string, string][] = [['a.login', 'a.home'], ['a.home', 'a.map'], ['a.map', 'a.login'], ['a.login', 'a.map']];
  const colOf = (id: string) => ENTRIES.find(e => e.fqn === id)!.rank;   // the ranks here are consecutive, so column = rank
  type Pt = { x: number; y: number };
  const sample = (P: Pt[], t: number) => {
    const u = 1 - t;
    return { x: u * u * u * P[0].x + 3 * u * u * t * P[1].x + 3 * u * t * t * P[2].x + t * t * t * P[3].x, y: u * u * u * P[0].y + 3 * u * u * t * P[1].y + 3 * u * t * t * P[2].y + t * t * t * P[3].y };
  };
  // every point of a path of cubic segments [p0, c, c, p1, c, c, p2 ...] (21 per segment)
  const points = (P: Pt[]) => { const out: Pt[] = []; for (let i = 0; i + 3 < P.length; i += 3) for (let j = 0; j <= 20; j++) out.push(sample(P.slice(i, i + 4), j / 20)); return out; };
  const at = (id: string) => ({ ...rect(id), col: colOf(id) });
  const frames = ENTRIES.map(e => at(e.fqn));
  const geom = (a: string, b: string) => S.geom(at(a), at(b), null, frames) as Pt[];

  it.each(EDGES)('the curve %s -> %s stays inside the frame (room for the arcs above and below)', (a, b) => {
    const F = rect('a');
    points(geom(a, b)).forEach(q => expect(q.x >= F.x && q.x <= F.x + F.w && q.y >= F.y && q.y <= F.y + F.h).toBe(true));
  });

  it('forward arcs go above the screens, back arcs below', () => {
    const up = geom('a.login', 'a.map'), back = geom('a.map', 'a.login');
    expect(Math.min(up[1].y, up[2].y)).toBeLessThan(rect('a.login').y);
    expect(Math.max(...back.map(p => p.y))).toBeGreaterThan(rect('a.map').y + rect('a.map').h);
  });

  it('b606: a back arrow goes around every frame of the columns it crosses (it leaves its own frame and enters its target only at their ends)', () => {
    const P = points(geom('a.map', 'a.login'));
    const strictly = (q: Pt, f: any) => q.x > f.x + 1e-6 && q.x < f.x + f.w - 1e-6 && q.y > f.y + 1e-6 && q.y < f.y + f.h - 1e-6;
    ENTRIES.filter(e => e.fqn !== 'a.map').forEach(e => P.forEach(q => expect(strictly(q, rect(e.fqn))).toBe(false)));
    // below the lowest frame of columns 0..2 (a.list stands under a.home in column 1)
    const low = Math.max(...ENTRIES.filter(e => e.rank <= 2).map(e => rect(e.fqn).y + rect(e.fqn).h));
    expect(Math.max(...P.map(q => q.y))).toBeGreaterThan(low);
    // inside its own frame only on the way out, at the height it starts
    P.filter(q => strictly(q, rect('a.map'))).forEach(q => expect(q.y).toBeCloseTo(P[0].y, 6));
  });
});

describe('arrow label pills never cover a screen frame', () => {
  // the shape of the C4PM Map page / IO view / Own window band: a tall screen, then two short ones; arcs and their pills squeezed above / below
  const E3 = [screen('a.map', 0, 0, 14, 3), screen('a.io', 1, 0, 3, 2), screen('a.own', 2, 0, 3, 2)];
  const LONG = 'open in own window (setting: New window)';
  it('whatever the zoom and position, no arrow pill covers a screen frame (or the title written above a small one): it shrinks or is skipped', () => {
    const m = loadSample();
    m.nav!.groups = [{ fqn: 'a', title: 'App', technology: 'React', word: 'App', entries: E3 }];
    m.nav!.edges = [
      { from: 'a.map', to: 'a.io', label: 'IO view (setting: Open IO view in)', labelled: true, via: 'a.map.r0.c0' },
      { from: 'a.map', to: 'a.own', label: LONG, labelled: true, via: 'a.map.r0.c1' },
      { from: 'a.io', to: 'a.map', label: 'Architecture view (setting: This window)', labelled: true, via: 'a.io.r0.c0' },
    ];
    const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
    const w = h.sandbox.window as any, V = w.C4PM_IOVIEW, C = w.C4PM_RENDER.theme.readColors();
    const frames = E3.map(e => V.rect(e.fqn));
    let pills = 0;
    for (const s of [0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.5]) for (const tx of [0, 60, 200]) for (const ty of [0, 80, 300]) {
      const calls: Array<{ t: string; x: number; y: number }> = [];
      const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (q: string) => ({ width: String(q).length * 6 }) : k === 'fillText' ? (q: string, x: number, y: number) => calls.push({ t: String(q), x, y }) : () => undefined), set: () => true });
      V.draw({ ctx, cam: { s, tx, ty }, cw: 1000, ch: 800, selectedId: null, hi: null }, C, 0);
      // a pill = the fillText of a label text centred at (x, y); width = 6 px per char + 12 (the fake measure), height 20
      calls.filter(c => /^(open in|IO view \(|Architecture view)/.test(c.t)).forEach(c => {
        pills++;
        const wd = c.t.length * 6 + 12, pr = { x: c.x - wd / 2, y: c.y - 10.5, w: wd, h: 20 };
        const up = 24 * s < 14 ? 16 : 0;   // a small frame has its title written above it
        frames.forEach(f => expect(overlap(pr, { x: f.x * s + tx, y: f.y * s + ty - up, w: f.w * s, h: f.h * s + up })).toBe(false));
      });
    }
    expect(pills).toBeGreaterThan(0);
  });

  it('b607: no arrow pill covers another arrow (labels are drawn after every arrow and avoid them)', () => {
    const m = loadSample();
    m.nav!.groups = [{ fqn: 'a', title: 'App', technology: 'React', word: 'App', entries: E3 }];
    const TO: Record<string, string> = { 'IO view (setting: Open IO view in)': 'a.io', [LONG]: 'a.own', 'Architecture view (setting: This window)': 'a.map' };
    m.nav!.edges = [
      { from: 'a.map', to: 'a.io', label: 'IO view (setting: Open IO view in)', labelled: true, via: 'a.map.r0.c0' },
      { from: 'a.map', to: 'a.own', label: LONG, labelled: true, via: 'a.map.r0.c1' },
      { from: 'a.io', to: 'a.map', label: 'Architecture view (setting: This window)', labelled: true, via: 'a.io.r0.c0' },
    ];
    const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
    const w = h.sandbox.window as any, V = w.C4PM_IOVIEW, C = w.C4PM_RENDER.theme.readColors();
    type P2 = { x: number; y: number };
    let checked = 0;
    for (const s of [0.3, 0.5, 0.7, 1, 1.5, 2.5]) for (const tx of [0, 200]) for (const ty of [0, 300]) {
      const calls: Array<{ t: string; x: number; y: number }> = [], paths: P2[][] = [];
      let start: P2 = { x: 0, y: 0 }, cur: P2[] | null = null;
      const ctx: any = new Proxy({}, { get: (_t, k) => {
        if (k === 'measureText') return (q: string) => ({ width: String(q).length * 6 });
        if (k === 'fillText') return (q: string, x: number, y: number) => calls.push({ t: String(q), x, y });
        if (k === 'moveTo') return (x: number, y: number) => { start = { x, y }; cur = null; };
        if (k === 'bezierCurveTo') return (...a: number[]) => { if (!cur) paths.push(cur = [start]); cur.push({ x: a[0], y: a[1] }, { x: a[2], y: a[3] }, { x: a[4], y: a[5] }); };
        return () => undefined;
      }, set: () => true });
      V.draw({ ctx, cam: { s, tx, ty }, cw: 1000, ch: 800, selectedId: null, hi: null }, C, 0);
      const pts = (P: P2[]) => { const out: P2[] = []; for (let i = 0; i + 3 < P.length; i += 3) for (let j = 0; j <= 20; j++) {
        const t = j / 20, u = 1 - t, k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t], Q = P.slice(i, i + 4);
        out.push({ x: k.reduce((a, q, n) => a + q * Q[n].x, 0), y: k.reduce((a, q, n) => a + q * Q[n].y, 0) });
      } return out; };
      // the end of the arrow into a target, in px: a forward arrow at the left edge middle, the back arrow at the right edge, 3/4 down
      const endOf = (id: string) => { const r = V.rect(id); return id === 'a.map' ? { x: (r.x + r.w) * s + tx, y: (r.y + r.h * 0.75) * s + ty } : { x: r.x * s + tx, y: (r.y + r.h / 2) * s + ty }; };
      calls.filter(c => TO[c.t] || /^(open in|IO view \(|Architecture view)/.test(c.t)).forEach(c => {
        const full = Object.keys(TO).find(k => k === c.t || k.startsWith(c.t.replace(/…$/, ''))) as string, e = endOf(TO[full]);
        const wd = c.t.length * 6 + 12, pr = { x: c.x - wd / 2 + 1.5, y: c.y - 10.5 + 1.5, w: wd - 3, h: 17 };
        paths.filter(P => Math.hypot(P[P.length - 1].x - e.x, P[P.length - 1].y - e.y) > 1e-6).forEach(P => pts(P).forEach(q => {
          checked++;
          expect(q.x > pr.x && q.x < pr.x + pr.w && q.y > pr.y && q.y < pr.y + pr.h).toBe(false);
        }));
      });
    }
    expect(checked).toBeGreaterThan(0);
  });
});
