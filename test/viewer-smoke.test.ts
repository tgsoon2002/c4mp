import path from 'path';
import { runSnapshot, compareSnapshots } from '../src/index';
import { buildViewModel } from '../src/view/model';
import { layoutView } from '../src/view/layout';
import { applyDrift, applyFindings } from '../src/view/overlay';
import { renderViewHtml, buildView } from '../src/page/html';
import { readMeta } from '../src/history/meta';
import { listC4Files } from '../src/plan/files';
import { parsePlan } from '../src/plan/parser';
import { checkPlan } from '../src/c4/check';
import type { ViewModel, ViewNode } from '../src/types';

// P16-B30a: the fake DOM / canvas harness (FakeEl, runViewerScripts, serializeText ...) lives in
// ./helpers/viewer-harness.ts so the board tests share it.
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { CREDIT_URL, NO_URL_EXCEPT_CREDIT, URL_RULE_MISSES } from './helpers/creditUrl';

// ---------- fixture builders ----------

function buildViewForFixture(repoPath: string, options?: { fromRepo?: string; sprint?: string }): { model: ViewModel; html: string } {
  const snapshot = runSnapshot({ repo: repoPath, write: false, quiet: true });
  const meta = readMeta(repoPath);
  const s = snapshot.stats;
  const u = s.unresolvedImports || 0;
  const summaryLine = `${meta.repoName} — ${s.containers} containers, ${s.components} components, ${s.files} files, ${s.codeElements} code elements, ${s.componentEdges} component edges, ${u} unresolved import${u !== 1 ? 's' : ''}`;

  let model = buildViewModel(snapshot, summaryLine);

  if (options?.fromRepo) {
    const fromSnapshot = runSnapshot({ repo: options.fromRepo, write: false, quiet: true });
    const diff = compareSnapshots(fromSnapshot, snapshot);
    model = applyDrift(model, diff, path.basename(options.fromRepo));
  }

  const c4Files = listC4Files(repoPath);
  if (c4Files.length > 0) {
    const plan = parsePlan(repoPath, c4Files);
    const findings = checkPlan(plan, snapshot, repoPath, { sprint: options?.sprint });
    model = applyFindings(model, findings);
  }

  model = layoutView(model);
  const html = renderViewHtml(model);
  return { model, html };
}

// ---------- tests ----------

describe('viewer-smoke: string-level checks', () => {
  test('sample fixture HTML is well-formed and has no external URLs', () => {
    const { html, model } = buildViewForFixture(path.join(__dirname, 'fixtures/sample'));
    expect(html).toContain('window.C4PM_DATA');
    expect(html).not.toMatch(NO_URL_EXCEPT_CREDIT);   // b168: the one allowed URL is the credit link (a plain anchor, loads nothing)
    const dataMatch = html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(model.root.kind).toBe('system');
  });

  test('b168: the URL rule allows only the credit link; any other http(s) URL still fails it', () => {
    expect(`<a href="${CREDIT_URL}">`).not.toMatch(NO_URL_EXCEPT_CREDIT);
    for (const s of URL_RULE_MISSES) expect(s).toMatch(NO_URL_EXCEPT_CREDIT);
  });

  // Phase 35 C (b945): the C4MP brand in the static page, all inline (the URL rule above proves it loads nothing from the network).
  test('b945: inline favicon (light and dark), header badge, and the store.js / brand.js prelude before the inline scripts', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample'));
    const icons = [...html.matchAll(/<link rel="icon"([^>]*)>/g)].map(m => m[1]);
    expect(icons.length).toBe(2);
    expect(icons.every(a => a.includes('href="data:image/svg+xml,'))).toBe(true);
    expect(icons.some(a => a.includes('prefers-color-scheme: dark') && a.includes('%238FD9C2'))).toBe(true);
    expect(icons.some(a => a.includes('prefers-color-scheme: light') && a.includes('%231F6F5C'))).toBe(true);
    expect(html).toMatch(/<header id="header">\s*(<!--[^>]*-->\s*)?<svg id="brand-badge"[^>]*aria-label="C4MP"/);
    expect(html.indexOf('<svg id="brand-badge"')).toBeLessThan(html.indexOf('<h1 id="title">'));
    const at = (s: string) => html.indexOf(s);
    expect(at('window.C4PM_STORE = {')).toBeGreaterThan(-1);
    expect(at('window.C4PM_BRAND = {')).toBeGreaterThan(at('window.C4PM_STORE = {'));
    expect(at('window.C4PM_STORE = {')).toBeLessThan(at('// P13-T11: collapse buttons'));
    expect(html).not.toContain('/*C4PM_PRELUDE*/');
  });

  test('b168: the map has the "Made with C4MP" credit link (bottom-right, new tab, no opener / referrer)', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample'));
    const tag = html.match(/<a id="made-with"([^>]*)>([^<]*)<\/a>/);
    expect(tag).not.toBeNull();
    const attr = (name: string) => (tag![1].match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
    expect(attr('href')).toBe(CREDIT_URL);
    expect(attr('target')).toBe('_blank');
    expect(attr('rel')!.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    expect(attr('title')).toBe('c4mp: zoomable architecture map. Get it here');
    expect(tag![2]).toBe('Made with C4MP');
    // inside #map-wrap (so the IO and Storage views show it too), before the drawers that follow #map-wrap
    const at = html.indexOf('<a id="made-with"');
    expect(at).toBeGreaterThan(html.indexOf('<div id="map-wrap">'));
    expect(at).toBeLessThan(html.indexOf('<section id="board-drawer"'));
  });

  test('drift and findings overlays populate the model', () => {
    const { model: drifted } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'), {
      fromRepo: path.join(__dirname, 'fixtures/sample'),
    });
    expect(drifted.drift).not.toBeNull();
    const { model: findings } = buildViewForFixture(path.join(__dirname, 'fixtures/phofast'), { sprint: 'S15' });
    expect(findings.planFindings.length).toBeGreaterThan(0);
  });
});

