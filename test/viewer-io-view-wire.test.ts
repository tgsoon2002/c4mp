import { renderViewHtml } from '../src/page/html';
import { buildNavView } from '../src/view/navLayout';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { NavEntry, NavModel, NavPart, NavWireframe } from '../src/types';

// W11 (b307, W12 merged in): ioView.layout measures every screen wireframe ONCE (C4PM_IO_WIREFRAME.measureAll), hands the results to the
// screens band (band.wire) and answers wireOf / placed; rect() of a part is the union of its boxes, or its screen's rect when it has none (C9).

const part = (fqn: string, kind: string, parts: NavPart[] = []): NavPart => ({ fqn, uid: null, kind, title: fqn.split('.').pop()!, status: null, parts });
const screen = (fqn: string, rank: number, parts: NavPart[], wireframe?: NavWireframe): NavEntry =>
  ({ kind: 'screen', fqn, uid: null, title: fqn.split('.').pop()!, status: null, rank, order: 0, parent: null, parts, ...(wireframe ? { wireframe } : {}) });

const HOME_WF: NavWireframe = {
  file: 'io/w.home.html', html: '<div data-c4="top"></div>', missing: ['w.home.side'],
  refs: [{ ref: 'top', fqn: 'w.home.top' }, { ref: 'go', fqn: 'w.home.top.go' }, { ref: 'hud', fqn: 'w.home.hud' }],
};
function nav(withWire: boolean): NavModel {
  return {
    groups: [{ fqn: 'w', title: 'Web', technology: 'React', word: 'App', entries: [
      screen('w.home', 0, [
        part('w.home.top', 'region', [part('w.home.top.go', 'control')]), part('w.home.hud', 'control'), part('w.home.side', 'region'), part('w.home.err', 'state'),
      ], withWire ? HOME_WF : undefined),
      screen('w.cart', 1, [part('w.cart.list', 'region', [part('w.cart.list.row', 'control')])]),
      screen('w.pay', 2, [part('w.pay.form', 'region')], withWire ? { file: 'io/w.pay.html', error: 'over the size cap', refs: [], missing: ['w.pay.form'] } : undefined),
    ] }],
    edges: [{ from: 'w.home', to: 'w.cart', label: 'Cart', labelled: true, via: 'w.home.top.go' }],
    calls: [],
  };
}
const BOXES = [
  { ref: 'top', x: 0, y: 0, w: 1280, h: 64, hidden: false, order: 0 },
  { ref: 'go', x: 1100, y: 12, w: 120, h: 40, hidden: true, order: 1 },
  { ref: 'hud', x: 16, y: 700, w: 100, h: 80, hidden: false, order: 2 },
  { ref: 'hud', x: 1164, y: 700, w: 100, h: 80, hidden: false, order: 3 },
];
const EXPORT = 'window.C4PM_IO_WIREFRAME = { measureAll };';
// The fake measurer (patched over ioWireframe.js's export line in the page text): counts calls, keeps the items, answers fixed boxes
const FAKE = 'window.C4PM_IO_WIREFRAME = { measureAll: function (items, rules) { window.__calls.push({ items: items, rules: !!rules }); '
  + 'var o = {}; items.forEach(function (it) { o[it.fqn] = { ok: true, viewport: { w: it.viewport.w, h: it.viewport.h }, boxes: window.__boxes }; }); return o; } };';

function page(withWire: boolean, patch: boolean) {
  const m = loadSample();
  m.nav = nav(withWire);
  m.navView = buildNavView(m.nav);
  let html = renderViewHtml(m);
  if (patch) {
    expect(html.split(EXPORT)).toHaveLength(2);
    html = html.replace(EXPORT, () => FAKE);
  }
  const calls: Array<{ items: Array<{ fqn: string; html: string; viewport: { w: number; h: number } }>; rules: boolean }> = [];
  const h = runViewerScripts(html, { extraIds: ['btn-gear', 'settings-pop'], globals: { __calls: calls, __boxes: BOXES, location: { href: 'file:///x.html#io', hash: '#io' } } });
  const w = h.sandbox.window as any;
  return { h, w, V: w.C4PM_IOVIEW, calls };
}
function drawOnce(w: any, s = 1) {   // the harness canvas is 1200 x 800 (C4PM_CAM.offScreen reads it): every frame stays on it
  const texts: string[] = [];
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (q: string) => ({ width: String(q).length * 6 }) : k === 'fillText' ? (q: string) => texts.push(String(q)) : () => undefined), set: () => true });
  w.C4PM_IOVIEW.draw({ ctx, cam: { s, tx: 0, ty: 0 }, cw: 4000, ch: 3000, selectedId: null, hi: null }, w.C4PM_RENDER.theme.readColors(), 0);
  return texts;
}

