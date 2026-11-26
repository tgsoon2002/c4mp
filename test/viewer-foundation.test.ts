import { renderViewHtml } from '../src/page/html';
import type { ViewModel, ViewNode } from '../src/types';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// b908 slice 3: foundation components on the map (page data meta.role 'foundation' and usedByCount, set by the model in
// slice 2; here injected into the sample). Option D tinted glass in its own hue, a "used by N" badge, and the arrows INTO
// the box shown only while it is hovered, focused or selected. Runs the real render.js / controls.js / panelKit.js.

const COLORS: Record<string, string> = {
  '--found-1': '#F00001', '--found-2': '#F00002', '--found-3': '#F00003',
  '--ink': '#111111', '--c3-ink': '#222222', '--edge': '#333333', '--c3': '#C30003',
};
const getComputedStyle = () => ({ getPropertyValue: (k: string) => COLORS[k] ?? '#888888' });
const UTILS = 'api/utils';

/** The sample with the given components marked foundation (usedByCount 2), plus an out arrow and an arrow from another container. */
function model(foundation: string[]): ViewModel {
  const m = loadSample();
  const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
  for (const id of foundation) {
    const n = all(m.root).find((x) => x.id === id)!;   // meta.role and usedByCount are page data (types.ts), injected here
    n.meta = { role: 'foundation' };
    n.usedByCount = 2;
  }
  if (foundation.length) {
    m.edges.push({ from: UTILS, to: 'api/models', weight: 1 }, { from: 'web/_root', to: UTILS, weight: 1 });
  }
  return m;
}

function load(foundation: string[]) {
  const m = model(foundation);
  const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { getComputedStyle, location: { href: 'file:///x.html', hash: '' } } });
  h.frames.flush();
  const w = h.sandbox.window as any;
  const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];
  const node = (id: string): any => w.C4PM_STATE.nodeById[id];
  /** visibleEdges with the nodes of `kinds` drawn (alpha 1), `sel` selected and `hover` hovered. */
  const visible = (kinds: string[], sel: string | null = null, hover: string | null = null) => {
    const { map } = w.C4PM_STATE;
    for (const k of Object.keys(map.alpha)) delete map.alpha[k];
    all(m.root).filter((n) => kinds.includes(n.kind)).forEach((n) => { map.alpha[n.id] = 1; });
    map.selectedId = sel;
    map.hoverId = hover;
    return w.C4PM_RENDER.edges.visibleEdges() as Array<{ A: ViewNode; B: ViewNode; out: boolean; inn: boolean; found: string | null }>;
  };
  return { m, h, w, node, visible };
}
const pair = (v: { A: ViewNode; B: ViewNode }) => `${v.A.id}>${v.B.id}`;
const ALL = ['system', 'container', 'component'];