describe('viewer-smoke: real execution in a fake DOM/canvas (the actual browser code)', () => {
  test('sample fixture: map draws the system name, zooms into a component and a method, panel shows detail + VS Code link', () => {
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'), {
      fromRepo: path.join(__dirname, 'fixtures/sample'),
    });
    expect(model.drift).not.toBeNull();

    const h = runViewerScripts(html);
    expect(h.sandbox.C4PM_MAP).toBeDefined();

    // initial draw at the root level must label the system
    h.frames.flush();
    expect(h.fillTextLog.some(t => t.includes('sample-shop'))).toBe(true);

    // fly into the api container -> services component must be drawn
    const map = h.sandbox.C4PM_MAP as { flyTo: (id: string) => void; select: (id: string) => void; nodeById: (id: string) => unknown };
    expect(map.nodeById('api')).toBeDefined();
    h.fillTextLog.length = 0;
    map.flyTo('api');
    h.frames.runToCompletion();
    expect(h.fillTextLog.some(t => t.includes('Services'))).toBe(true);

    // fly into the OrderService class (the node that directly contains `create`) -> the "create"
    // method must be drawn. Targets the class, not its file: under the blueprint layout the class
    // is a small cell inside the file region, so only flying to the class fills the screen.
    expect(map.nodeById('api/src/services/orderService.ts#OrderService')).toBeDefined();
    h.fillTextLog.length = 0;
    map.flyTo('api/src/services/orderService.ts#OrderService');
    h.frames.runToCompletion();
    expect(h.fillTextLog.some(t => t.includes('create'))).toBe(true);

    // selecting the file node must populate the panel with its name and a working VS Code link
    map.select('api/src/services/orderService.ts');
    const panelText = serializeText(h.panel);
    expect(panelText).toContain('orderService.ts');
    expect(panelText).toContain('Open in VS Code');
    expect(panelText).toMatch(/vscode:\/\/file\//);
    expect(panelText).not.toMatch(/https?:\/\//);

    // a grown component in v2 must be marked on the map (drift overlay)
    const grownNode = map.nodeById('api/services') as { drift?: string } | undefined;
    expect(grownNode?.drift).toBe('grew');
  });

  test('phofast fixture: critical unplanned-code findings reach a file node and the panel', () => {
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/phofast'), { sprint: 'S15' });
    const unplanned = model.root.children
      .flatMap(c => c.children)
      .flatMap(c => c.children)
      .find(f => f.id === 'src/api/loyalty/points.ts');
    expect(unplanned?.findings?.some(f => f.rule === 'unplanned-code')).toBe(true);

    const h = runViewerScripts(html);
    h.frames.flush();
    expect(h.fillTextLog.length).toBeGreaterThan(0);

    const map = h.sandbox.C4PM_MAP as { select: (id: string) => void; nodeById: (id: string) => unknown };
    expect(map.nodeById('src/api/loyalty/points.ts')).toBeDefined();
    map.select(null as unknown as string);
    const summaryText = serializeText(h.panel);
    expect(summaryText).toMatch(/missing-code|unplanned-code|stub-in-done/);
  });

  test('search finds a function by name and flies to it', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample'));
    const h = runViewerScripts(html);
    h.frames.flush();

    const flownTo: string[] = [];
    const map = h.sandbox.C4PM_MAP as { flyTo: (id: string) => void; select: (id: string) => void };
    const originalFlyTo = map.flyTo.bind(map);
    map.flyTo = (id: string) => { flownTo.push(id); originalFlyTo(id); };

    h.search.value = 'create';
    h.search.dispatch('input', { target: h.search });
    const results = h.searchResults.querySelectorAll('.pn-search-result');
    expect(results.length).toBeGreaterThan(0);
    results[0].click();
    expect(flownTo.length).toBeGreaterThan(0);
  });

  test('empty-detail nodes (e.g. the system root) never draw a literal "[]"', () => {
    // bug-report item (e): drawClosed/drawHeader used to always render '[' + n.detail + ']',
    // producing a stray "[]" for nodes whose detail is '' (the system root is always one of these
    // — see view/model.ts's system node, which sets detail: '').
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample'));
    expect(model.root.detail).toBe('');

    const h = runViewerScripts(html);
    // initial draw is at the root/system level, zoomed out -> drawClosed runs for the root
    h.frames.flush();
    expect(h.fillTextLog.length).toBeGreaterThan(0);
    expect(h.fillTextLog).not.toContain('[]');

    // also exercise the open/header path for the root (drawHeader) by flying to a child so the
    // root becomes 'open' at some zoom level during the flight frames
    const map = h.sandbox.C4PM_MAP as { flyTo: (id: string) => void };
    map.flyTo('api');
    h.frames.runToCompletion();
    expect(h.fillTextLog).not.toContain('[]');
  });

  test('map.js header height for a container node matches what layoutView reserved for it', () => {
    // bug-report item (f): layout.ts's layoutNode and map.js's drawHeader used to independently
    // compute the header-height fraction, and could drift apart. layoutNode now stores the
    // reserved height on node.headerH; drawHeader reads it back instead of recomputing its own
    // formula. Verify the value layoutView actually set survives into the rendered data map.js runs on.
    const snapshot = runSnapshot({ repo: path.join(__dirname, 'fixtures/sample'), write: false, quiet: true });
    const meta = readMeta(path.join(__dirname, 'fixtures/sample'));
    const s = snapshot.stats;
    const u = s.unresolvedImports || 0;
    let model = buildViewModel(
      snapshot,
      `${meta.repoName} — ${s.containers} containers, ${s.components} components, ${s.files} files, ${s.codeElements} code elements, ${s.componentEdges} component edges, ${u} unresolved import${u !== 1 ? 's' : ''}`,
    );
    model = layoutView(model); // calling layout.ts's layoutNode (via layoutView) directly

    const container = model.root.children.find(c => c.kind === 'container');
    expect(container).toBeDefined();
    expect(container!.children.length).toBeGreaterThan(0); // must have children for headerH to be set
    // layout.ts's per-kind header constant (Phase 7 T2's grid layout) is the single source of
    // truth for this value -- there's nothing to independently recompute it against any more, so
    // this just takes what layoutView actually set and verifies it's a real, positive number,
    // then (below) that it survives into the browser-rendered data unchanged.
    expect(container!.headerH).toBeGreaterThan(0);
    const expectedHeaderH = container!.headerH!;

    // now render + run the browser code and confirm the same node, as map.js sees it via
    // C4PM_DATA/nodeById, carries that exact headerH value through to what drawHeader reads
    const html = renderViewHtml(model);
    const h = runViewerScripts(html);
    const mapApi = h.sandbox.C4PM_MAP as { nodeById: (id: string) => { headerH?: number } | undefined };
    const browserNode = mapApi.nodeById(container!.id);
    expect(browserNode).toBeDefined();
    expect(browserNode!.headerH).toBeCloseTo(expectedHeaderH, 6);
  });

  test('no uncaught exception and no network URLs across all fixtures', () => {
    const fixtures: Array<{ repo: string; opts?: { sprint?: string } }> = [
      { repo: path.join(__dirname, 'fixtures/sample') },
      { repo: path.join(__dirname, 'fixtures/phofast'), opts: { sprint: 'S15' } },
      { repo: path.join(__dirname, 'fixtures/pyshop') },
    ];
    for (const f of fixtures) {
      const snapshot = runSnapshot({ repo: f.repo, write: false, quiet: true, config: { languages: ['typescript', 'python'] } });
      const meta = readMeta(f.repo);
      const s = snapshot.stats;
      const u = s.unresolvedImports || 0;
      let model = buildViewModel(
        snapshot,
        `${meta.repoName} — ${s.containers} containers, ${s.components} components, ${s.files} files, ${s.codeElements} code elements, ${s.componentEdges} component edges, ${u} unresolved import${u !== 1 ? 's' : ''}`,
      );
      const c4Files = listC4Files(f.repo);
      if (c4Files.length > 0) {
        const plan = parsePlan(f.repo, c4Files);
        model = applyFindings(model, checkPlan(plan, snapshot, f.repo, { sprint: f.opts?.sprint }));
      }
      model = layoutView(model);
      const html = renderViewHtml(model);
      expect(html).not.toMatch(NO_URL_EXCEPT_CREDIT);   // b168: the one allowed URL is the credit link (a plain anchor, loads nothing)
      const h = runViewerScripts(html);
      h.frames.flush();
      expect(h.fillTextLog.length).toBeGreaterThan(0);
    }
  });

  // ---------- P7-T5: pan/zoom camera + edge glow, ported from the v0.3 mock ----------

  test('dragging the canvas pans the camera (map.state.cam.tx/ty move by the drag delta)', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample'));
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { state: { cam: { tx: number; ty: number } } };
    const before = { tx: map.state.cam.tx, ty: map.state.cam.ty };

    // a real pointerdown/move/up drag on the canvas, exercised through wirePointers -- not a
    // direct call into any camera helper.
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: 140, clientY: 125 });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: 140, clientY: 125 });

    expect(map.state.cam.tx).toBeCloseTo(before.tx + 40, 5);
    expect(map.state.cam.ty).toBeCloseTo(before.ty + 25, 5);
  });

  test('double-click flies to a node: the camera settles on fitCam(node) via a real double-click', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as {
      state: { cam: { s: number; tx: number; ty: number }; cw: number; ch: number };
      nodeById: (id: string) => ViewNode | undefined;
      flyTo: (id: string) => void;
    };

    // Get a component-level node into view first (same as the existing "zooms into a component"
    // test above), so the component is actually hit-testable at real alpha, then double-click it
    // for real through wirePointers -- this is what exercises dbl-tap detection + flyTo(fitCam(n)).
    map.flyTo('api');
    h.frames.runToCompletion();
    // P9-T3a: openness now eases ~25% per frame, so alpha (which hit-test/rep() read) lags the
    // camera; flush extra frames until the children have settled.
    for (let i = 0; i < 60; i++) h.frames.flush();

    const node = map.nodeById('api/services')!;
    expect(node).toBeDefined();
    const { s, tx, ty } = map.state.cam;
    const cx = node.x * s + tx + (node.w * s) / 2;
    const cy = node.y * s + ty + (node.h * s) / 2;

    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: cx, clientY: cy });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: cx, clientY: cy });
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: cx, clientY: cy });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: cx, clientY: cy });
    h.frames.runToCompletion();

    const { cw, ch } = map.state;
    const expectedS = Math.min((cw * 0.9) / node.w, (ch * 0.9) / node.h);
    const expectedTx = cw / 2 - (node.x + node.w / 2) * expectedS;
    const expectedTy = ch / 2 - (node.y + node.h / 2) * expectedS;

    expect(map.state.cam.s).toBeCloseTo(expectedS, 2);
    expect(map.state.cam.tx).toBeCloseTo(expectedTx, 1);
    expect(map.state.cam.ty).toBeCloseTo(expectedTy, 1);
  });

  test('P9-T3a: drawn rect _R lerps bubble->region by the eased openness; it reaches the region after flyTo', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();

    type Rect = { x: number; y: number; w: number; h: number };
    type N = ViewNode & { _R?: Rect; _tv?: number; bubble?: Rect };
    const map = h.sandbox.C4PM_MAP as {
      nodeById: (id: string) => N | undefined;
      flyTo: (id: string) => void;
      state: { cam: { s: number; tx: number; ty: number } };
    };
    const api = map.nodeById('api')!;
    expect(api.bubble).toBeDefined();

    // zoom out so the container covers < 45% of the screen (the root stays open): drawn as its bubble
    {
      const st = map.state as unknown as { cam: { s: number; tx: number; ty: number }; cw: number; ch: number };
      const k = 0.65;
      st.cam = { s: st.cam.s * k, tx: st.cw / 2 - (st.cw / 2 - st.cam.tx) * k, ty: st.ch / 2 - (st.ch / 2 - st.cam.ty) * k };
      (map as unknown as { draw: () => void }).draw();
      for (let i = 0; i < 60; i++) h.frames.flush();
    }
    expect(api._tv).toBe(0);
    // I19b: api is at the bean-width floor (region w == bubble w, arrange regionScaleFor), so the lerp shows in height only
    expect(api._R!.h).toBeLessThan(api.h * map.state.cam.s);
    expect(api._R!.w).toBeCloseTo(api.bubble!.w * map.state.cam.s, 5);

    // flyTo the container: the eased value must reach its target (1) within a bounded number of frames
    map.flyTo('api');
    h.frames.runToCompletion();
    let frames = 0;
    while (api._tv !== 1 && frames < 60) { h.frames.flush(); frames++; }
    expect(api._tv).toBe(1);
    expect(frames).toBeLessThan(40);

    // settled: drawn rect equals the region on screen
    const { s, tx, ty } = map.state.cam;
    expect(api._R!.x).toBeCloseTo(api.x * s + tx, 5);
    expect(api._R!.y).toBeCloseTo(api.y * s + ty, 5);
    expect(api._R!.w).toBeCloseTo(api.w * s, 5);
    expect(api._R!.h).toBeCloseTo(api.h * s, 5);
  });

  // ---------- P9-T3b: hit test + edge endpoints on the drawn rect, Up reaches C1 ----------

  type Rect9 = { x: number; y: number; w: number; h: number };
  type N9 = ViewNode & { _R?: Rect9; _tv?: number; bubble?: Rect9 };
  interface Map9 {
    nodeById: (id: string) => N9 | undefined;
    flyTo: (id: string) => void;
    setOverlay: (name: string, on: boolean) => void;
    draw: () => void;
    onSelect: (fn: (n: ViewNode | null) => void) => void;
    state: { cam: { s: number; tx: number; ty: number }; cw: number; ch: number; selectedId: string | null };
  }
  const click9 = (h: HarnessResult, x: number, y: number) => {
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x, clientY: y });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y });
  };
  // flyTo, then settle: easing makes alpha/_tv lag the camera by ~20 frames
  const settle9 = (h: HarnessResult) => {
    h.frames.runToCompletion();
    for (let i = 0; i < 60; i++) h.frames.flush();
  };

  test('P9-T3b: a click in the gap between two bubbles selects the parent blueprint', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Map9;
    map.flyTo('api');
    settle9(h);

    const api = map.nodeById('api')!;
    expect(api._tv).toBe(1);
    const kids = api.children.map(c => map.nodeById(c.id)!);
    // components are drawn as small bubbles inside the open container
    const closed = kids.filter(k => k._tv === 0 && k.bubble && k.bubble.w < k.w);
    expect(closed.length).toBeGreaterThan(1);

    // 1px inside a child's REGION top edge: inside the region (old behaviour picked the child), outside its bubble.
    // I19b: the probe moved from the left edge to the top edge; a closed child at the bean-width floor has no
    // horizontal margin (region w == bubble w), but it keeps a vertical margin (bubble centred in its region).
    const { s, tx, ty } = map.state.cam;
    const k = closed[0];
    const gx = k.x * s + tx + (k.w * s) / 2;
    const gy = k.y * s + ty + 1;
    expect(kids.some(o => gx >= o._R!.x && gx <= o._R!.x + o._R!.w && gy >= o._R!.y && gy <= o._R!.y + o._R!.h)).toBe(false);

    const picked: string[] = [];
    map.onSelect(n => { if (n) picked.push(n.id); });
    click9(h, gx, gy);
    expect(picked).toEqual(['api']);

    // sanity: the centre of that child's bubble still selects the child
    click9(h, k._R!.x + k._R!.w / 2, k._R!.y + k._R!.h / 2);
    expect(picked).toEqual(['api', k.id]);
  });

  test('P9-T3b: an edge endpoint lies on the bubble border, not the region border', () => {
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Map9;
    map.setOverlay('stubs', false); // the stub hatch also uses moveTo/lineTo
    map.flyTo('api');
    settle9(h);

    h.pathLog.length = 0;
    map.draw();

    const eps = 0.01;
    const onBorder = (p: { x: number; y: number }, R: Rect9) => {
      const inX = p.x >= R.x - eps && p.x <= R.x + R.w + eps, inY = p.y >= R.y - eps && p.y <= R.y + R.h + eps;
      return (inY && (Math.abs(p.x - R.x) < eps || Math.abs(p.x - R.x - R.w) < eps)) ||
        (inX && (Math.abs(p.y - R.y) < eps || Math.abs(p.y - R.y - R.h) < eps));
    };
    const ids: string[] = [];
    const walk = (n: ViewNode) => { ids.push(n.id); n.children.forEach(walk); };
    walk(model.root);
    const { s, tx, ty } = map.state.cam;
    const nodes = ids.map(id => map.nodeById(id)!).filter(n => n._R && (n._tv === 0) && n.bubble && n.bubble.w < n.w);
    const regionOf = (n: N9): Rect9 => ({ x: n.x * s + tx, y: n.y * s + ty, w: n.w * s, h: n.h * s });

    // an edge line is a moveTo immediately followed by a lineTo to a different point; its first
    // point must sit on some closed bubble's drawn border and not on that node's region border
    let checked = 0;
    for (let i = 0; i + 1 < h.pathLog.length; i++) {
      const a = h.pathLog[i], b = h.pathLog[i + 1];
      if (a.op !== 'moveTo' || b.op !== 'lineTo' || h.pathLog[i + 2]?.op === 'lineTo') continue; // arrow heads have 2 lineTo
      const owner = nodes.find(n => onBorder(a, n._R!));
      if (!owner) continue;
      expect(onBorder(a, regionOf(owner))).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('P9-T3b: Up at the top zooms out until the root is closed into one bubble (C1)', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Map9;
    const root = map.nodeById(JSON.parse(html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/)![1]).root.id)! as N9;
    expect(root._tv).toBe(1); // starts open at the fit

    const up = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('btn-up') as FakeEl & { onclick?: () => void };
    for (let i = 0; i < 3 && root._tv !== 0; i++) { up.onclick!(); settle9(h); } // each Up climbs one level

    const { cw, ch } = map.state;
    const expectedS = Math.min(cw * 0.3 / root.w, ch * 0.3 / root.h);
    expect(map.state.cam.s).toBeCloseTo(expectedS, 3);
    expect(root._tv).toBe(0);
    expect(root._R!.w).toBeCloseTo(root.bubble!.w * map.state.cam.s, 3);
    // root closed (_tv 0) means focusNode() is null; the HUD reads the C1 level and nothing is hit below the root
    const hud = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('hud-level');
    expect(hud.textContent).toContain('C1');
    const picked: string[] = [];
    map.onSelect(n => { if (n) picked.push(n.id); });
    click9(h, root._R!.x + root._R!.w / 2, root._R!.y + root._R!.h / 2);
    expect(picked).toEqual([root.id]);
  });

  test('selecting a component glows its real component-level edges (cyan outgoing, magenta incoming)', () => {
    // "api/routes" (sample-v2 fixture) has both an outgoing edge (-> api/payments / api/services
    // / api/utils) and an incoming one (<- api/_root / api/services) in model.edges -- real
    // ViewEdge data, component-level, there is no function-level call graph yet (Decision §0.1).
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    expect(model.edges.some(e => e.from === 'api/routes')).toBe(true);
    expect(model.edges.some(e => e.to === 'api/routes')).toBe(true);

    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { flyTo: (id: string) => void; select: (id: string) => void };
    // Zoom into the container first so the sibling components are individually visible (alpha
    // >= 0.5) -- otherwise rep() rolls every edge up to the container itself and drawEdges has
    // nothing distinct to glow, same as the mock's own behavior at the container level.
    map.flyTo('api');
    h.frames.runToCompletion();
    // P9-T3a: openness now eases ~25% per frame, so alpha (which hit-test/rep() read) lags the
    // camera; flush extra frames until the children have settled.
    for (let i = 0; i < 60; i++) h.frames.flush();

    h.strokeLog.length = 0;
    map.select('api/routes');
    h.frames.flush();

    expect(h.strokeLog).toContain('#36E2C9'); // cyan: edge leaving api/routes
    expect(h.strokeLog).toContain('#F05FD0'); // magenta: edge entering api/routes
  });

  test('P9-T9b: unselected edges use --edge at >=2px (not muted/1.4); selection keeps glow and dims the rest', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    settle9(h);
    const map = h.sandbox.C4PM_MAP as Map9;
    map.flyTo('api');
    settle9(h);
    const draw = () => { h.opLog.length = 0; (map as unknown as { draw: () => void }).draw(); return h.opLog.filter(o => o.op === 'stroke'); };
    const EDGE = '#E10004', MUTED = '#B30003', CYAN = '#36E2C9', MAG = '#F05FD0';

    const plain = draw().filter(o => o.style === EDGE);
    expect(plain.length).toBeGreaterThan(0);
    plain.forEach(o => { expect(o.lineWidth).toBeGreaterThanOrEqual(2); expect(o.alpha).toBeGreaterThan(0.9); });
    expect(draw().some(o => o.style === MUTED && o.lineWidth === 1.4)).toBe(false);

    (map as unknown as { select: (id: string) => void }).select('api/routes');
    const sel = draw();
    expect(sel.some(o => o.style === CYAN)).toBe(true);
    expect(sel.some(o => o.style === MAG)).toBe(true);
    sel.filter(o => o.style === CYAN || o.style === MAG).forEach(o => expect(o.alpha).toBeGreaterThan(0.9));
    const dimmed = sel.filter(o => o.style === EDGE);
    expect(dimmed.length).toBeGreaterThan(0);
    dimmed.forEach(o => expect(o.alpha).toBeCloseTo(0.25));
  });

  test('a shared/unassigned node renders with the dashed-border "needs attention" treatment', () => {
    // No existing fixture's .c4 plan uses real function-level claims (every fixture's links are
    // file/folder/line-range), so no fixture repo actually produces claim-mode 'shared'/
    // 'unassigned' ViewNodes today. Building the ViewModel by hand here, using exactly the real
    // ViewNode shape buildSharedUnassignedNodes (src/view/model.ts) produces, tests the real
    // dashed-border code path without inventing a fixture .c4 file just to reach it.
    const leafCalls = { callsAvailable: false } as const;
    const sharedFn: ViewNode = {
      id: 'src/util.ts#helper', kind: 'function', name: 'helper', detail: '3 lines', weight: 3,
      children: [], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const unassignedFn: ViewNode = {
      id: 'src/dead.ts#deadCode', kind: 'function', name: 'deadCode', detail: '2 lines', weight: 2,
      children: [], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
      findings: [{ severity: 'critical', rule: 'unassigned-code', message: 'no component claims it and nothing calls it' }],
    };
    const sharedNode: ViewNode = {
      id: 'sys::shared', kind: 'shared', name: 'Shared', detail: '1 shared function', weight: 3,
      children: [sharedFn], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const unassignedNode: ViewNode = {
      id: 'sys::unassigned', kind: 'unassigned', name: 'Unassigned', detail: '1 unassigned function', weight: 2,
      children: [unassignedFn], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const root: ViewNode = {
      id: 'sys', kind: 'system', name: 'TestSys', detail: '', weight: 5,
      children: [sharedNode, unassignedNode], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    let model: ViewModel = {
      schemaVersion: 1, title: 'TestSys', subtitle: 'synthetic', summary: '',
      repoPath: '/tmp/test', root, edges: [], drift: null, planFindings: [], files: [],
    };
    model = layoutView(model);
    const html = renderViewHtml(model);

    const h = runViewerScripts(html);
    h.frames.flush();

    expect(h.strokeLog).toContain('#E7B24A'); // amber: shared-auto dashed border
    expect(h.strokeLog).toContain('#F07A6C'); // red: unassigned dashed border
  });

  test('P14-I18: HUD level names a shared or unassigned focus "Code", not "C1 · System"', () => {
    // Same hand-built model as the dashed-border test above (buildSharedUnassignedNodes shape).
    const leafCalls = { callsAvailable: false } as const;
    const sharedFn: ViewNode = {
      id: 'src/util.ts#helper', kind: 'function', name: 'helper', detail: '3 lines', weight: 3,
      children: [], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const unassignedFn: ViewNode = {
      id: 'src/dead.ts#deadCode', kind: 'function', name: 'deadCode', detail: '2 lines', weight: 2,
      children: [], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
      findings: [{ severity: 'critical', rule: 'unassigned-code', message: 'no component claims it and nothing calls it' }],
    };
    const sharedNode: ViewNode = {
      id: 'sys::shared', kind: 'shared', name: 'Shared', detail: '1 shared function', weight: 3,
      children: [sharedFn], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const unassignedNode: ViewNode = {
      id: 'sys::unassigned', kind: 'unassigned', name: 'Unassigned', detail: '1 unassigned function', weight: 2,
      children: [unassignedFn], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const root: ViewNode = {
      id: 'sys', kind: 'system', name: 'TestSys', detail: '', weight: 5,
      children: [sharedNode, unassignedNode], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    let model: ViewModel = {
      schemaVersion: 1, title: 'TestSys', subtitle: 'synthetic', summary: '',
      repoPath: '/tmp/test', root, edges: [], drift: null, planFindings: [], files: [],
    };
    model = layoutView(model);
    const html = renderViewHtml(model);

    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as unknown as {
      nodeById: (id: string) => ViewNode & { x: number; y: number; w: number; h: number } | undefined;
      state: { cam: { s: number; tx: number; ty: number }; cw: number; ch: number };
      draw: () => void;
    };
    const cam = h.sandbox.C4PM_CAM as { focusNode: () => { id: string } | null };
    const hud = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('hud-level');

    // Camera set directly (flyTo runs on requestAnimationFrame, which the fake frame queue does not drive here).
    for (const id of ['sys::shared', 'sys::unassigned']) {
      const n = map.nodeById(id)!;
      const { cw, ch } = map.state;
      const s = Math.min(cw / n.w, ch / n.h) * 0.9;
      map.state.cam = { s, tx: cw / 2 - (n.x + n.w / 2) * s, ty: ch / 2 - (n.y + n.h / 2) * s };
      map.draw();
      // precondition first: the HUD test is only meaningful if this node is the focus
      expect(cam.focusNode()?.id).toBe(id);
      expect(hud.textContent).not.toBe('C1 · System');
      expect(hud.textContent).toBe('Code');
    }
  });

  test('P9-T4a: a selected node with a critical finding still draws both its red dashed outline and accent outline', () => {
    const leafCalls = { callsAvailable: false } as const;
    const bad: ViewNode = {
      id: 'sys::bad', kind: 'unassigned', name: 'Bad', detail: '', weight: 2,
      children: [], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
      findings: [{ severity: 'critical', rule: 'unassigned-code', message: 'x' }],
    };
    const root: ViewNode = {
      id: 'sys', kind: 'system', name: 'TestSys', detail: '', weight: 2,
      children: [bad], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    let model: ViewModel = {
      schemaVersion: 1, title: 'TestSys', subtitle: 's', summary: '',
      repoPath: '/tmp/test', root, edges: [], drift: null, planFindings: [], files: [],
    };
    model = layoutView(model);
    const h = runViewerScripts(renderViewHtml(model));
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as { select: (id: string) => void };
    map.select('sys::bad');
    h.strokeLog.length = 0;
    h.frames.flush();
    const iRed = h.strokeLog.indexOf('#FE0001');
    const iAccent = h.strokeLog.indexOf('#ACC0FF');
    expect(iRed).toBeGreaterThanOrEqual(0);    // critical-findings dashed outline
    expect(iAccent).toBeGreaterThan(iRed);     // selected accent outline, drawn after findings
  });

  // Builds sys > bad(unassigned, critical finding) > [leaf] so 'bad' can be opened as a region.
  function buildBadWithChild(): string {
    const leafCalls = { callsAvailable: false } as const;
    const leaf: ViewNode = {
      id: 'sys::bad#leaf', kind: 'function', name: 'leaf', detail: '1 line', weight: 1,
      children: [], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    const bad: ViewNode = {
      id: 'sys::bad', kind: 'unassigned', name: 'Bad', detail: '', weight: 2,
      children: [leaf], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
      findings: [{ severity: 'critical', rule: 'unassigned-code', message: 'x' }],
    };
    const root: ViewNode = {
      id: 'sys', kind: 'system', name: 'TestSys', detail: '', weight: 2,
      children: [bad], x: 0, y: 0, w: 0, h: 0, ...leafCalls,
    };
    let model: ViewModel = {
      schemaVersion: 1, title: 'TestSys', subtitle: 's', summary: '',
      repoPath: '/tmp/test', root, edges: [], drift: null, planFindings: [], files: [],
    };
    model = layoutView(model);
    return renderViewHtml(model);
  }

  test('P9-T4b: the same overlays are drawn on an OPEN region (accent border + red dashed outline + accent outline)', () => {
    const h = runViewerScripts(buildBadWithChild());
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Map9 & { select: (id: string) => void };
    map.flyTo('sys::bad');
    settle9(h);
    expect(map.nodeById('sys::bad')!._tv).toBe(1);
    map.select('sys::bad');
    h.strokeLog.length = 0;
    h.frames.flush(); // the frame select() queued
    const iRed = h.strokeLog.indexOf('#FE0001');
    expect(iRed).toBeGreaterThanOrEqual(0);                     // critical-findings dashed outline
    expect(h.strokeLog.lastIndexOf('#ACC0FF')).toBeGreaterThan(iRed); // selected accent outline after findings
  });

  test('P9-T4b: one frame draws region fills, then edges, then bubble fills (3 passes)', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    settle9(h);
    const map = h.sandbox.C4PM_MAP as Map9;
    map.flyTo('api');
    settle9(h);
    // zoomed into 'api': its component bubbles/regions and the root-level edges. Pick the zoom
    // where the api container is open (blueprint) and has component bubbles with edges between them.
    h.opLog.length = 0;
    (map as unknown as { draw: () => void }).draw(); // exactly one frame
    const BP = '#B10001', EDGE = '#E10004', BUBBLE = '#888888';
    const lastRegionFill = h.opLog.map(o => o.op === 'fill' && o.style === BP).lastIndexOf(true);
    const firstEdge = h.opLog.findIndex(o => o.op === 'stroke' && o.style === EDGE);
    const firstBubbleFill = h.opLog.findIndex((o, i) => o.op === 'fill' && o.style === BUBBLE && i > lastRegionFill);
    expect(lastRegionFill).toBeGreaterThanOrEqual(0);
    expect(firstEdge).toBeGreaterThan(lastRegionFill);
    expect(firstBubbleFill).toBeGreaterThan(firstEdge);
  });

  // ---------- P13-T5: tree-facing API (select without camera move, selectedId, ancestorsOf, multi onSelect) ----------

  interface Api13 extends Map9 {
    select: (id: string | null) => boolean;
    selectedId: () => string | null;
    ancestorsOf: (id: string) => string[];
  }
  const NESTED13 = 'api/src/services/orderService.ts#OrderService';

  test('P13-T5: select(id) notifies every subscriber, leaves the camera alone; unknown id is a no-op; null clears', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Api13;
    const a: Array<string | null> = [], b: Array<string | null> = [];
    map.onSelect(n => a.push(n ? n.id : null));
    map.onSelect(n => b.push(n ? n.id : null));
    expect(map.selectedId()).toBeNull();

    const cam = { ...map.state.cam };
    expect(map.select(NESTED13)).toBe(true);
    expect(a).toEqual([NESTED13]);
    expect(b).toEqual([NESTED13]);
    expect(map.selectedId()).toBe(NESTED13);
    expect(map.state.selectedId).toBe(NESTED13);
    settle9(h);
    expect(map.state.cam).toEqual(cam); // no camera movement, even after frames ran

    expect(map.select('nope')).toBe(false);
    expect(a).toEqual([NESTED13]); // no notification
    expect(map.selectedId()).toBe(NESTED13); // unchanged

    expect(map.select(null)).toBe(true);
    expect(a).toEqual([NESTED13, null]);
    expect(b).toEqual([NESTED13, null]);
    expect(map.selectedId()).toBeNull();
  });

  test('P13-T5: selectedId() reflects a real canvas click', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Api13;
    const root = map.nodeById(JSON.parse(html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/)![1]).root.id)! as N9;
    const up = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('btn-up') as FakeEl & { onclick?: () => void };
    for (let i = 0; i < 3 && root._tv !== 0; i++) { up.onclick!(); settle9(h); }
    expect(map.selectedId()).toBeNull();
    click9(h, root._R!.x + root._R!.w / 2, root._R!.y + root._R!.h / 2);
    expect(map.selectedId()).toBe(root.id);
  });

  test('P13-T5: ancestorsOf lists root-first ids excluding the node; [] for root and unknown', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    const map = h.sandbox.C4PM_MAP as Api13;
    const rootId = JSON.parse(html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/)![1]).root.id as string;
    const anc = map.ancestorsOf(NESTED13);
    expect(anc[0]).toBe(rootId);
    expect(anc).toContain('api');
    expect(anc).not.toContain(NESTED13);
    expect(anc.length).toBeGreaterThanOrEqual(2);
    // each id is the parent of the next, and the last is the node's parent
    const chain = [...anc, NESTED13];
    for (let i = 1; i < chain.length; i++) {
      const node = map.nodeById(chain[i]) as unknown as { parent?: { id: string } }; // parent is set by the viewer at load
      expect(node.parent!.id).toBe(chain[i - 1]);
    }
    expect(map.ancestorsOf(rootId)).toEqual([]);
    expect(map.ancestorsOf('nope')).toEqual([]);
  });

  // ---------- P9-T5: Auto level toggle ----------

  interface Auto9 extends Map9 {
    setAutoLevel: (on: boolean) => void;
    state: Map9['state'] & { autoLevel: boolean; lockDepth: number; cam: { s: number; tx: number; ty: number } };
  }
  // zoom out about the screen centre by k (as the demo screenshot script set map.state.cam), then settle
  const zoomOut9 = (h: HarnessResult, map: Auto9, k: number) => {
    const { cw, ch, cam } = map.state;
    map.state.cam = { s: cam.s * k, tx: cw / 2 - (cw / 2 - cam.tx) * k, ty: ch / 2 - (ch / 2 - cam.ty) * k };
    map.draw();
    for (let i = 0; i < 60; i++) h.frames.flush();
  };

  test('P9-T5: lock at the container level, zoom out 0.45x: every container stays open; with auto ON they close', () => {
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const containers = model.root.children.filter(c => c.kind === 'container' && c.children.length > 0).map(c => c.id);
    expect(containers.length).toBeGreaterThan(1);

    const run = (lock: boolean) => {
      const h = runViewerScripts(html);
      h.frames.flush();
      const map = h.sandbox.C4PM_MAP as Auto9;
      map.flyTo('api');
      settle9(h);
      expect(map.state.lockDepth).toBe(-1);
      if (lock) {
        map.setAutoLevel(false);
        expect(map.state.autoLevel).toBe(false);
        expect(map.state.lockDepth).toBe(1); // focus = the api container (depth 1)
      }
      zoomOut9(h, map, 0.45);
      return containers.map(id => map.nodeById(id)!._tv);
    };

    expect(run(true).every(t => t === 1)).toBe(true);
    expect(run(false).every(t => t === 0)).toBe(true);
  });

  test('P9-T5: toggling back ON releases the lock; button aria-pressed and HUD follow the state', () => {
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Auto9;
    const doc = h.sandbox.document as { getElementById: (id: string) => FakeEl };
    const btn = doc.getElementById('btn-auto') as FakeEl & { onclick?: () => void };
    const sub = doc.getElementById('hud-sub');
    expect(html).toMatch(/id="btn-auto" aria-pressed="true"/); // fake DOM does not parse markup: initial state is in the HTML

    map.flyTo('api');
    settle9(h);
    btn.onclick!(); // the real button handler
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(map.state.autoLevel).toBe(false);
    settle9(h);
    expect(sub.textContent).toContain('level locked');

    zoomOut9(h, map, 0.45);
    const containers = model.root.children.filter(c => c.kind === 'container' && c.children.length > 0);
    expect(containers.every(c => map.nodeById(c.id)!._tv === 1)).toBe(true);

    map.setAutoLevel(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    zoomOut9(h, map, 1); // let it re-ease with zoom deciding again
    expect(containers.every(c => map.nodeById(c.id)!._tv === 0)).toBe(true);
    expect(sub.textContent).toBe('');
  });

  test('P9-T5: while locked, Up moves the lock to the parent level (top -> -1) and a double-click dive sets it to the dived node', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Auto9;
    const up = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('btn-up') as FakeEl & { onclick?: () => void };

    map.flyTo('api/services');
    settle9(h);
    expect((map.nodeById('api/services') as N9 & { depth: number }).depth).toBe(2);
    map.setAutoLevel(false);
    expect(map.state.lockDepth).toBe(2);

    up.onclick!(); // focus = services -> parent = api (depth 1)
    expect(map.state.lockDepth).toBe(1);
    settle9(h);
    up.onclick!(); // focus = api -> parent = root (depth 0)
    expect(map.state.lockDepth).toBe(0);
    settle9(h);
    up.onclick!(); // top: C1 view
    expect(map.state.lockDepth).toBe(-1);

    // dive: put the camera on the api container, then double-click a component region inside it
    map.setAutoLevel(true);
    map.flyTo('api');
    settle9(h);
    map.setAutoLevel(false);
    const node = map.nodeById('api/services')!;
    const { s, tx, ty } = map.state.cam;
    const cx = node.x * s + tx + (node.w * s) / 2, cy = node.y * s + ty + (node.h * s) / 2;
    click9(h, cx, cy);
    click9(h, cx, cy);
    expect(map.state.lockDepth).toBe(node.children.length ? 2 : 1);
    // the first click of the pair selected the intended node (what hitTest returned at that point)
    expect(map.state.selectedId).toBe('api/services');
  });

  test('P9-T5b: public flyTo follows the level lock: locked it opens the target (parent for a leaf); auto ON opens only by zoom', () => {
    const { model, html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    type M = { id: string; children: M[] };
    const comps: M[] = [];
    const walk = (n: M, d: number) => { if (d >= 2 && n.children.length) comps.push(n); n.children.forEach(c => walk(c, d + 1)); };
    walk(model.root as unknown as M, 0);
    expect(comps.length).toBeGreaterThan(0);
    const target = comps[0].id;

    // locked at the top level: before the fix the target stayed closed (openness follows lockDepth)
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as Auto9;
    map.setAutoLevel(false);
    map.flyTo(target);
    for (let i = 0; i < 60; i++) h.frames.flush();
    const node = map.nodeById(target) as N9 & { depth: number };
    expect(map.state.lockDepth).toBe(node.depth);
    expect(node._tv).toBe(1);

    // leaf: the lock goes to its parent's level so the parent opens and the leaf shows
    const leaf = (model.root.children[0].children.find(c => c.children.length === 0) ?? null);
    if (leaf) {
      map.flyTo(leaf.id);
      for (let i = 0; i < 60; i++) h.frames.flush();
      const ln = map.nodeById(leaf.id) as N9 & { parent: { depth: number; _tv?: number } };
      expect(map.state.lockDepth).toBe(ln.parent.depth);
      expect(ln.parent._tv).toBe(1);
    }

    // auto ON: flyTo never touches the lock
    const h2 = runViewerScripts(html);
    h2.frames.flush();
    const map2 = h2.sandbox.C4PM_MAP as Auto9;
    map2.flyTo(target);
    for (let i = 0; i < 60; i++) h2.frames.flush();
    expect(map2.state.lockDepth).toBe(-1);
  });
});

// ---------- P10-T1b: edit layout mode wired into the map (move, resize, reset) ----------
describe('viewer edit layout mode (P10-T1b)', () => {
  type R = { x: number; y: number; w: number; h: number };
  interface EN extends R { id: string; _R?: R; _tv?: number; bubble?: R; bubbleMoved?: boolean; parent?: EN; children: EN[] }
  interface EMap {
    nodeById: (id: string) => EN | undefined;
    flyTo: (id: string) => void;
    setEdit: (on: boolean) => void;
    state: { cam: { s: number; tx: number; ty: number }; edit: boolean; selectedId: string | null };
  }
  const setup = () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as EMap;
    map.flyTo('api');
    h.frames.runToCompletion();
    for (let i = 0; i < 60; i++) h.frames.flush();
    return { h, map, html };
  };
  const drag = (h: HarnessResult, x0: number, y0: number, x1: number, y1: number) => {
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x0, clientY: y0 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: x1, clientY: y1 });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x1, clientY: y1 });
  };
  const click9 = (h: HarnessResult, x: number, y: number) => {
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x, clientY: y });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y });
  };
  const rect = (n: EN) => ({ x: n.x, y: n.y, w: n.w, h: n.h });
  const all = (n: EN): EN[] => [n, ...n.children.flatMap(all)];

  // P14-I9 (replaces "dragging a closed bubble moves only its bubble, marks it user-placed, and leaves region and
  // descendants"): in the two-phase tree the bean is the region's slot, so a closed-bubble drag moves the whole node.
  test('dragging a closed bubble moves its node, region, descendants and bubble by one delta, marks only it user-placed, and leaves siblings', () => {
    const { h, map } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    const k = api.children.find(c => c._tv === 0 && c.bubble && c.children.length > 0) ?? api.children.find(c => c._tv === 0 && c.bubble)!;
    expect(k).toBeDefined();
    const group = all(k);
    const siblings = api.children.filter(c => c !== k);
    const before = group.map(n => ({ ...rect(n), b: n.bubble ? { ...n.bubble } : null }));
    const siblingsBefore = siblings.map(rect);
    const { s } = map.state.cam;
    const cx = k._R!.x + k._R!.w / 2, cy = k._R!.y + k._R!.h / 2;
    drag(h, cx, cy, cx + 30, cy + 12);
    group.forEach((n, i) => {
      expect(n.x - before[i].x).toBeCloseTo(30 / s, 5);
      expect(n.y - before[i].y).toBeCloseTo(12 / s, 5);
      expect(n.w).toBe(before[i].w);
      expect(n.h).toBe(before[i].h);
      if (n.bubble) {
        expect(n.bubble.x - before[i].b!.x).toBeCloseTo(30 / s, 5);
        expect(n.bubble.y - before[i].b!.y).toBeCloseTo(12 / s, 5);
      }
      expect(!!n.bubbleMoved).toBe(n === k);
    });
    expect(siblings.map(rect)).toEqual(siblingsBefore);
  });

  // P14-I9 (replaces "dragging an open region header moves region, descendants and the node bubble (offset kept)"):
  // the header drag moves the whole node by one delta, and a moved new-tree node is marked user-placed.
  test('dragging an open region header moves its region, descendants and bubble by one delta, marks it user-placed, and leaves siblings', () => {
    const { h, map } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    const group = all(api);
    const siblings = api.parent!.children.filter(c => c !== api);
    const before = group.map(n => ({ ...rect(n), b: n.bubble ? { ...n.bubble } : null }));
    const siblingsBefore = siblings.map(rect);
    const { s } = map.state.cam;
    const hx = api._R!.x + api._R!.w / 2, hy = api._R!.y + 4;
    drag(h, hx, hy, hx + 24, hy + 10);
    group.forEach((n, i) => {
      expect(n.x - before[i].x).toBeCloseTo(24 / s, 5);
      expect(n.y - before[i].y).toBeCloseTo(10 / s, 5);
      expect(n.w).toBe(before[i].w);
      expect(n.h).toBe(before[i].h);
      if (n.bubble) {
        expect(n.bubble.x - before[i].b!.x).toBeCloseTo(24 / s, 5);
        expect(n.bubble.y - before[i].b!.y).toBeCloseTo(10 / s, 5);
      }
      expect(!!n.bubbleMoved).toBe(n === api);
    });
    expect(siblings.map(rect)).toEqual(siblingsBefore);
  });

  // b268 (replaces the P14-I9 "no resize grip" test): an open two-phase region has a right-edge grip; dragging it
  // changes only its width, by the drag delta in world units.
  test('an open region right edge is a resize grip: dragging it changes w only, by the world delta', () => {
    const { h, map } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    expect(api._tv).toBe(1);
    const w0 = api.w, h0 = api.h, x0 = api.x;
    const ex = api._R!.x + api._R!.w, ey = api._R!.y + api._R!.h / 2;
    const edit = (h.sandbox as unknown as { C4PM_EDIT: { editTarget: (p: { x: number; y: number }, open: EN[], hit: EN | null, cam: { s: number; tx: number; ty: number }) => { type: string; rx: boolean } | null } }).C4PM_EDIT;
    const t = edit.editTarget({ x: ex, y: ey }, [api], api, map.state.cam);
    expect(t).toMatchObject({ type: 'resize', rx: true });
    drag(h, ex, ey, ex + 40, ey);
    expect(api.w).toBeCloseTo(w0 + 40 / map.state.cam.s, 5);
    expect(api.h).toBe(h0);
    expect(api.x).toBe(x0);
  });

  test('with edit OFF the same drag pans the camera and moves nothing', () => {
    const { h, map } = setup();
    const api = map.nodeById('api')!;
    const k = api.children.find(c => c._tv === 0 && c.bubble)!;
    const before = all(api).map(rect);
    const cam = { ...map.state.cam };
    const cx = k._R!.x + k._R!.w / 2, cy = k._R!.y + k._R!.h / 2;
    drag(h, cx, cy, cx + 30, cy + 12);
    expect(map.state.cam.tx).toBeCloseTo(cam.tx + 30, 5);
    expect(map.state.cam.ty).toBeCloseTo(cam.ty + 12, 5);
    expect(all(api).map(rect)).toEqual(before);
  });

  test('edit ON: empty space still pans, and a click with no movement still selects', () => {
    const { h, map } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    const cam = { ...map.state.cam };
    const k = api.children.find(c => c._tv === 0 && c.bubble)!;
    click9(h, k._R!.x + k._R!.w / 2, k._R!.y + k._R!.h / 2);
    expect(map.state.selectedId).toBe(k.id);
    expect(rect(k)).toEqual(rect(map.nodeById(k.id)!));
    // outside the root entirely: nothing to edit -> pan
    drag(h, 2, 2, 22, 12);
    expect(map.state.cam.tx).toBeCloseTo(cam.tx + 20, 5);
    expect(map.state.cam.ty).toBeCloseTo(cam.ty + 10, 5);
  });

  test('Reset layout restores the original rects after move and resize', () => {
    const { h, map } = setup();
    const doc = h.sandbox.document as { getElementById: (id: string) => FakeEl & { onclick?: () => void; hidden?: boolean } };
    const api = map.nodeById('api')!;
    const root = api.parent!;
    const orig = all(root).map(n => ({ n, r: rect(n), b: n.bubble ? { ...n.bubble } : null }));
    map.setEdit(true);
    const k = api.children.find(c => c._tv === 0 && c.bubble)!;
    const cx = k._R!.x + k._R!.w / 2, cy = k._R!.y + k._R!.h / 2;
    drag(h, cx, cy, cx + 60, cy + 40);
    const ex = api._R!.x + api._R!.w, ey = api._R!.y + api._R!.h / 2;
    drag(h, ex, ey, ex + 50, ey);
    expect(orig.some(o => rect(o.n).x !== o.r.x || rect(o.n).w !== o.r.w)).toBe(true);
    doc.getElementById('btn-reset').onclick!();
    orig.forEach(o => {
      expect(rect(o.n)).toEqual(o.r);
      expect(o.n.bubble ? { ...o.n.bubble } : null).toEqual(o.b);
    });
  });

  test('Edit button flips aria-pressed, shows/hides Reset and swaps the hint', () => {
    const { h, map, html } = setup();
    const doc = h.sandbox.document as { getElementById: (id: string) => FakeEl & { onclick?: () => void; hidden?: boolean } };
    const btn = doc.getElementById('btn-edit'), reset = doc.getElementById('btn-reset'), hint = doc.getElementById('hud-bl');
    expect(html).toMatch(/id="btn-edit" aria-pressed="false"/);
    expect(html).toMatch(/id="btn-reset" hidden/);
    hint.textContent = 'default hint';
    btn.onclick!();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(reset.hidden).toBe(false);
    expect(map.state.edit).toBe(true);
    expect(hint.textContent).toMatch(/^Edit:/);
    btn.onclick!();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(reset.hidden).toBe(true);
    expect(hint.textContent).toBe('default hint');
  });
});

