import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';
import { simHtml, simModel, SIM_KEYS, SIM_FINDINGS } from './helpers/sim-view';
import { buildViewSims } from '../src/view/simModel';

// Phase 25 UI7 (b757): viewer/sim-strip.js, the path strip (#simbar) and the camera hooks of C4PM_SIM (fly, fitPath).
// The page is simHtml() (test/helpers/sim-view.ts): flow s-1 (7 steps: io, io, arch, arch (unverified), storage, arch, io)
// and journey s-2 (outside, s-1 inline, outside: 9 steps in 3 stages).

const IDS = ['simbar', 'view-toast', 'btn-gear', 'settings-pop'];
function load(hash?: string, opts: { extraIds?: string[]; globals?: Record<string, unknown>; html?: string } = {}): HarnessResult {
  const globals: Record<string, unknown> = { ...(opts.globals || {}) };
  if (hash !== undefined) globals.location = { href: 'file:///x.html' + hash, hash };
  return runViewerScripts(opts.html ?? simHtml(), { extraIds: [...IDS, ...(opts.extraIds || [])], globals });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const byId = (h: HarnessResult, id: string) => (h.sandbox.document as any).getElementById(id) as FakeEl & { hidden?: boolean; offsetTop?: number; offsetHeight?: number };
const bar = (h: HarnessResult) => byId(h, 'simbar');
const chips = (h: HarnessResult) => bar(h).querySelectorAll('.sb-step');
const btnTexts = (h: HarnessResult) => bar(h).querySelectorAll('.sb-btn').map((b) => b.textContent);
const has = (e: FakeEl, c: string) => e.classList.contains(c);
const withClass = (h: HarnessResult, c: string) => chips(h).filter((e) => has(e, c)).map((e) => e.textContent);
type Rect = { x: number; y: number; w: number; h: number };
const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
// Records C4PM_CAM.fitCamIn arguments and flyTo targets (the strip reads both at call time).
function spyCam(h: HarnessResult) {
  const CAM = win(h).C4PM_CAM;
  const fit = CAM.fitCamIn;
  const log = { fits: [] as any[][], flies: [] as any[] };
  CAM.fitCamIn = (...a: any[]) => { log.fits.push(a); return fit(...a); };
  CAM.flyTo = (t: any) => { log.flies.push(t); };
  return log;
}
const rectOf = (n: any): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });

describe('a page without s-items', () => {
  it('sim-strip.js does nothing: no C4PM_SIMSTRIP, #simbar untouched', () => {
    const h = load(undefined, { html: renderViewHtml(storageModel()) });
    expect(win(h).C4PM_SIMSTRIP).toBeUndefined();
    expect(bar(h).hidden).toBeUndefined();
    expect(bar(h).children).toEqual([]);
  });
});

