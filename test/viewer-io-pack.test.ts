import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { NavEntry } from '../src/types';

// IO view: the packer (C4PM_IOVIEW.pack) and the edge-label rule (dc.label, seen through draw()).

function load(entries: NavEntry[] = [], edges: any[] = []) {
  const m = loadSample();
  if (entries.length) { m.nav!.groups = [{ fqn: 'a', title: 'App', technology: 'React', word: 'App', entries }]; m.nav!.edges = edges; }
  const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
  const w = h.sandbox.window as any;
  return { w, V: w.C4PM_IOVIEW };
}
const overlap = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rects = (items: any[], p: any) => items.map((it, i) => ({ x: p.pos[i].x, y: p.pos[i].y, w: it.w, h: it.h }));

describe('C4PM_IOVIEW.pack', () => {
  const { V } = load();

  it('is exported, and an empty list packs to nothing', () => {
    expect(typeof V.pack).toBe('function');
    expect(V.pack([])).toEqual({ w: 0, h: 0, k: 0, pos: [] });
  });

  it('two equal boxes stand side by side', () => {
    const items = [{ w: 394, h: 224 }, { w: 394, h: 224 }];
    const p = V.pack(items, { gap: 60, aspect: 2 });
    expect(p.k).toBe(2);
    expect(p.pos[0].y).toBe(p.pos[1].y);
    expect(p.w).toBe(394 * 2 + 60);
  });

  it('the column count follows the target aspect', () => {
    const items = Array.from({ length: 12 }, () => ({ w: 100, h: 100 }));
    const wide = V.pack(items, { gap: 10, aspect: 4 }), square = V.pack(items, { gap: 10, aspect: 1 });
    expect(wide.k).toBeGreaterThan(square.k);
    expect(Math.abs(Math.log(wide.w / wide.h / 4))).toBeLessThan(Math.abs(Math.log(square.w / square.h / 4)));
    expect(Math.abs(Math.log(square.w / square.h))).toBeLessThan(Math.abs(Math.log(wide.w / wide.h)));
  });

  it('extra chrome counts in the aspect only, never in the result', () => {
    const items = Array.from({ length: 6 }, () => ({ w: 100, h: 100 }));   // more than 4: the row rule does not apply
    const plain = V.pack(items, { gap: 0, aspect: 1 }), tall = V.pack(items, { gap: 0, aspect: 1, extra: { w: 0, h: 400 } });
    expect(tall.k).toBeGreaterThan(plain.k);   // with 400 of chrome a wider block is nearer to 1:1
    expect(tall.h).toBe(100 * Math.ceil(6 / tall.k));
    expect(tall.w).toBe(100 * tall.k);
  });

  it('two equal boxes stand side by side even when the target is tall (row rule, 2..4 equal boxes)', () => {
    const items = [{ w: 140, h: 95 }, { w: 140, h: 95 }];
    const p = V.pack(items, { gap: 20, aspect: 0.9 });
    expect(p.k).toBe(2);
    expect(p.pos[0].y).toBe(p.pos[1].y);
  });

  // top boxes of c4pm's own IO frame (w, h in canvas units): mixed widths, 367 wide ones and three wide ones (plan, board, ...)
  const OWN: [number, number][] = [[320,658],[320,240],[320,240],[394,483],[367,75],[367,303],[367,75],[367,255],[367,207],[367,112],[367,75],[367,350],[367,303],[367,112],[367,493],[1190,1853],[367,398],[367,207],[367,588],[367,255],[367,1112],[367,445],[367,493],[367,493],[367,303],[367,160],[367,255],[367,160],[367,350],[367,160],[367,398],[367,303],[367,350],[367,493],[367,303],[367,255],[367,255],[367,255],[367,255],[367,160],[1588,2023],[367,445],[367,1159],[367,1017],[367,207],[367,207],[367,160],[367,398],[367,160],[367,207],[367,255],[394,901],[367,255],[367,255],[367,255],[367,207],[367,160],[418,207],[367,350],[367,160],[367,112],[367,112],[367,112],[367,112],[367,75],[453,160],[367,75]];
  // the old masonry reference: each item to the shortest of k columns, best k by aspect
  const masonry = (items: any[], gap: number, aspect: number) => {
    let best: any = null;
    for (let k = 1; k <= items.length; k++) {
      const cols = Array.from({ length: k }, () => ({ w: 0, h: 0, n: 0 }));
      items.forEach(it => { let c = cols[0]; cols.forEach(q => { if (q.h < c.h) c = q; }); c.h += (c.n ? gap : 0) + it.h; c.w = Math.max(c.w, it.w); c.n++; });
      const used = cols.filter(c => c.n), w = used.reduce((a, c) => a + c.w, 0) + gap * (used.length - 1), h = Math.max(...used.map(c => c.h));
      const sc = Math.abs(Math.log(w / h / aspect));
      if (!best || sc < best.sc) best = { sc, w, h };
    }
    return best;
  };
  it('mixed widths leave fewer holes than the masonry did (fill ratio >= 0.7)', () => {
    const items = OWN.map(([w, h]) => ({ w, h })), area = items.reduce((a, i) => a + i.w * i.h, 0);
    const p = V.pack(items, { gap: 60, aspect: 1 }), m = masonry(items, 60, 1);
    const fill = area / (p.w * p.h), oldFill = area / (m.w * m.h);
    expect(fill).toBeGreaterThanOrEqual(0.7);
    expect(fill).toBeGreaterThan(oldFill);
    expect(p.w / p.h).toBeGreaterThan(0.5); expect(p.w / p.h).toBeLessThan(2);
    const R = rects(items, p);
    R.forEach((a, i) => R.slice(i + 1).forEach(b => expect(overlap(a, b)).toBe(false)));
  });

  it('is deterministic', () => {
    const items = OWN.map(([w, h]) => ({ w, h }));
    expect(V.pack(items, { gap: 60, aspect: 1 })).toEqual(V.pack(items, { gap: 60, aspect: 1 }));
  });

  it('never overlaps, whatever the sizes, and keeps the item order of pos', () => {
    const items = [{ w: 394, h: 900 }, { w: 120, h: 80 }, { w: 300, h: 300 }, { w: 90, h: 400 }, { w: 500, h: 60 }, { w: 200, h: 200 }, { w: 50, h: 50 }];
    [1, 1.6, 3].forEach(aspect => {
      const p = V.pack(items, { gap: 40, aspect }), R = rects(items, p);
      expect(p.pos.length).toBe(items.length);
      R.forEach((a, i) => { expect(a.x + a.w).toBeLessThanOrEqual(p.w + 1e-6); expect(a.y + a.h).toBeLessThanOrEqual(p.h + 1e-6); R.slice(i + 1).forEach(b => expect(overlap(a, b)).toBe(false)); });
    });
  });
});