// ---------- P10-T1c: undo / redo ----------
describe('viewer undo/redo (P10-T1c)', () => {
  type R = { x: number; y: number; w: number; h: number };
  interface EN extends R { id: string; _R?: R; _tv?: number; bubble?: R; bubbleMoved?: boolean; parent?: EN; children: EN[] }
  interface EMap {
    nodeById: (id: string) => EN | undefined;
    flyTo: (id: string) => void;
    setEdit: (on: boolean) => void;
    undo: () => boolean;
    redo: () => boolean;
    state: { edit: boolean };
  }
  type Btn = FakeEl & { onclick?: () => void; hidden?: boolean; disabled?: boolean };
  const setup = () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as EMap;
    map.flyTo('api');
    h.frames.runToCompletion();
    for (let i = 0; i < 60; i++) h.frames.flush();
    const doc = h.sandbox.document as { getElementById: (id: string) => Btn; dispatch: (t: string, e?: unknown) => void };
    return { h, map, doc, html };
  };
  const drag = (h: HarnessResult, x0: number, y0: number, x1: number, y1: number) => {
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x0, clientY: y0 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: x1, clientY: y1 });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x1, clientY: y1 });
  };
  const all = (n: EN): EN[] => [n, ...n.children.flatMap(all)];
  const snap = (root: EN) => JSON.stringify(all(root).map(n => [n.id, n.x, n.y, n.w, n.h, n.bubble ? { ...n.bubble } : null]));
  const dragBubble = (h: HarnessResult, map: EMap) => {
    const k = map.nodeById('api')!.children.find(c => c._tv === 0 && c.bubble)!;
    const cx = k._R!.x + k._R!.w / 2, cy = k._R!.y + k._R!.h / 2;
    drag(h, cx, cy, cx + 40, cy + 20);
  };

  test('Undo button restores the original rects, Redo reapplies; buttons track the stacks', () => {
    const { h, map, doc, html } = setup();
    expect(html).toMatch(/id="btn-undo" hidden disabled/);
    expect(html).toMatch(/id="btn-redo" hidden disabled/);
    const root = map.nodeById('api')!.parent!;
    const undoB = doc.getElementById('btn-undo'), redoB = doc.getElementById('btn-redo');
    map.setEdit(true);
    expect(undoB.hidden).toBe(false);
    expect(redoB.hidden).toBe(false);
    expect(undoB.disabled).toBe(true);
    expect(redoB.disabled).toBe(true);
    const orig = snap(root);
    dragBubble(h, map);
    const edited = snap(root);
    expect(edited).not.toBe(orig);
    expect(undoB.disabled).toBe(false);
    expect(redoB.disabled).toBe(true);
    undoB.onclick!();
    expect(snap(root)).toBe(orig);
    expect(undoB.disabled).toBe(true);
    expect(redoB.disabled).toBe(false);
    redoB.onclick!();
    expect(snap(root)).toBe(edited);
    expect(redoB.disabled).toBe(true);
    map.setEdit(false);
    expect(undoB.hidden).toBe(true);
  });

  test('Ctrl+Z undoes, Shift+Ctrl+Z and Ctrl+Y redo, Cmd+Z works; keyboard is ignored when edit is off or typing', () => {
    const { h, map, doc } = setup();
    const root = map.nodeById('api')!.parent!;
    const orig = snap(root);
    map.setEdit(true);
    dragBubble(h, map);
    const edited = snap(root);
    let prevented = 0;
    const key = (e: Record<string, unknown>) => doc.dispatch('keydown', { preventDefault: () => { prevented++; }, ...e });
    key({ key: 'z', ctrlKey: true, target: { tagName: 'INPUT' } }); // typing in search: ignored
    expect(snap(root)).toBe(edited);
    expect(prevented).toBe(0);
    key({ key: 'z', ctrlKey: true });
    expect(snap(root)).toBe(orig);
    expect(prevented).toBe(1);
    key({ key: 'Z', ctrlKey: true, shiftKey: true });
    expect(snap(root)).toBe(edited);
    key({ key: 'z', metaKey: true });
    expect(snap(root)).toBe(orig);
    key({ key: 'y', ctrlKey: true });
    expect(snap(root)).toBe(edited);
    map.setEdit(false);
    prevented = 0;
    key({ key: 'z', ctrlKey: true });
    expect(snap(root)).toBe(edited);
    expect(prevented).toBe(0);
  });

  test('Reset layout clears the history', () => {
    const { h, map, doc } = setup();
    map.setEdit(true);
    dragBubble(h, map);
    doc.getElementById('btn-undo').onclick!(); // one in redo, then a second edit
    dragBubble(h, map);
    doc.getElementById('btn-reset').onclick!();
    expect(doc.getElementById('btn-undo').disabled).toBe(true);
    expect(doc.getElementById('btn-redo').disabled).toBe(true);
    expect(map.undo()).toBe(false);
    expect(map.redo()).toBe(false);
  });

  test('bubble drag: undo/redo and Reset restore bubble position and bubbleMoved (P10-T1d)', () => {
    const { h, map, doc } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    const k = api.children.find(c => c._tv === 0 && c.bubble)!;
    const b0 = { ...k.bubble! };
    const cx = k._R!.x + k._R!.w / 2, cy = k._R!.y + k._R!.h / 2;
    drag(h, cx, cy, cx + 30, cy + 12);
    const b1 = { ...k.bubble! };
    expect(b1).not.toEqual(b0);
    expect(k.bubbleMoved).toBe(true);
    map.undo();
    expect(k.bubble).toEqual(b0);
    expect(k.bubbleMoved).toBeFalsy();
    map.redo();
    expect(k.bubble).toEqual(b1);
    expect(k.bubbleMoved).toBe(true);
    doc.getElementById('btn-reset').onclick!();
    expect(k.bubble).toEqual(b0);
    expect(k.bubbleMoved).toBeFalsy();
  });

  // P14-I9 (replaces "a resize that grows an ancestor undoes the ancestor too"): the two-phase tree sizes
  // ancestors in layoutTree, so a move of a nested node leaves every ancestor's w/h alone; undo restores positions.
  test('moving a nested node leaves every ancestor size unchanged; undo restores all positions exactly', () => {
    const { h, map } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    const root = api.parent!;
    const k = api.children.find(c => c._tv === 0 && c.bubble)!;
    const sizes = (): string => JSON.stringify([root, api].map(n => [n.id, n.w, n.h]));
    const sizes0 = sizes();
    const orig = snap(root);
    const cx = k._R!.x + k._R!.w / 2, cy = k._R!.y + k._R!.h / 2;
    drag(h, cx, cy, cx + 200, cy + 40);
    expect(snap(root)).not.toBe(orig);
    expect(sizes()).toBe(sizes0);
    expect(map.undo()).toBe(true);
    expect(snap(root)).toBe(orig);
  });
});