describe('b908 foundation boxes on the map', () => {
  const t = load([UTILS]);
  const into = (list: ReturnType<typeof t.visible>) => list.filter((v) => v.B.id === UTILS);

  it('nothing hovered or selected: no arrow into the foundation box; its out arrow stays, unlit', () => {
    const list = t.visible(ALL);
    expect(into(list)).toEqual([]);
    const out = list.find((v) => pair(v) === `${UTILS}>api/models`)!;
    expect(out.found).toBeNull();
    expect(list.filter((v) => v.B.id !== UTILS).length).toBe(list.length);
  });

  it.each([
    ['the box', UTILS],
    ['a node inside the box', 'child'],
  ])('hovered (%s): the arrows into it appear in its hue, not as selection arrows', (_c, id) => {
    const hover = id === 'child' ? t.node(UTILS).children[0].id : id;
    const list = into(t.visible(ALL, null, hover));
    expect(list.map(pair).sort()).toEqual(['api/_root>api/utils', 'api/routes>api/utils', 'web/_root>api/utils']);
    list.forEach((v) => { expect(v.found).toBe('#F00002'); expect(v.inn).toBe(false); });
  });

  it('selected: the same arrows, flagged inn; drawEdges strokes them in the hue at width 2.6, never in the GLOW_IN colour', () => {
    const list = into(t.visible(ALL, UTILS));
    expect(list.length).toBe(3);
    list.forEach((v) => { expect(v.found).toBe('#F00002'); expect(v.inn).toBe(true); });
    t.h.opLog.length = 0;
    t.w.C4PM_RENDER.edges.drawEdges(0);
    const strokes = t.h.opLog.filter((o) => o.op === 'stroke');
    expect(strokes.some((o) => o.style === '#F00002' && o.lineWidth === 2.6)).toBe(true);
    expect(strokes.some((o) => o.style === '#F05FD0')).toBe(false);
  });

  it('hover only: the arrows into it are faint, in the hue, no glow width', () => {
    t.visible(ALL, null, UTILS);
    t.h.opLog.length = 0;
    t.w.C4PM_RENDER.edges.drawEdges(0);
    const strokes = t.h.opLog.filter((o) => o.op === 'stroke' && o.style === '#F00002');
    expect(strokes.length).toBeGreaterThan(0);
    strokes.forEach((o) => { expect(o.alpha).toBe(0.45); expect(o.lineWidth).toBe(2); });
  });

  it('camera focus on the box shows the arrows too', () => {
    const was = t.w.C4PM_CAM.focusNode;
    t.w.C4PM_CAM.focusNode = () => t.node(UTILS);
    try {
      expect(into(t.visible(ALL)).length).toBe(3);
    } finally {
      t.w.C4PM_CAM.focusNode = was;
    }
  });

  it('the api container closed: web > api is a normal arrow (a closed container is not a foundation box)', () => {
    const list = t.visible(['system', 'container']);
    const wa = list.find((v) => pair(v) === 'web>api');
    expect(wa).toBeDefined();
    expect(wa!.found).toBeNull();
  });

  it('box: tinted glass in the hue, name in the theme ink, "used by 2" badge in the hue, no fill in the component colour', () => {
    const texts: Array<[string, string]> = [];
    const ctx = t.w.C4PM_STATE.map.ctx;
    ctx.fillText = function (this: any, s: unknown) { texts.push([String(s), String(this.fillStyle)]); };
    t.h.opLog.length = 0;
    t.w.C4PM_STATE.map.hi = null;
    t.w.C4PM_RENDER.beans.drawBubble({ n: t.node(UTILS), R: { x: 100, y: 100, w: 240, h: 120 }, a: 1 });
    const ops = t.h.opLog.map((o) => `${o.op} ${o.style} ${o.alpha}${o.lineWidth === 1 ? ' w1' : ''}`);
    expect(ops).toContain('fill #F00002 0.09');
    expect(ops).toContain('stroke #F00002 0.35');
    expect(ops).toContain('stroke #F00002 0.75 w1');
    expect(t.h.opLog.some((o) => o.op === 'fill' && o.style === '#C30003')).toBe(false);
    expect(texts).toContainEqual([t.node(UTILS).name, '#111111']);
    expect(texts).toContainEqual(['used by 2', '#F00002']);
    delete ctx.fillText;
  });

  it('a normal component drawn the same way: component fill, no badge', () => {
    const texts: string[] = [];
    const ctx = t.w.C4PM_STATE.map.ctx;
    ctx.fillText = function (s: unknown) { texts.push(String(s)); };
    t.h.opLog.length = 0;
    t.w.C4PM_RENDER.beans.drawBubble({ n: t.node('api/routes'), R: { x: 100, y: 100, w: 240, h: 120 }, a: 1 });
    expect(t.h.opLog.some((o) => o.op === 'fill' && o.style === '#C30003')).toBe(true);
    expect(texts.some((s) => s.startsWith('used by'))).toBe(false);
    delete ctx.fillText;
  });

  it('b912: an OPEN foundation box with a long detail and two count chips still draws "used by 2"', () => {
    const u = load([UTILS]);
    const n = u.node(UTILS);
    n.detail = Array.from({ length: 20 }, (_, i) => `src/api/utils/file${i}.ts`).join(' + ');
    n.boardCount = 61;
    n.tests = { count: 5 };
    const { map, overlays } = u.w.C4PM_STATE;
    overlays.board = true;
    overlays.tests = true;
    const texts: string[] = [];
    map.ctx.fillText = function (s: unknown) { texts.push(String(s)); };
    const R = { x: 100, y: 100, w: 600, h: 120 };
    map.cam.s = 17;   // the header height is n.headerH * cam.s: about 29 px, a readable header
    const hdr = u.w.C4PM_RENDER.regions.drawHeader(n, R.x, R.y, R.w, R.h, 1, '#F00002');
    u.w.C4PM_RENDER.beans.drawCountPills(n, R, 1, hdr);
    expect(texts).toContain('used by 2');
    expect(texts).toContain('61');
    expect(texts).toContain('5');
    delete map.ctx.fillText;
  });

  it('hover wiring: the pointer over the box sets map.hoverId, leaving the canvas clears it', () => {
    const u = load([UTILS]);   // fresh page: the tests above changed alpha and selection
    const { map } = u.w.C4PM_STATE;
    u.w.C4PM_MAP.flyTo('api');
    u.h.frames.runToCompletion();
    for (let i = 0; i < 60; i++) u.h.frames.flush();
    const R = u.w.C4PM_CAM.scr(u.node(UTILS));   // where the box is drawn (a closed box has no _R)
    expect(R.w).toBeGreaterThan(0);
    u.h.canvas.dispatch('pointermove', { pointerId: 1, clientX: R.x + R.w / 2, clientY: R.y + R.h / 2 });
    expect(map.hoverId).toBe(UTILS);
    u.h.canvas.dispatch('pointerleave', {});
    expect(map.hoverId).toBeNull();
  });

  it('panel: Role and Used by pills', () => {
    t.w.C4PM_MAP.select(UTILS);
    const text = serializeText(t.h.panel);
    expect(text).toContain('Role: foundation');
    expect(text).toContain('Used by: 2');
  });
});

describe('b908 hue slots', () => {
  it('two foundation boxes on one slot: the smaller key keeps it, the other takes the next free slot', () => {
    const t = load(['api/models', 'api/services']);   // both FNV-1a mod 3 = 2
    expect(t.w.C4PM_RENDER.beans.foundationHue(t.node('api/models'))).toBe('#F00003');
    expect(t.w.C4PM_RENDER.beans.foundationHue(t.node('api/services'))).toBe('#F00001');
  });
});

describe('b908 no foundation: the page behaves as before', () => {
  it('visibleEdges lists every sample pair, none flagged found', () => {
    const t = load([]);
    const list = t.visible(ALL);
    expect(list.map(pair).sort()).toEqual([
      'api/_root>api/routes', 'api/_root>api/utils', 'api/routes>api/payments', 'api/routes>api/services',
      'api/routes>api/utils', 'api/services>api/models', 'api/services>api/routes',
    ]);
    list.forEach((v) => expect(v.found).toBeNull());
    expect(t.w.C4PM_RENDER.beans.isFoundation(t.node(UTILS))).toBe(false);
  });
});