// ---- root layout: frames that hold screens come first, each alone in its row; the other frames pack below
describe('frames in the root', () => {
  it('the screens frame is on top and alone in its row; the others sit below it', () => {
    const e = (kind: any, fqn: string, rank = 0): NavEntry => ({ kind, fqn, uid: null, title: fqn, status: null, rank, order: 0, parent: null, parts: [] });
    const m = loadSample();
    m.nav!.groups = [
      { fqn: 'cli', title: 'CLI', technology: 'x', word: 'CLI', entries: [e('command', 'cli.a')] },
      { fqn: 'web', title: 'Web', technology: 'x', word: 'App', entries: [e('screen', 'web.a'), e('screen', 'web.b', 1)] },
      { fqn: 'api', title: 'API', technology: 'x', word: 'API', entries: [e('route', 'api.a')] },
    ];
    m.nav!.edges = [];
    const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
    const V = (h.sandbox.window as any).C4PM_IOVIEW;
    const web = V.rect('web'), cli = V.rect('cli'), api = V.rect('api');
    expect(web.y).toBeLessThan(cli.y);
    expect(web.y).toBeLessThan(api.y);
    [cli, api].forEach(r => expect(r.y).toBeGreaterThanOrEqual(web.y + web.h));
    expect(overlap(cli, api)).toBe(false);
  });
});

// ---- the label rule: a recording ctx; the screen pair login -> home is one arrow with the label 'go to the home screen'
const scr = (fqn: string, rank: number): NavEntry => ({ kind: 'screen', fqn, uid: null, title: fqn, status: null, rank, order: 0, parent: null, parts: [] });
function texts(cam: { s: number; tx: number; ty: number }) {
  const { w, V } = load([scr('a.login', 0), scr('a.home', 1)], [{ from: 'a.login', to: 'a.home', label: 'go to the home screen', labelled: true, via: 'a.login' }]);
  const said: string[] = [];
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: String(s).length * 6 }) : k === 'fillText' ? (s: string) => said.push(s) : () => undefined), set: () => true });
  const map: any = { ctx, cam, cw: 1000, ch: 800, selectedId: null, hi: null };
  V.draw(map, w.C4PM_RENDER.theme.readColors(), 0);
  return { said, labels: map.edgeLabels as any[] };
}

describe('arrow labels', () => {
  it('no label when the arrow is short on screen (Fit of a big view); zooming in brings it back', () => {
    expect(texts({ s: 0.02, tx: 0, ty: 0 }).said.some(t => t.startsWith('go'))).toBe(false);
    expect(texts({ s: 1.2, tx: 20, ty: 100 }).said.some(t => t.startsWith('go'))).toBe(true);
  });

  it('a long label is cut with an ellipsis, offered to the hover list, and its pill is never wider than 0.9 chord', () => {
    const r = texts({ s: 1, tx: 20, ty: 100 });   // chord 110 px (the column gap): max pill 99 px, the text needs 138
    expect(r.labels.length).toBe(1);
    expect(r.labels[0].full).toBe('go to the home screen');
    expect(r.labels[0].w).toBeLessThanOrEqual(0.9 * 110 + 1e-6);
  });
});