// ---------- P10-T2c: Export layout ----------
describe('viewer Export layout (P10-T2c)', () => {
  type R = { x: number; y: number; w: number; h: number };
  interface EN extends R { id: string; kind: string; _R?: R; _tv?: number; parent?: EN; children: EN[]; bubble?: R; scale?: number }
  interface EMap {
    nodeById: (id: string) => EN | undefined;
    flyTo: (id: string) => void;
    setEdit: (on: boolean) => void;
    exportLayout: () => { version: number; nodes: Record<string, { bx?: number; by?: number; rx: number; ry: number; rw: number; rh: number }> };
  }
  type Btn = FakeEl & { onclick?: () => void; hidden?: boolean };
  // P14-I9: same as SLOT in viewer/edit.js (the slot a child occupies in its parent's local frame); edit.test.ts asserts the viewer copy equals src/view/arrange.ts.
  const SLOT = { w: 300, h: 150 };
  const setup = () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();
    const map = h.sandbox.C4PM_MAP as EMap;
    map.flyTo('api');
    h.frames.runToCompletion();
    for (let i = 0; i < 60; i++) h.frames.flush();
    const doc = h.sandbox.document as { getElementById: (id: string) => Btn };
    return { h, map, doc, html };
  };
  const drag = (h: HarnessResult, x0: number, y0: number, x1: number, y1: number) => {
    h.canvas.dispatch('pointerdown', { pointerId: 1, clientX: x0, clientY: y0 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
    h.canvas.dispatch('pointermove', { pointerId: 1, clientX: x1, clientY: y1 });
    h.canvas.dispatch('pointerup', { pointerId: 1, clientX: x1, clientY: y1 });
  };

  test('button is hidden outside edit mode and shown in it', () => {
    const { map, doc, html } = setup();
    expect(html).toMatch(/id="btn-export" hidden/);
    map.setEdit(true);
    expect(doc.getElementById('btn-export').hidden).toBe(false);
    map.setEdit(false);
    expect(doc.getElementById('btn-export').hidden).toBe(true);
  });

  // P10-T1d: export is v2 { bx?, by?, rx, ry, rw, rh }. P14-I9: a two-phase tree exports parent-local units
  // (bx,by = bean top-left; rx,ry = slot top-left; rw,rh = own local size), computed here from the model.
  test('no edits -> empty v2 export; a closed-bubble drag lists bx,by and rx,ry in parent-local units', () => {
    const { h, map } = setup();
    map.setEdit(true);
    expect(map.exportLayout()).toEqual({ version: 2, nodes: {} });
    const api = map.nodeById('api')!;
    const k = api.children.find(c => c._tv === 0 && c._R && c.bubble && ['container', 'component'].includes(c.kind));
    expect(k).toBeDefined();
    const cx = k!._R!.x + k!._R!.w / 2, cy = k!._R!.y + k!._R!.h / 2;
    drag(h, cx, cy, cx + 40, cy + 20);
    const out = map.exportLayout();
    expect(out.version).toBe(2);
    expect(Object.keys(out.nodes)).toContain(k!.id);
    const e = out.nodes[k!.id];
    const Kp = api.scale!;
    expect(e.bx).toBe(Math.round((k!.bubble!.x - api.x) / Kp));
    expect(e.by).toBe(Math.round((k!.bubble!.y - api.y) / Kp));
    expect(e.rx).toBe(Math.round((k!.x + k!.w / 2 - SLOT.w * Kp / 2 - api.x) / Kp));
    expect(e.ry).toBe(Math.round((k!.y + k!.h / 2 - SLOT.h * Kp / 2 - api.y) / Kp));
    expect(e.rw).toBe(Math.round(k!.w / k!.scale!));
    expect(e.rh).toBe(Math.round(k!.h / k!.scale!));
  });

  // P14-I9 (replaces "an open-region resize exports region size without bx,by"): the two-phase tree has no
  // resize, so an open-region move exports its slot (rx,ry) and its own local size, which a move does not change.
  test('an open-region move exports its slot rx,ry in parent-local units; its local size is unchanged', () => {
    const { h, map } = setup();
    map.setEdit(true);
    const api = map.nodeById('api')!;
    const po = api.parent!;
    const rw0 = Math.round(api.w / api.scale!), rh0 = Math.round(api.h / api.scale!);
    const hx = api._R!.x + api._R!.w / 2, hy = api._R!.y + 4;
    drag(h, hx, hy, hx + 40, hy + 20);
    const e = map.exportLayout().nodes.api;
    expect(e).toBeDefined();
    expect(e.rx).toBe(Math.round((api.x + api.w / 2 - SLOT.w * po.scale! / 2 - po.x) / po.scale!));
    expect(e.ry).toBe(Math.round((api.y + api.h / 2 - SLOT.h * po.scale! / 2 - po.y) / po.scale!));
    expect(e.rw).toBe(rw0);
    expect(e.rh).toBe(rh0);
  });

  test('Export button with no edits shows a message and does not download', () => {
    const { map, doc } = setup();
    map.setEdit(true);
    const hint = doc.getElementById('hud-bl') as Btn & { textContent: string };
    doc.getElementById('btn-export').onclick!();
    expect(hint.textContent).toMatch(/Nothing to export/);
  });
});

// ---------- P7-T6: panel.js rich per-kind panel rendering ----------
//
// Same hand-built-ViewModel approach as the "shared/unassigned dashed-border" test above: no
// existing fixture .c4 plan has real function-level claims, so no fixture repo produces claim-mode
// component/slice/shared/unassigned nodes with claims/source/history/code today. Building the
// ViewModel by hand, using exactly the real ViewNode shape src/view/model.ts produces for a
// claim-mode component (claims/source/history) and for function nodes (code/callsAvailable),
// exercises panel.js's real per-kind rendering without inventing a fixture repo.
describe('viewer-smoke: P7-T6 panel.js per-kind rendering', () => {
  function buildClaimModeModelHtml(): { model: ViewModel; html: string } {
    const createOrderFn: ViewNode = {
      id: 'src/orders/order.ts#createOrder', kind: 'function', name: 'createOrder',
      detail: 'function · 3 lines', weight: 3, children: [], x: 0, y: 0, w: 0, h: 0,
      file: 'src/orders/order.ts', line: 1, callsAvailable: false,
      code: [
        "export function createOrder(id: string): string {",
        "  return formatId(id);",
        "}",
      ],
    };
    const ordersSlice: ViewNode = {
      id: 'app.orders::slice::src/orders/order.ts', kind: 'slice', name: 'order.ts',
      detail: '1 owned element · src/orders/order.ts', weight: 3, children: [createOrderFn],
      x: 0, y: 0, w: 0, h: 0, file: 'src/orders/order.ts', callsAvailable: false,
    };
    const ordersComponent: ViewNode = {
      id: 'app.orders', kind: 'component', name: 'Orders', detail: 'src/orders',
      weight: 3, children: [ordersSlice], x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
      claims: [{ kind: 'function', path: 'src/orders/order.ts', fn: 'createOrder' }],
      source: 'src/orders.c4',
      history: [{ commit: 'abc1234567890', date: '2026-01-01', message: 'claim order.ts#createOrder' }],
    };
    const container: ViewNode = {
      id: 'app', kind: 'container', name: 'App', detail: 'Node.js', weight: 3,
      children: [ordersComponent], x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
    };

    const formatIdFn: ViewNode = {
      id: 'src/shared/util.ts#formatId', kind: 'function', name: 'formatId',
      detail: 'function · 2 lines', weight: 2, children: [], x: 0, y: 0, w: 0, h: 0,
      file: 'src/shared/util.ts', line: 1, callsAvailable: false,
      code: ["export function formatId(id: string): string {", "  return id.toUpperCase();", "}"],
    };
    const sharedNode: ViewNode = {
      id: 'claim-app::shared', kind: 'shared', name: 'Shared', detail: '1 shared function',
      weight: 2, children: [formatIdFn], x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
    };

    const orphanFn: ViewNode = {
      id: 'src/misc/orphan.ts#orphanFn', kind: 'function', name: 'orphanFn',
      detail: 'function · 2 lines', weight: 2, children: [], x: 0, y: 0, w: 0, h: 0,
      file: 'src/misc/orphan.ts', line: 1, callsAvailable: false,
      code: ["export function orphanFn(): string {", "  return 'orphan';", "}"],
      findings: [{ severity: 'critical', rule: 'unassigned-code', message: 'no component claims it and nothing calls it' }],
    };
    const unassignedNode: ViewNode = {
      id: 'claim-app::unassigned', kind: 'unassigned', name: 'Unassigned',
      detail: '1 unassigned function', weight: 2, children: [orphanFn], x: 0, y: 0, w: 0, h: 0,
      callsAvailable: false,
    };

    const root: ViewNode = {
      id: 'claim-app', kind: 'system', name: 'claim-app', detail: '', weight: 7,
      children: [container, sharedNode, unassignedNode], x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
    };

    let model: ViewModel = {
      schemaVersion: 1, title: 'claim-app', subtitle: 'synthetic', summary: 'synthetic claim-mode fixture',
      repoPath: '/tmp/claim-app', root, edges: [], drift: null, planFindings: [], files: [],
    };
    model = layoutView(model);
    const html = renderViewHtml(model);
    return { model, html };
  }

  test('selecting a claim-mode component shows its real claims, source, and history (no invented won/lost status)', () => {
    const { html } = buildClaimModeModelHtml();
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { select: (id: string) => void };
    map.select('app.orders');
    const panelText = serializeText(h.panel);

    // the real claim: kind + path + fn, as src/types.ts's Pick<Claim,'kind'|'path'|'fn'> carries it
    expect(panelText).toContain('function');
    expect(panelText).toContain('src/orders/order.ts#createOrder');
    // source: the .c4 file the claim was declared in
    expect(panelText).toContain('src/orders.c4');
    // history: a real commit + message, from node.history (P7-T3/T4)
    expect(panelText).toContain('abc1234');
    expect(panelText).toContain('claim order.ts#createOrder');
    // never invented: no won/lost wording, since OwnershipConflict data isn't on ViewNode/ViewModel
    expect(panelText).not.toMatch(/lost to|won\b/i);
  });

  test('selecting a function node shows its real source lines and the calls-not-available note', () => {
    const { html } = buildClaimModeModelHtml();
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { select: (id: string) => void };
    map.select('src/orders/order.ts#createOrder');
    const panelText = serializeText(h.panel);

    // real source lines (node.code), not fabricated -- highlightLine() wraps keywords in their
    // own <span>, so match loosely rather than asserting exact adjacency of highlighted tokens
    expect(panelText).toContain('createOrder(id: string): string {');
    expect(panelText).toContain('formatId(id);');
    // callsAvailable === false this phase -> an honest current-limitation note, never the mock's
    // fake call chips or "idea only" mockup styling
    expect(panelText).toMatch(/isn't built yet|not built yet/i);
    expect(panelText).not.toMatch(/idea only/i);
  });

  test('selecting the shared node explains it is auto-generated, not written in a .c4 file', () => {
    const { html } = buildClaimModeModelHtml();
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { select: (id: string) => void };
    map.select('claim-app::shared');
    const panelText = serializeText(h.panel);

    expect(panelText).toContain('formatId');
    expect(panelText).toMatch(/automatically|auto/i);
    expect(panelText).toMatch(/isn't written in any \.c4 file/i);
  });

  test('selecting the unassigned node explains nothing claims or calls it', () => {
    const { html } = buildClaimModeModelHtml();
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { select: (id: string) => void };
    map.select('claim-app::unassigned');
    const panelText = serializeText(h.panel);

    expect(panelText).toContain('orphanFn');
    expect(panelText).toMatch(/no component claims/i);
    expect(panelText).toMatch(/unplanned code|dead code/i);
  });
});

// P7-T7: unlike every other test in this file (which reimplements the pipeline step-by-step via
// buildViewForFixture / buildClaimModeModelHtml), this exercises the actual exported `buildView`
// -- the function bin/cli.ts's `view` command calls -- end to end against the on-disk sample
// fixture, confirming T3's source/history capability reads (already wired into buildViewModel by
// T4) reach real CLI-shaped output with no separate wiring step needed.
describe('viewer-smoke: P7-T7 buildView end-to-end on the sample fixture', () => {
  test('buildView produces valid, self-contained HTML with no raw </script> break-out, and reports its size', () => {
    const { model, html } = buildView({ repo: path.join(__dirname, 'fixtures/sample') });

    expect(model.schemaVersion).toBe(1);
    expect(model.root.kind).toBe('system');

    // exactly two <script> tags (style/data inline, then map.js+panel.js) -- same shape Phase 5
    // T8 verified across all 5 real repos.
    const scriptTags = html.match(/<script>/g) ?? [];
    expect(scriptTags.length).toBe(2);

    // No un-escaped '</script>' can appear anywhere inside the embedded JSON payload: every '<'
    // in the data is escaped to < by renderViewHtml, so the only literal '</script>' tags in
    // the whole document are the two real closing tags above.
    const closingScriptTags = html.match(/<\/script>/g) ?? [];
    expect(closingScriptTags.length).toBe(2);

    const dataMatch = html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/);
    expect(dataMatch).not.toBeNull();
    const parsed = JSON.parse(dataMatch![1]);
    expect(parsed.schemaVersion).toBe(1);

    // P7-T3/T4 capability fields reached real CLI-shaped output: at least one claim-free
    // function node has `code` populated and `callsAvailable === false` (sample fixture is
    // folder-mode, no .c4 plan, so no `claims`/`source`/`history` are expected here -- those are
    // covered by the claim-mode tests above).
    let sawFunctionWithCode = false;
    const walk = (n: ViewNode) => {
      if (n.kind === 'function' || n.kind === 'method') {
        expect(n.callsAvailable).toBe(false);
        if (n.code && n.code.length > 0) sawFunctionWithCode = true;
      }
      n.children.forEach(walk);
    };
    walk(model.root);
    expect(sawFunctionWithCode).toBe(true);

    expect(html).not.toMatch(NO_URL_EXCEPT_CREDIT);   // b168: the one allowed URL is the credit link (a plain anchor, loads nothing)

    const bytes = Buffer.byteLength(html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[P7-T7] sample.html size: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe('viewer-smoke: P14-T32a camera follows the viewer', () => {
  test('P14-T32a: a resize keeps the world point at the centre and does not refit the camera', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as { state: { cam: { s: number; tx: number; ty: number }; cw: number; ch: number } };
    const wrap = (h.sandbox.document as { getElementById: (id: string) => { clientWidth: number } }).getElementById('map-wrap');
    const observer = h.resizeObservers.find(o => o.target === wrap);
    expect(observer).toBeDefined();

    // world point under the centre of the map at its current size
    const centreWorld = () => ({
      x: (map.state.cw / 2 - map.state.cam.tx) / map.state.cam.s,
      y: (map.state.ch / 2 - map.state.cam.ty) / map.state.cam.s,
    });
    const scaleBefore = map.state.cam.s;
    const centreBefore = centreWorld();

    // a side panel collapses: the map gets narrower, then wider again
    wrap.clientWidth = 900;
    observer!.cb([{ target: wrap }]);
    expect(map.state.cw).toBe(900);
    expect(map.state.cam.s).toBe(scaleBefore);
    expect(centreWorld().x).toBeCloseTo(centreBefore.x, 0);
    expect(centreWorld().y).toBeCloseTo(centreBefore.y, 0);

    wrap.clientWidth = 1400;
    observer!.cb([{ target: wrap }]);
    expect(map.state.cam.s).toBe(scaleBefore);
    expect(centreWorld().x).toBeCloseTo(centreBefore.x, 0);
    expect(centreWorld().y).toBeCloseTo(centreBefore.y, 0);
  });

  test('P14-T32a: flyTo(id) on an inner node moves the camera to fitCam(node)', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    h.frames.flush();

    const map = h.sandbox.C4PM_MAP as {
      state: { cam: { s: number; tx: number; ty: number }; cw: number; ch: number };
      nodeById: (id: string) => ViewNode | undefined;
      flyTo: (id: string) => void;
    };
    const node = map.nodeById('api/services')!;
    expect(node).toBeDefined();
    const before = { ...map.state.cam };

    // Same order as the tree row click (tree.js: map.flyTo(id) then map.select(id)).
    map.flyTo('api/services');
    (h.sandbox.C4PM_MAP as { select: (id: string) => void }).select('api/services');
    h.frames.runToCompletion();

    const { cw, ch } = map.state;
    const expectedS = Math.min((cw * 0.9) / node.w, (ch * 0.9) / node.h);
    expect(Math.abs(before.s - expectedS)).toBeGreaterThan(0.01);
    expect(map.state.cam.s).toBeCloseTo(expectedS, 2);
  });

  test('P14-T32a: every node has a box, so flyTo(id) from a tree row is never a silent no-op', () => {
    const empty: string[] = [];
    for (const f of ['sample', 'sample-v2', 'phofast', 'pyshop', 'java-tiny', 'level4']) {
      const { model } = buildViewForFixture(path.join(__dirname, 'fixtures', f));
      const walk = (n: ViewNode) => {
        if (!(n.w > 0 && n.h > 0)) empty.push(`${f}:${n.id}`);
        n.children.forEach(walk);
      };
      walk(model.root);
    }
    expect(empty).toEqual([]);
  });
});

describe('viewer-smoke: P14-T32b edit toolbar and legend', () => {
  test('P14-T32b: setupLegend leaves no childless, textless row in #legend', () => {
    const { html } = buildViewForFixture(path.join(__dirname, 'fixtures/sample-v2'));
    const h = runViewerScripts(html);
    const legend = (h.sandbox.document as { getElementById: (id: string) => FakeEl }).getElementById('legend');
    const empty = legend.children.filter(c => c.children.length === 0 && c.textContent.trim() === '');
    expect(empty.map(c => c.tagName)).toEqual([]);
  });
});