describe('ioView with the real ioWireframe.js (vm: no layout engine)', () => {
  it('measuring fails per screen with the reason, no exception: wireOf says not-drawn, the screens keep their strips', () => {
    const plain = page(false, false), wired = page(true, false);
    expect(wired.V.wireOf('w.home')).toEqual({ state: 'not-drawn', reason: 'no layout engine: DOMParser is missing', viewport: { w: 1280, h: 800, source: 'device' } });
    expect(wired.V.wireOf('w.pay')).toMatchObject({ state: 'error', reason: 'over the size cap' });
    expect(wired.V.wireOf('w.cart')).toMatchObject({ state: 'none' });
    expect(wired.V.wireOf('w.home.top')).toBeNull();
    for (const id of ['w.home', 'w.home.top', 'w.home.top.go', 'w.home.side', 'w.cart', 'w.cart.list.row']) expect(wired.V.rect(id)).toEqual(plain.V.rect(id));
    expect(wired.V.placed('w.home.top')).toBeNull();
    const texts = drawOnce(wired.w);
    expect(texts.filter(t => t === 'wireframe not drawn')).toHaveLength(2);   // home (ok:false) and pay (server error)
    expect(texts).toContain('no wireframe');                                 // cart: a screen of the page has a wireframe (Q12)
  });

  it('a page without any wireframe: no badge, no measuring call (K2)', () => {
    const plain = page(false, true);
    expect(plain.calls).toHaveLength(0);
    expect(plain.V.wireOf('w.cart')).toEqual({ state: 'none', viewport: { w: 1280, h: 800, source: 'device' } });
    const texts = drawOnce(plain.w);
    expect(texts.some(t => /wireframe/.test(t))).toBe(false);
  });
});

describe('ioView with a measurer that answers fixed boxes', () => {
  const { w, V, calls } = page(true, true);

  it('measureAll is called once for all screens (html + viewport), across layout / draw rounds', () => {
    V.layout(); drawOnce(w); V.layout(); drawOnce(w);
    expect(calls).toHaveLength(1);
    expect(calls[0].rules).toBe(true);
    expect(calls[0].items).toEqual([{ fqn: 'w.home', html: HOME_WF.html, viewport: { w: 1280, h: 800 } }]);
  });

  it('the screen frame takes the viewport aspect; rect of a part on two elements is the union of its boxes', () => {
    const S = w.C4PM_IO_SCREENS, F = V.rect('w.home'), k = S.WORLD_PER_PX;
    expect(F.w).toBe(1280 * k);
    expect(F.h).toBe(S.TB + 800 * k + 18);   // + the states strip (w.home.err)
    const hud = V.rect('w.home.hud');
    expect(hud.x).toBeCloseTo(F.x + 16 * k, 9);
    expect(hud.y).toBeCloseTo(F.y + S.TB + 700 * k, 9);
    expect(hud.w).toBeCloseTo((1264 - 16) * k, 9);
    expect(hud.h).toBeCloseTo(80 * k, 9);
  });

  it('a region with no box gets its screen rect, and its node holds the same rect; a state gets none', () => {
    expect(V.rect('w.home.side')).toEqual(V.rect('w.home'));
    const n = w.C4PM_MAP.nodeById('w.home.side');
    expect({ x: n.x, y: n.y, w: n.w, h: n.h }).toEqual(V.rect('w.home.side'));
    expect(V.rect('w.home.err')).toBeNull();
  });

  it('placed() reports the boxes and hidden; null for an unplaced part and for a screen without a drawn wireframe', () => {
    expect(V.placed('w.home.hud')).toEqual({ boxes: 2, hidden: false });
    expect(V.placed('w.home.top.go')).toEqual({ boxes: 1, hidden: true });
    expect(V.placed('w.home.side')).toBeNull();
    expect(V.placed('w.cart.list')).toBeNull();
    expect(V.placed('w.home')).toBeNull();
  });

  it('wireOf: out-of-date with the reason (a region not placed); the other screens as before', () => {
    expect(V.wireOf('w.home')).toEqual({ state: 'out-of-date', reason: 'not placed: w.home.side', viewport: { w: 1280, h: 800, source: 'device' } });
    expect(V.wireOf('w.pay').state).toBe('error');
    expect(V.wireOf('w.cart').state).toBe('none');
  });

  it('draws the boxes: two hits for the HUD, the size and the out-of-date badge in the title row', () => {
    const texts = drawOnce(w, 1.5);
    expect(texts).toContain('1280 x 800');
    expect(texts).toContain('wireframe out of date');
    const F = V.rect('w.home'), s = 1.5;
    const hits = [66, 1214].map(px => V.hit((F.x + px * 0.25) * s, (F.y + 24 + 740 * 0.25) * s));   // the middles of the two HUD boxes
    expect(hits.map(h => h && h.id)).toEqual(['w.home.hud', 'w.home.hud']);
    expect(hits[0].entryId).toBe('w.home');
  });
});