describe('the strip', () => {
  it('hidden with no s-item; a selection shows icon, id, title and one chip per step, coloured by view', () => {
    const h = load();
    expect(bar(h).hidden).toBe(true);
    SIM(h).select('s-1');
    expect(bar(h).hidden).toBe(false);
    const [ico, id, title] = bar(h).children;
    expect([has(ico, 'sim-ico'), ico.innerHTML.startsWith('<svg'), ico.title]).toEqual([true, true, 'flow']);
    expect([id.className, id.textContent, title.className, title.textContent]).toEqual(['sb-id', 's-1', 'sb-title', 'Place an order']);
    expect(chips(h).map((c) => c.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(chips(h).map((c) => c.className.split(' ')[1])).toEqual(['v-io', 'v-io', 'v-arch', 'v-arch', 'v-storage', 'v-arch', 'v-io']);
    expect(withClass(h, 'here')).toEqual(['3', '4', '6']);   // the arch view is shown
    expect(withClass(h, 'unver')).toEqual(['4']);
    expect(withClass(h, 'cur')).toEqual([]);
    expect(bar(h).querySelectorAll('.sb-sep')).toEqual([]);
    const st = SIM(h).steps()[2];
    expect(chips(h)[2].title).toBe('Step 3 · Architecture view · ' + SIM(h).stepTarget(st));
    expect(chips(h)[3].title).toMatch(/ · unverified$/);
    expect(chips(h)[0].attrs.type).toBe('button');
  });

  it('the cursor: cur on its chip, "All" only with a cursor; a mode change moves "here"; clearing hides the strip', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    expect(btnTexts(h)).toEqual(['‹', '›', '▶ Present', '≡ Sequence', '✕']);
    S.go(1);
    expect(withClass(h, 'cur')).toEqual(['2']);
    expect(btnTexts(h)).toEqual(['‹', '›', 'All', '▶ Present', '≡ Sequence', '✕']);
    win(h).C4PM_MODE.set('io');
    expect(withClass(h, 'here')).toEqual(['1', '2', '7']);
    S.select(null);
    expect(bar(h).hidden).toBe(true);
    expect(bar(h).children).toEqual([]);
  });

  it('journey: a separator between stages, outside chips (v-out, never here); the key adds outside / unverified only when a step is', () => {
    const h = load();
    const S = SIM(h);
    const keyTexts = () => bar(h).querySelector('.sb-key')!.children.map((k) => serializeText(k).trim());
    const keyDots = () => bar(h).querySelector('.sb-key')!.children.map((k) => k.children[0].className);
    S.select('s-1');
    expect(keyTexts()).toEqual(['IO', 'Arch', 'Storage', 'unverified']);
    expect(keyDots()).toEqual(['k-io', 'k-arch', 'k-storage', 'k-unver']);
    S.select('s-2');
    expect(bar(h).children[0].title).toBe('journey');
    const row = bar(h).querySelector('.sb-steps')!.children.map((c) => (has(c, 'sb-sep') ? '|' : c.textContent));
    expect(row).toEqual(['1', '|', '2', '3', '4', '5', '6', '7', '8', '|', '9']);
    expect(withClass(h, 'v-out')).toEqual(['1', '9']);
    expect(withClass(h, 'here')).toEqual(['4', '5', '7']);
    expect(chips(h)[0].title).toBe('Step 1 · outside the system · Reads the newsletter');
    expect(keyTexts()).toEqual(['IO', 'Arch', 'Storage', 'outside', 'unverified']);
  });

  it('every button calls C4PM_SIM.act', () => {
    const h = load();
    SIM(h).select('s-1');
    SIM(h).go(0);
    const acts: string[] = [];
    win(h).C4PM_SIM.act = (a: string) => acts.push(a);
    bar(h).querySelectorAll('.sb-btn').forEach((b) => b.click());
    expect(acts).toEqual(['prev', 'next', 'whole', 'present', 'seq', 'clear']);
    expect(has(bar(h).querySelectorAll('.sb-btn')[3], 'play')).toBe(true);
  });

  it('"≡ Sequence ✓" while #seq-drawer is shown (re-rendered after the click)', () => {
    const h = load(undefined, { extraIds: ['seq-drawer'] });
    const d = byId(h, 'seq-drawer');
    d.hidden = true;
    SIM(h).hooks.seq = (on?: boolean) => { d.hidden = on === undefined ? !d.hidden : !on; };
    SIM(h).select('s-1');
    const seqBtn = () => bar(h).querySelectorAll('.sb-btn').find((b) => b.textContent.startsWith('≡'))!;
    expect(seqBtn().textContent).toBe('≡ Sequence');
    seqBtn().click();
    expect(seqBtn().textContent).toBe('≡ Sequence ✓');
    seqBtn().click();
    expect(seqBtn().textContent).toBe('≡ Sequence');
  });

  it('hidden while presenting (hook or #root.presenting)', () => {
    const h = load();
    const S = SIM(h);
    let on = true;
    S.hooks.presenting = () => on;
    S.select('s-1', { fromPres: true });
    expect(bar(h).hidden).toBe(true);
    on = false;
    win(h).C4PM_SIMSTRIP.render();
    expect(bar(h).hidden).toBe(false);
    byId(h, 'root').classList.add('presenting');
    win(h).C4PM_SIMSTRIP.render();
    expect(bar(h).hidden).toBe(true);
  });
});

// b853 S4 (b865): the flow depth switch on the strip and the chips over the flow steps (C4PM_SIM.flow()). At container the
// server groups s-1 [[0,1],[2,3],[4],[5],[6]] (S1); at code (the default) every test above is unchanged.
describe('flow depth (b853 S4)', () => {
  const STORE = () => { const s: Record<string, string> = {}; return { __s: s, getItem: (k: string) => (k in s ? s[k] : null), setItem: (k: string, v: string) => { s[k] = String(v); } }; };
  const depthSwitch = (h: HarnessResult) => bar(h).querySelector('.sb-depth')!;
  const depthSel = (h: HarnessResult) => bar(h).querySelectorAll('.sb-depth-sel');

  it('at container: one chip per flow step, class / here / unver of the merged steps, "steps 3–4" in the title, a click goes to the first member', () => {
    const h = load(undefined, { globals: { localStorage: STORE() } });
    const S = SIM(h);
    S.setDepth('container');
    S.select('s-1');
    expect(chips(h).map((c) => c.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(chips(h).map((c) => c.className.split(' ')[1])).toEqual(['v-io', 'v-arch', 'v-storage', 'v-arch', 'v-io']);
    expect(withClass(h, 'here')).toEqual(['2', '4']);   // the arch view is shown
    expect(withClass(h, 'unver')).toEqual(['2']);       // original step 4 is inside flow step 2
    expect(chips(h)[1].title).toMatch(/^Step 2 · Architecture view · .* · steps 3–4$/);
    expect(chips(h)[0].title).toMatch(/ · steps 1–2$/);
    expect(chips(h)[2].title).not.toMatch(/ · steps /);   // one member: no range
    chips(h)[2].click();
    expect(S.step()).toBe(4);
    expect(withClass(h, 'cur')).toEqual(['3']);
    S.go(3);
    expect(withClass(h, 'cur')).toEqual(['2']);   // the cursor's flow step
  });

  // b872 (K 2026-11-17): changed ON PURPOSE from the S4 four-button switch: one 'Depth' dropdown so the strip fits one line.
  it('the switch: a "Depth" dropdown after the chips (no sb-btn), its value follows setDepth, a change sets and stores the depth', () => {
    const store = STORE();
    const h = load(undefined, { globals: { localStorage: store } });
    const S = SIM(h);
    S.select('s-1');
    const sw = depthSwitch(h);
    expect([sw.tagName, sw.className]).toEqual(['LABEL', 'sb-depth']);
    const kids = bar(h).children;
    expect(kids.indexOf(sw)).toBe(kids.indexOf(bar(h).querySelector('.sb-steps')!) + 1);
    expect(serializeText(sw.children[0]).trim()).toBe('Depth');
    expect(depthSel(h).length).toBe(1);
    const sel = depthSel(h)[0];
    expect([sel.tagName, sel.attrs['aria-label'], has(sel, 'sb-btn')]).toEqual(['SELECT', 'Flow depth', false]);
    const opts = sel.querySelectorAll('option');
    expect(opts.map((o) => o.value)).toEqual(['context', 'container', 'component', 'code']);
    expect(opts.map((o) => o.textContent)).toEqual(['Context', 'Container', 'Component', 'Code']);
    expect(opts.map((o) => o.title)).toEqual([
      'Flow depth Context (C1): consecutive steps in one box merge',
      'Flow depth Container (C2): consecutive steps in one box merge',
      'Flow depth Component (C3): consecutive steps in one box merge',
      'Flow depth Code: every step on its own',
    ]);
    expect(sw.querySelectorAll('button')).toEqual([]);
    expect(sel.value).toBe('code');
    S.setDepth('component');
    expect(depthSel(h)[0].value).toBe('component');
    const now = depthSel(h)[0];
    now.value = 'container';
    now.dispatch('change');
    expect(S.depth()).toBe('container');
    expect(store.__s['c4mp.simDepth']).toBe('container');
    expect(depthSel(h)[0].value).toBe('container');
    expect(chips(h).map((c) => c.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(btnTexts(h)).toEqual(['‹', '›', '▶ Present', '≡ Sequence', '✕']);
  });

  it('stepRect of a flow step at container: its arch boxes and its arrow ends (flow step 2 = the api box)', () => {
    const h = load(undefined, { globals: { localStorage: STORE() } });
    const S = SIM(h);
    S.setDepth('container');
    S.select('s-1');
    const nodes = win(h).C4PM_STATE.nodeById;
    const fs = S.flow()[1];
    expect(fs.members).toEqual([2, 3]);
    expect([fs.archIds, fs.arrows.map((a: any) => a.from + '>' + a.to)]).toEqual([['api'], ['shop.web>api']]);
    expect(nodes['shop.web']).toBeUndefined();   // a lane, not an arch box: only api is drawn
    expect(win(h).C4PM_SIMSTRIP.stepRect(fs)).toEqual(union([rectOf(nodes.api)]));   // union: the same float sums as the strip
    expect(win(h).C4PM_SIMSTRIP.stepRect(fs, { targetsOnly: true })).toEqual(union([rectOf(nodes.api)]));
  });
});

describe('fly, fitPath, stepRect, barBottom', () => {
  it('a chip of another view sets the hash, then flies after the switch (fitCamIn pad 0.8 under the strip)', () => {
    const h = load('#arch');
    const S = SIM(h);
    S.select('s-1');
    const cam = spyCam(h);
    chips(h)[0].click();
    expect(S.step()).toBe(0);
    expect(win(h).location.hash).toBe('#io');
    expect(cam.flies).toEqual([]);
    h.fireWindowEvent('hashchange');
    expect(win(h).C4PM_MODE.get()).toBe('io');
    const t = S.steps()[0].targets[0];
    expect(cam.fits).toEqual([[win(h).C4PM_IOVIEW.rect(t.entryId), 0.8, 50, 10]]);
    expect(cam.flies.length).toBe(1);
    expect(withClass(h, 'cur')).toEqual(['1']);
  });

  it('a chip of this view flies at once to its boxes and both call ends (a function counts as its parent)', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    const cam = spyCam(h);
    chips(h)[3].click();
    const st = S.steps()[3];
    const nodes = win(h).C4PM_STATE.nodeById;
    const box = (id: string) => { const n = nodes[id]; return rectOf(n.kind === 'function' || n.kind === 'method' ? n.parent : n); };
    const ids = [...st.targets.map((t: any) => t.nodeId), st.call.from, st.call.to];
    expect(cam.fits).toEqual([[union(ids.map(box)), 0.8, 50, 10]]);
    expect(win(h).C4PM_MODE.get()).toBe('arch');
  });

  it('a fly sets C4PM_STATE.map.openBand to the band it fitted into (b786: barBottom() .. 10 px above the bottom)', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    spyCam(h);
    chips(h)[3].click();
    expect(win(h).C4PM_STATE.map.openBand).toEqual({ top: 50, bottom: 10 });
  });

  it('an outside step shows the toast (with the sender when known) and does not fly', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-2');
    const cam = spyCam(h);
    const toast = byId(h, 'view-toast');
    chips(h)[0].click();
    expect([toast.hidden, toast.textContent]).toEqual([false, 'Step 1 happens outside the system (Newsletter tool): Reads the newsletter']);
    chips(h)[8].click();
    expect(toast.textContent).toBe('Step 9 happens outside the system: Gets the receipt by email');
    expect([cam.fits, cam.flies, win(h).C4PM_MODE.get()]).toEqual([[], [], 'arch']);
  });

  // b786-8: io and storage keep the step-target fit (only the arch view frames every lit id).
  it('fitPath on select (and "All") fits what THIS view draws of the path (pad 0.85)', () => {
    const h = load();
    const S = SIM(h);
    const cam = spyCam(h);
    win(h).C4PM_MODE.set('io');
    S.select('s-1');
    const IOV = win(h).C4PM_IOVIEW;
    const io = S.steps().filter((s: any) => s.view === 'io').map((s: any) => IOV.rect(s.targets[0].entryId));
    expect(cam.fits).toEqual([[union(io), 0.85, 50, 10]]);
    S.select(null);
    cam.fits.length = 0;
    win(h).C4PM_MODE.set('storage');
    S.select('s-1', { fit: false });
    expect(cam.fits).toEqual([]);
    S.go(2);
    S.act('whole');
    const SV = win(h).C4PM_STORAGEVIEW;
    const recs = [...new Set<string>(S.steps().flatMap((s: any) => [
      ...s.targets.filter((t: any) => t.view === 'storage').map((t: any) => t.nodeId),
      ...(s.rows || []).map((r: any) => r.recordId),
    ]))];
    expect(recs.length).toBeGreaterThan(0);
    const u = union(recs.map((id) => SV.rect(id)));
    expect(cam.fits).toEqual([[{ x: u.x - 30, y: u.y - 30, w: u.w + 60, h: u.h + 60 }, 0.85, 50, 10]]);
  });

  // b786-8 (K 2026-11-17): changed ON PURPOSE from the b786 targets-only fit: in arch the whole path frames every lit box
  // (map.sim.ids: step targets AND call ends), like demo picture 03, so 'api' (a lit call end only) is now inside the fit.
  // b872 (K 2026-11-17): changed ON PURPOSE again: the fit also holds the title band of the region around each lit box
  // (from the region's left edge to the box's right edge, headerH high), never of the tree root or a C1 holder.
  it('b786-8: the whole-path fly in arch frames every lit box (map.sim.ids), a node that is only a call end too', () => {
    const h = load();
    const S = SIM(h);
    const cam = spyCam(h);
    S.select('s-1');
    const nodes = win(h).C4PM_STATE.nodeById;
    const boxNode = (id: string) => { const n = nodes[id]; return n.kind === 'function' || n.kind === 'method' ? n.parent : n; };
    const box = (id: string) => rectOf(boxNode(id));
    const band = (id: string): Rect[] => {
      const b = boxNode(id), p = b.parent;
      return p && p.parent && !p.holder && p.w > 0 && p.h > 0 ? [{ x: p.x, y: p.y, w: Math.min(p.w, b.x + b.w - p.x), h: p.headerH || 0 }] : [];
    };
    const lit = [...win(h).C4PM_STATE.map.sim.ids.keys()] as string[];
    expect(lit.length).toBeGreaterThan(0);
    expect(cam.fits).toEqual([[union([...lit.map(box), ...lit.flatMap(band)]), 0.85, 50, 10]]);
    // 'api' (container) is only a call end in s-1 (steps 3, 5, 6, 7), never a target, yet lit: the fit contains it
    const targets = S.steps().flatMap((s: any) => s.targets.filter((t: any) => t.view === 'arch' && t.nodeId).map((t: any) => t.nodeId));
    const callEnds = S.steps().flatMap((s: any) => (s.call ? [s.call.from, s.call.to] : []));
    expect(callEnds).toContain('api');
    expect(targets).not.toContain('api');
    expect(lit).toContain('api');
    const api = rectOf(nodes.api);
    expect(api.w > 0 && api.h > 0).toBe(true);
    const fit = cam.fits[0][0];
    expect(union([fit, api])).toEqual(fit);
  });
  // s-3: one io step whose call runs api/routes -> api/payments (two components of the api container; api itself is not lit).
  const callEndsOnly = () => {
    const m = simModel();
    m.sims = buildViewSims(m, {
      items: [{ schemaVersion: 1, id: 's-3', kind: 'flow', title: 'Call ends only', steps: [{ target: ['u-home'], view: 'io', call: { from: 'api/routes', to: 'api/payments' } }] }],
      findings: SIM_FINDINGS, fileOf: (id) => `.c4pm/projects/shop/sim/${id}.json`, keysOf: (ref) => SIM_KEYS[ref] ?? null,
    });
    return load(undefined, { html: simHtml(m) });
  };
  // b872: the title band of the region around a lit box (its left edge to the box's right edge, headerH high).
  const titleBand = (b: any): Rect => { const p = b.parent; return { x: p.x, y: p.y, w: Math.min(p.w, b.x + b.w - p.x), h: p.headerH || 0 }; };
  // b872 (K 2026-11-17, C4PM #arch&sim=s-1 cut "C1 SYSTEM"): the whole-path fly keeps the title of the region that holds a lit box.
  it('b872: lit boxes inside a wider region: the whole-path fit starts at that region\'s left edge and holds its title band', () => {
    const h = callEndsOnly();
    const cam = spyCam(h);
    SIM(h).select('s-3');
    const nodes = win(h).C4PM_STATE.nodeById;
    const routes = nodes['api/routes'], payments = nodes['api/payments'], api = routes.parent;
    expect([api.id, payments.parent.id, !!api.parent, !!api.holder, api.headerH > 0]).toEqual(['api', 'api', true, false, true]);   // not a holder (c1-context sets holder: false on every non-holder)
    expect(win(h).C4PM_STATE.map.sim.ids.has('api')).toBe(false);   // the region itself is not lit
    expect(api.x).toBeLessThan(Math.min(routes.x, payments.x));      // wider: before b872 the fit started at the boxes' x
    expect(api.y + api.headerH).toBeLessThanOrEqual(Math.min(routes.y, payments.y));   // its title band sits above them
    const fit = cam.fits[0][0];
    expect([fit.x, fit.y]).toEqual([api.x, api.y]);
    expect(cam.fits).toEqual([[union([rectOf(routes), rectOf(payments), titleBand(routes), titleBand(payments)]), 0.85, 50, 10]]);
  });
  // b872: changed ON PURPOSE: the fit also holds the api region's title band (the call ends' region).
  it('b786: a path whose arch presence is only call ends still flies (falls back to the call ends)', () => {
    const h = callEndsOnly();
    const S = SIM(h);
    const cam = spyCam(h);
    S.select('s-3');
    const st = S.steps()[0];
    expect(st.targets.filter((t: any) => t.view === 'arch')).toEqual([]);
    const nodes = win(h).C4PM_STATE.nodeById;
    const ends = [nodes['api/routes'], nodes['api/payments']];
    expect(cam.fits).toEqual([[union([...ends.map(rectOf), ...ends.map(titleBand)]), 0.85, 50, 10]]);
  });

  it('stepRect is null for an outside step and for a step this view does not draw', () => {
    const h = load();
    const S = SIM(h);
    const STRIP = win(h).C4PM_SIMSTRIP;
    win(h).C4PM_MODE.set('storage');
    expect(STRIP.stepRect(S.steps('s-1')[0])).toBeNull();   // an io step without rows
    expect(STRIP.stepRect(S.steps('s-2')[0])).toBeNull();   // outside
    expect(STRIP.stepRect(null)).toBeNull();
  });

  it('barBottom: under the shown strip + 6; 50 when hidden or on a phone (then the fit leaves 60 px at the bottom)', () => {
    let phone = false;
    const matchMedia = (q: string) => ({ matches: phone && q.includes('700px'), addEventListener() {}, removeEventListener() {} });
    const h = load(undefined, { globals: { matchMedia } });
    const STRIP = win(h).C4PM_SIMSTRIP;
    const b = bar(h);
    b.offsetTop = 52;
    b.offsetHeight = 34;
    expect(STRIP.barBottom()).toBe(50);   // hidden
    SIM(h).select('s-1');
    expect(STRIP.barBottom()).toBe(92);
    phone = true;
    expect(STRIP.barBottom()).toBe(50);
    const cam = spyCam(h);
    STRIP.fitPath();
    expect(cam.fits[0].slice(1)).toEqual([0.85, 50, 60]);
  });
});
