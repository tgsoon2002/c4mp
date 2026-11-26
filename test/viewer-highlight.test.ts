import path from 'path';
import { buildView } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';

// P16-B30b: map highlight for a selected board item. C4PM_MAP.setHighlight(nodeIds) lights c-items
// (amber ring), fades the others and paints amber the edges whose two ends are both lit.
// Runs the real render.js / map.js in the fake-DOM harness (the fake canvas records fill/stroke ops).

const BGLOW = '#FFB020';
const EDGE = '#E10004';        // --edge in the harness's fake getComputedStyle
const COMPONENT_FILL = '#888888'; // --c3 is not in the fake's table, so component bubbles fill grey

interface Api {
  flyTo(id: string): void;
  select(id: string | null): boolean;
  setHighlight(ids: string[] | null): number;
  highlightInfo(): { lit: number; arrows: number };
  draw(): void;
  state: { hi: Set<string> | null };
}

let h: HarnessResult;
let api: Api;
let edges: Array<{ from: string; to: string }>;

function settle(r: HarnessResult) {
  r.frames.runToCompletion();
  for (let i = 0; i < 60; i++) r.frames.flush();
}

function draw() {
  h.opLog.length = 0;
  api.draw();
  return h.opLog.slice();
}

beforeEach(() => {
  const built = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  edges = built.model.edges;
  h = runViewerScripts(built.html);
  settle(h);
  api = h.sandbox.C4PM_MAP as unknown as Api;
  api.flyTo('api');
  settle(h);
});

describe('P16-B30b map highlight', () => {
  it('fixture has the edges the tests rely on (api/routes -> api/payments and api/routes -> another component)', () => {
    expect(edges.some(e => e.from === 'api/routes' && e.to === 'api/payments')).toBe(true);
    expect(edges.filter(e => e.from === 'api/routes').length).toBeGreaterThan(1);
  });

  it('one lit c-item: amber ring (width 3), others fade to alpha 0.3, no amber edge', () => {
    expect(api.setHighlight(['api/routes'])).toBe(1);
    const ops = draw();
    expect(ops.filter(o => o.op === 'stroke' && o.style === BGLOW && o.lineWidth === 3).length).toBe(1);
    const fills = ops.filter(o => o.op === 'fill' && o.style === COMPONENT_FILL);
    expect(fills.some(o => o.alpha < 0.35)).toBe(true);   // non-lit components are faded
    expect(fills.some(o => o.alpha > 0.9)).toBe(true);    // the lit one is not
    expect(api.highlightInfo()).toEqual({ lit: 1, arrows: 0 });
    // the open container/system region around it gets the amber border (width 2.6, not an edge: no arrow lit)
    expect(ops.some(o => o.op === 'stroke' && o.style === BGLOW && o.lineWidth === 2.6)).toBe(true);
    // all grey edges are dimmed
    const grey = ops.filter(o => o.op === 'stroke' && o.style === EDGE);
    expect(grey.length).toBeGreaterThan(0);
    grey.forEach(o => expect(o.alpha).toBeCloseTo(0.25));
  });

  it('two lit c-items joined by an edge: that edge is amber and counted; an edge to an unlit one is not', () => {
    api.setHighlight(['api/routes']);
    const one = draw().filter(o => o.op === 'stroke' && o.style === BGLOW && o.lineWidth === 2.6).length;
    expect(api.setHighlight(['api/routes', 'api/payments'])).toBe(2);
    const two = draw().filter(o => o.op === 'stroke' && o.style === BGLOW && o.lineWidth === 2.6).length;
    expect(two).toBeGreaterThan(one);   // + the lit-lit edge(s)
    const info = api.highlightInfo();
    expect(info.lit).toBe(2);
    expect(info.arrows).toBe(edges.filter(e => ['api/routes', 'api/payments'].includes(e.from) && ['api/routes', 'api/payments'].includes(e.to)).length);
    expect(info.arrows).toBeGreaterThanOrEqual(1);
    // routes -> (something not lit) stays a dimmed grey edge
    const grey = draw().filter(o => o.op === 'stroke' && o.style === EDGE);
    expect(grey.length).toBeGreaterThan(0);
    grey.forEach(o => expect(o.alpha).toBeCloseTo(0.25));
  });

  it('setHighlight(null) and setHighlight([]) give the same draw log as never calling it', () => {
    // Fresh page per variant: the fake canvas has no save()/restore(), so style leftovers of an earlier
    // draw (a lit ring's lineWidth 3) would leak into the first logged op of a later draw in the same page.
    const run = (act: (a: Api) => void) => {
      const built = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
      const r = runViewerScripts(built.html);
      settle(r);
      const a = r.sandbox.C4PM_MAP as unknown as Api;
      a.flyTo('api');
      settle(r);
      act(a);
      r.opLog.length = 0;
      r.strokeLog.length = 0;
      a.draw();
      return JSON.stringify([r.opLog, r.strokeLog]);
    };
    const base = run(() => {});
    expect(run(a => { a.setHighlight(null); })).toBe(base);
    expect(run(a => { a.setHighlight([]); })).toBe(base);
    expect(run(a => { a.setHighlight(['no/such/node']); })).toBe(base);
    api.setHighlight(['api/routes']);
    api.setHighlight(null);
    expect(api.state.hi).toBeNull();
    expect(api.highlightInfo()).toEqual({ lit: 0, arrows: 0 });
  });

  it('unknown ids are ignored; only unknown ids clear the highlight', () => {
    expect(api.setHighlight(['api/routes', 'no/such/node'])).toBe(1);
    expect(api.highlightInfo().lit).toBe(1);
    expect(api.setHighlight(['no/such/node'])).toBe(0);
    expect(api.state.hi).toBeNull();
  });

  it('the draw loop keeps requesting frames while lit (glow pulse) and stops after clearing', () => {
    api.setHighlight(['api/routes']);
    settle(h);
    h.opLog.length = 0;
    for (let i = 0; i < 4; i++) h.frames.flush();
    expect(h.opLog.length).toBeGreaterThan(0);     // still redrawing with nothing selected
    api.setHighlight(null);
    settle(h);
    h.opLog.length = 0;
    for (let i = 0; i < 4; i++) h.frames.flush();
    expect(h.opLog.length).toBe(0);                // idle again
  });

  it('a lit board item does not change the map selection', () => {
    api.select('api/services');
    api.setHighlight(['api/routes']);
    expect((h.sandbox.C4PM_MAP as { selectedId(): string | null }).selectedId()).toBe('api/services');
  });
});
