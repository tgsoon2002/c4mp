import * as fs from 'fs';
import * as path from 'path';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';
import { simHtml, simModel } from './helpers/sim-view';

// Phase 25 UI13 (b763): viewer/sim-sequence.js, the sequence drawer (#seq-drawer) under the map, and viewer/drawer-resize.js
// (its height drag, shared with the board drawer). The page is simHtml() (test/helpers/sim-view.ts): flow s-1 (7 steps: io,
// io, arch, arch (unverified), storage, arch, io) and journey s-2 (outside, s-1 inline, outside: 9 steps in 3 stages).
// b853 S5 (b866): the rows are the flow steps and the lanes the lanes at the window's depth (C4PM_SIM.flow() / lanes());
// the default depth is code, so the tests below the depth block compare with SIM.flow() / SIM.lanes(), not sim.steps / sim.lanes.

const IDS = ['seq-drawer', 'seq-drawer-edge', 'seq-bar', 'seq-body', 'center', 'simbar', 'view-toast', 'btn-gear', 'settings-pop'];
const STORE = () => { const s: Record<string, string> = {}; return { __s: s, getItem: (k: string) => (k in s ? s[k] : null), setItem: (k: string, v: string) => { s[k] = String(v); } }; };
function load(opts: { html?: string; globals?: Record<string, unknown> } = {}): HarnessResult {
  return runViewerScripts(opts.html ?? simHtml(), { extraIds: IDS, globals: { localStorage: STORE(), ...(opts.globals || {}) } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const $ = (h: HarnessResult, id: string) => (h.sandbox.document as any).getElementById(id) as FakeEl & { hidden?: boolean };
const has = (e: FakeEl, c: string) => e.classList.contains(c);
const svg = (h: HarnessResult) => $(h, 'seq-body').children[0];
const kids = (e: FakeEl, cls: string) => e.querySelectorAll('.' + cls);
const rows = (h: HarnessResult) => kids(svg(h), 'sq-row');
const textOf = (e: FakeEl) => e.querySelectorAll('text').map((t) => t.textContent);
const arrowOf = (row: FakeEl) => row.querySelector('.sq-arrow')!;
const labelOf = (row: FakeEl) => row.querySelector('.sq-label')!.textContent;
const barTexts = (h: HarnessResult) => $(h, 'seq-bar').children.map((c) => c.textContent || c.children.map((b) => b.textContent).join(''));
function open(h: HarnessResult, id = 's-1') {
  SIM(h).select(id);
  SIM(h).act('seq');
}

describe('a page without s-items', () => {
  it('sim-sequence.js does nothing: no C4PM_SIMSEQ, the drawer untouched', () => {
    const h = load({ html: renderViewHtml(storageModel()) });
    expect(win(h).C4PM_SIMSEQ).toBeUndefined();
    expect($(h, 'seq-drawer').hidden).toBeUndefined();
    expect(win(h).C4PM_DRAWER.drawerResize).toEqual(expect.any(Function));   // the shared helper loads on every page
  });
});

describe('open and close', () => {
  it('closed at load; opens only with an s-item; act(seq) toggles; ✕ and clearing the s-item close it', () => {
    const h = load();
    const d = $(h, 'seq-drawer');
    expect(d.hidden).toBe(true);
    win(h).C4PM_SIMSEQ.setSeq(true);
    expect(d.hidden).toBe(true);   // nothing selected
    open(h);
    expect([d.hidden, has($(h, 'root'), 'seq-open'), win(h).C4PM_SIMSEQ.isOpen()]).toEqual([false, true, true]);
    SIM(h).act('seq');
    expect([d.hidden, has($(h, 'root'), 'seq-open')]).toEqual([true, false]);
    SIM(h).act('seq');
    const close = $(h, 'seq-bar').children.find((c) => c.textContent === '✕')!;
    close.click();
    expect(d.hidden).toBe(true);
    SIM(h).act('seq');
    SIM(h).select(null);
    expect(d.hidden).toBe(true);
  });

  it("the change listeners get what 'seq' on open and on close (only when it changes); the strip shows ✓ while open", () => {
    const h = load();
    SIM(h).select('s-1');
    const seen: string[] = [];
    SIM(h).onChange((e: { what: string }) => seen.push(e.what));
    const strip = () => $(h, 'simbar').querySelectorAll('.sb-btn').map((b) => b.textContent).find((t) => t.startsWith('≡'));
    SIM(h).hooks.seq(true);
    expect(strip()).toBe('≡ Sequence ✓');
    SIM(h).hooks.seq(true);   // already open: no event
    SIM(h).hooks.seq(false);
    expect(strip()).toBe('≡ Sequence');
    expect(seen).toEqual(['seq', 'seq']);
  });

  it('the map is fitted again after a change: whole path without a cursor, the cursor step when it is in this view', () => {
    const h = load();
    const SS = win(h).C4PM_SIMSTRIP;
    const log: string[] = [];
    SS.fitPath = () => log.push('fitPath');
    SS.flyStep = (st: { n: number }) => log.push('fly ' + st.n);
    open(h);
    expect(log).toEqual(['fitPath']);
    const archStep = SIM(h).steps().find((s: { view: string }) => s.view === 'arch');
    SIM(h).go(archStep.i);
    SIM(h).act('seq');   // close with the cursor on an arch step (this view)
    expect(log).toEqual(['fitPath', 'fly ' + archStep.n]);
  });
});

describe('the bar', () => {
  it('title, s-item, lanes text, ‹ ›, whole path / Step N/M, Own window (UI14), ✕', () => {
    const h = load();
    open(h);
    // b853 S5: the default depth is code, so the lanes text names the functions and tables
    expect(barTexts(h)).toEqual(['Sequence', 's-1 · Place an order · lanes = the functions and tables the steps run in, the person', '', '‹›',
      'whole path · 7 steps', '⧉ Own window', '✕']);
    const own = $(h, 'seq-bar').children[5] as FakeEl & { disabled?: boolean };
    expect(own.disabled).toBeFalsy();
    SIM(h).go(2);
    expect(barTexts(h)[4]).toBe('Step 3/7');
    const [prev, next] = $(h, 'seq-bar').children[3].children;
    next.click();
    expect(SIM(h).step()).toBe(3);
    prev.click();
    prev.click();
    expect(SIM(h).step()).toBe(1);
    SIM(h).select('s-2');   // the drawer follows the selection
    expect(barTexts(h)[1]).toBe('s-2 · Come back and buy · lanes = the functions and tables the steps run in, the person and the outside senders');
  });

  it.each([
    ['context', 'the system, persons and externals'],
    ['container', 'the containers'],   // today's exact text
    ['component', 'the components'],
    ['code', 'the functions and tables'],
  ])('b853 S5: the lanes text at %s', (d, words) => {
    const h = load();
    open(h);
    SIM(h).setDepth(d);
    expect(barTexts(h)[1]).toBe('s-1 · Place an order · lanes = ' + words + ' the steps run in, the person');
    SIM(h).select('s-2');
    expect(barTexts(h)[1]).toBe('s-2 · Come back and buy · lanes = ' + words + ' the steps run in, the person and the outside senders');
  });
});

describe('the diagram', () => {
  // b853 S5: the lanes at the depth (default code: SIM.lanes() lists functions and tables, not sim.lanes' containers).
  it('one lane head per SIM.lanes() entry, in that order, with name, sub and kind class; one lifeline each', () => {
    const h = load();
    open(h, 's-2');
    const lanes = SIM(h).lanes();
    const heads = kids(svg(h), 'sq-lane-head');
    expect(heads.map((g) => textOf(g))).toEqual(lanes.map((l: { name: string; sub: string }) => [l.name, l.sub]));
    expect(heads.map((g) => g.className.split(' ')[1])).toEqual(lanes.map((l: { kind: string }) => 'k-' + l.kind));
    expect(lanes.map((l: { kind: string }) => l.kind)).toEqual(expect.arrayContaining(['person', 'outside', 'container']));
    expect(kids(svg(h), 'sq-lifeline').length).toBe(lanes.length);
  });

  // b853 S5: rows over SIM.flow() (at code one flow step per step, its call ends = at.code).
  it('one row per step with its number and view word; same lane = a loop (path), two lanes = a line', () => {
    const h = load();
    open(h);
    const steps = SIM(h).flow();
    expect(rows(h).map((r) => r.querySelector('.sq-num')!.querySelector('text')!.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(rows(h).map((r) => r.querySelector('.sq-view')!.textContent)).toEqual(['IO', 'IO', 'ARCH', 'ARCH', 'STORAGE', 'ARCH', 'IO']);
    expect(rows(h).map((r) => r.querySelector('.sq-view')!.className)).toEqual(['sq-view v-io', 'sq-view v-io', 'sq-view v-arch', 'sq-view v-arch', 'sq-view v-storage', 'sq-view v-arch', 'sq-view v-io']);
    rows(h).forEach((r, i) => {
      const c = steps[i].call;
      expect(arrowOf(r).tagName).toBe(c.fromLane === c.toLane ? 'PATH' : 'LINE');
      expect(r.getAttribute('data-step')).toBe(String(i));
    });
    expect(rows(h).some((r) => arrowOf(r).tagName === 'PATH')).toBe(true);
    expect(rows(h).some((r) => arrowOf(r).tagName === 'LINE')).toBe(true);
  });

  // b853 S5: at code (the default) Routes and OrderService.create are two lanes, so that call is a line without the names.
  // Container cannot keep the old check either: there the step merges with Routes and its api -> api self-arrow is dropped
  // (see the depth block). The "names both ends" rule is checked on a page without the depth data (an old page: sim-flow.js
  // falls back to sim.lanes and today's call lanes at every depth), where both ends run in the api lane as before.
  it('labels: the call label; a call inside one lane names both ends; an unverified step says so', () => {
    const h = load();
    open(h);
    const steps = SIM(h).flow();
    const i = steps.findIndex((s: { unverified?: string }) => s.unverified);
    expect(steps[i].call.fromLane).not.toBe(steps[i].call.toLane);   // code: the Routes lane -> the Services.create lane
    expect([arrowOf(rows(h)[i]).tagName, labelOf(rows(h)[i])]).toEqual(['LINE', 'create(order)   ? unverified']);
    expect(labelOf(rows(h)[0])).toBe(steps[0].call.label);
    const m = simModel();
    m.sims!.forEach((s) => { delete (s as { depth?: unknown }).depth; });
    const old = load({ html: renderViewHtml(m) });
    open(old);
    const st = SIM(old).flow()[i];
    expect(st.call.fromLane).toBe(st.call.toLane);   // fixture: routes -> OrderService.create, both in the api lane
    expect(labelOf(rows(old)[i])).toBe('create(order)  (' + SIM(old).byId('s-1').steps[i - 1].targets[0].name + ' → ' + st.targets[0].name + ')   ? unverified');
  });

  it('classes: cur on band, number, arrow and label; unver; reply; out (outside step); markers per state', () => {
    const m = simModel();
    m.sims![0].steps[6].call!.reply = true;
    const h = load({ html: renderViewHtml(m) });
    open(h);
    const unver = SIM(h).steps().findIndex((s: { unverified?: string }) => s.unverified);
    SIM(h).go(unver);
    const r = rows(h)[unver];
    expect(['sq-band', 'sq-num', 'sq-arrow', 'sq-label'].map((c) => has(r.querySelector('.' + c)!, 'cur'))).toEqual([true, true, true, true]);
    expect([has(arrowOf(r), 'unver'), has(r.querySelector('.sq-label')!, 'unver'), arrowOf(r).getAttribute('marker-end')]).toEqual([true, true, 'url(#sq-unver)']);
    expect(rows(h).filter((x) => has(x.querySelector('.sq-band')!, 'cur')).length).toBe(1);
    const reply = arrowOf(rows(h)[6]);
    expect([has(reply, 'reply'), reply.getAttribute('marker-end')]).toEqual([true, 'url(#sq-ret)']);
    expect(arrowOf(rows(h)[0]).getAttribute('marker-end')).toBe('url(#sq-ink)');
    SIM(h).go(0);
    expect(arrowOf(rows(h)[0]).getAttribute('marker-end')).toBe('url(#sq-flow)');
    expect(kids(svg(h), 'sq-mk-ret').length).toBe(1);   // the four markers are defined once each
    SIM(h).select('s-2');
    const out = arrowOf(rows(h)[0]);
    expect([has(out, 'out'), labelOf(rows(h)[0])]).toEqual([true, 'Newsletter tool: Reads the newsletter']);
    expect(labelOf(rows(h)[8])).toBe('Gets the receipt by email');   // no sender
  });

  it('journey: stage rows with goals, a dashed frame over the flow stage with its tab', () => {
    const h = load();
    open(h, 's-2');
    expect(kids(svg(h), 'sq-stage').map((t) => t.textContent)).toEqual(['STAGE 1 · DISCOVER', 'STAGE 2 · BUY', 'STAGE 3 · FOLLOW-UP']);
    expect(kids(svg(h), 'sq-goal').map((t) => t.textContent)).toEqual(['goal: Place the order']);
    expect(kids(svg(h), 'sq-frame').length).toBe(1);
    expect(textOf(kids(svg(h), 'sq-tab')[0])).toEqual(['flow s-1 · Place an order']);
    expect(rows(h).length).toBe(9);
    const flow = load();
    open(flow);
    expect([kids(svg(flow), 'sq-stage').length, kids(svg(flow), 'sq-frame').length]).toEqual([0, 0]);
  });

  it('a row click goes to that step with the fly; data goes in as text, no http(s):// anywhere in the SVG', () => {
    const h = load();
    open(h);
    const flown: number[] = [];
    SIM(h).hooks.fly = (st: { n: number }) => flown.push(st.n);
    rows(h)[4].click();
    expect([SIM(h).step(), flown]).toEqual([4, [5]]);
    expect(has(rows(h)[4].querySelector('.sq-band')!, 'cur')).toBe(true);
    const all: string[] = [];
    const walk = (e: FakeEl) => { all.push(...Object.values(e.attrs), e._html); e.children.forEach(walk); };
    walk(svg(h));
    expect(all.join(' ')).not.toMatch(/https?:\/\//);
    expect(all.join('')).toBe(all.join('').replace(/</g, ''));   // nothing went in as markup
    const src = fs.readFileSync(path.join(__dirname, '..', 'viewer', 'sim-sequence.js'), 'utf8');
    expect(src).not.toMatch(/https?:\/\//);
  });
});

// b853 S5 (b866): the rows are the flow steps and the lanes the lanes at the window's depth (C4PM_SIM.setDepth).
// s-1 at container: groups [[0,1],[2,3],[4],[5],[6]] (S1); at code one row per step, lanes per function / table.
describe('depth (b853 S5)', () => {
  type Lane = { id: string; name: string; kind: string };
  const kindOf = (g: FakeEl) => g.className.split(' ')[1];
  const headOf = (h: HarnessResult, id: string) => kids(svg(h), 'sq-lane-head').find((g) => g.getAttribute('data-lane') === id)!;
  const midX = (g: FakeEl) => { const r = g.querySelector('rect')!; return Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2; };

  it('container on s-1: 5 rows numbered 1-5, data-step 0-4; the row title joins the captions; a click goes to the first step', () => {
    const m = simModel();
    m.sims![0].steps[3].caption = 'create the order';   // flow step 2 = steps 2 + 3: two captions
    const h = load({ html: renderViewHtml(m) });
    open(h);
    expect(rows(h).length).toBe(7);
    SIM(h).setDepth('container');   // the open drawer follows the depth
    expect(rows(h).map((r) => r.querySelector('.sq-num')!.querySelector('text')!.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(rows(h).map((r) => r.getAttribute('data-step'))).toEqual(['0', '1', '2', '3', '4']);
    expect(barTexts(h)[4]).toBe('whole path · 5 steps');
    expect(rows(h)[1].querySelector('title')!.textContent).toBe('Step 2: POST /orders · create the order');
    // the api -> api self-arrow of create is dropped above code: the row keeps Routes' arrow and says unverified
    expect([arrowOf(rows(h)[1]).tagName, labelOf(rows(h)[1])]).toEqual(['LINE', '   ? unverified']);
    rows(h)[2].click();
    expect(SIM(h).step()).toBe(4);
    SIM(h).go(3);
    expect([barTexts(h)[4], rows(h).map((r) => has(r, 'cur'))]).toEqual(['Step 2/5', [false, true, false, false, false]]);
  });

  it('container: one lane head per SIM.lanes() entry, names and kinds (container = today\'s sim.lanes)', () => {
    const h = load();
    open(h);
    SIM(h).setDepth('container');
    const lanes: Lane[] = SIM(h).lanes();
    expect(lanes).toEqual(SIM(h).byId('s-1').lanes);
    expect(kids(svg(h), 'sq-lane-head').map((g) => [textOf(g)[0], kindOf(g)])).toEqual(lanes.map((l) => [l.name, 'k-' + l.kind]));
  });

  it('context: a k-system head beside the person', () => {
    const h = load();
    open(h);
    SIM(h).setDepth('context');
    const kinds = kids(svg(h), 'sq-lane-head').map(kindOf);
    expect(kinds).toEqual(SIM(h).lanes().map((l: Lane) => 'k-' + l.kind));
    expect(kinds).toEqual(expect.arrayContaining(['k-person', 'k-system']));
  });

  it('code (default): function and table lanes; the storage row runs from Services.create into the classes record lane', () => {
    const h = load();
    open(h);
    expect(SIM(h).depth()).toBe('code');
    const lanes: Lane[] = SIM(h).lanes();
    expect(lanes.map((l) => l.kind)).toEqual(expect.arrayContaining(['code', 'record']));
    const fn = lanes.find((l) => l.kind === 'code')!, record = lanes.find((l) => l.kind === 'record')!;
    expect([kindOf(headOf(h, fn.id)), kindOf(headOf(h, record.id))]).toEqual(['k-code', 'k-record']);
    const k = SIM(h).flow().findIndex((s: { view: string }) => s.view === 'storage');
    const a = arrowOf(rows(h)[k]);
    expect(a.tagName).toBe('LINE');
    const x1 = Number(a.getAttribute('x1')), x2 = Number(a.getAttribute('x2')), d = Math.sign(x2 - x1);
    expect(x1 - 3 * d).toBeCloseTo(midX(headOf(h, fn.id)));
    expect(x2 + 4 * d).toBeCloseTo(midX(headOf(h, record.id)));
  });

  it('a call end with no arch node is named by its lane (SIM.nameOfId): the storage fallback lane app.api is "Api"', () => {
    const m = simModel();
    const st = m.sims![0].steps[5] as { at: Record<string, { from: string; to: string }> };   // Payments: call app.api -> api
    st.at.code.to = st.at.code.from;   // both ends in one lane at code: a loop that names both ends
    const h = load({ html: renderViewHtml(m) });
    open(h);
    expect(labelOf(rows(h)[5])).toBe('  (Api → Api)');
  });
});

// UI14 (b764): "⧉ Own window" and the window it opens ('&seqonly' in the hash).
describe('own window (UI14)', () => {
  const at = (hash: string, open?: (...a: unknown[]) => unknown) => {
    const calls: unknown[][] = [];
    const h = load({ globals: { location: { href: 'file:///x.html?a=1' + hash, hash }, open: (...a: unknown[]) => { calls.push(a); return open ? open(...a) : null; } } });
    return { h, calls };
  };
  const ownBtn = (h: HarnessResult) => $(h, 'seq-bar').children.find((c) => c.textContent === '⧉ Own window')!;
  // As test/viewer-sim-core.test.ts: a keydown on the document, counting preventDefault / stopPropagation.
  function key(h: HarnessResult, k: string, target: unknown = { tagName: 'DIV' }, mods: Record<string, boolean> = {}) {
    const e = {
      key: k, target, ...mods, prevented: 0, stopped: 0, defaultPrevented: false,
      preventDefault() { e.prevented++; e.defaultPrevented = true; }, stopPropagation() { e.stopped++; },
    };
    (h.sandbox.document as any).dispatch('keydown', e);
    return e;
  }

  it('opens this page with #<view>&seqonly&sim=<id> (+ &step=<n> with a cursor), named c4pm-seq, 1100x520, focused', () => {
    const focus = jest.fn();
    const { h, calls } = at('#arch', () => ({ focus }));
    open(h);
    ownBtn(h).click();
    SIM(h).go(2);
    ownBtn(h).click();
    SIM(h).setDepth('container');
    ownBtn(h).click();
    // b853 S5: the URL carries this window's depth (&depth=, read once by the own window, not saved there)
    expect(calls).toEqual([
      ['file:///x.html?a=1#arch&seqonly&sim=s-1&depth=code', 'c4pm-seq', 'popup,width=1100,height=520'],
      ['file:///x.html?a=1#arch&seqonly&sim=s-1&step=3&depth=code', 'c4pm-seq', 'popup,width=1100,height=520'],
      ['file:///x.html?a=1#arch&seqonly&sim=s-1&step=3&depth=container', 'c4pm-seq', 'popup,width=1100,height=520'],
    ]);
    expect(focus).toHaveBeenCalledTimes(3);
    expect($(h, 'view-toast').hidden).not.toBe(false);
  });

  it('b853 S5: #arch&seqonly&sim=s-1&depth=container opens the own window at container: 5 rows', () => {
    const { h } = at('#arch&seqonly&sim=s-1&depth=container');
    h.flushTimers();
    expect([SIM(h).depth(), rows(h).length]).toEqual(['container', 5]);
  });

  it.each([
    ['null', () => null],
    ['throwing', () => { throw new Error('blocked'); }],
  ])('a blocked (%s) open shows the toast naming the hash', (_n, fn) => {
    const { h } = at('#arch', fn);
    open(h);
    ownBtn(h).click();
    expect([$(h, 'view-toast').hidden, $(h, 'view-toast').textContent]).toEqual([false,
      'The browser blocked the new window. The sequence window is this page with #arch&seqonly&sim=s-1.']);
  });

  it('#arch&seqonly&sim=s-1&step=2: class seq-only, the drawer open, cursor 1, no view switch, no Own window / ✕', () => {
    const { h } = at('#arch&seqonly&sim=s-1&step=2');
    expect(has($(h, 'root'), 'seq-only')).toBe(true);
    h.flushTimers();
    expect([SIM(h).selected(), SIM(h).step(), win(h).C4PM_MODE.get(), $(h, 'seq-drawer').hidden]).toEqual(['s-1', 1, 'arch', false]);
    expect(win(h).location.hash).toBe('#arch&seqonly&sim=s-1&step=2');   // no fly: the step's view (IO) was not opened
    expect(barTexts(h)).toEqual(['Sequence', 's-1 · Place an order · lanes = the functions and tables the steps run in, the person', '', '‹›', 'Step 2/7']);   // b853 S5: code text
    SIM(h).act('seq');   // the drawer cannot be closed in its own window
    expect($(h, 'seq-drawer').hidden).toBe(false);
  });

  it('a row click (and ‹ ›) moves the cursor only and posts the sim link message; the mode does not change', () => {
    const { h } = at('#arch&seqonly&sim=s-1');
    h.flushTimers();
    const posts: unknown[][] = [];
    win(h).C4PM_LINK.post = (...a: unknown[]) => posts.push(a);
    rows(h)[1].click();   // an IO step
    expect([SIM(h).step(), win(h).C4PM_MODE.get()]).toEqual([1, 'arch']);
    expect(posts).toEqual([['sim', { sim: 's-1', step: 1 }, { replay: true }]]);
    $(h, 'seq-bar').children[3].children[1].click();   // ›
    expect([SIM(h).step(), win(h).C4PM_MODE.get(), win(h).location.hash]).toEqual([2, 'arch', '#arch&seqonly&sim=s-1']);
    expect(has(rows(h)[2].querySelector('.sq-band')!, 'cur')).toBe(true);
  });

  it('follows the selection the link brings: a clear closes the drawer, another s-item opens it again', () => {
    const { h } = at('#arch&seqonly&sim=s-1');
    h.flushTimers();
    SIM(h).select(null, { remote: true });
    expect($(h, 'seq-drawer').hidden).toBe(true);
    SIM(h).select('s-2', { remote: true });
    expect([$(h, 'seq-drawer').hidden, barTexts(h)[1].startsWith('s-2 · ')]).toEqual([false, true]);
  });

  it('b797: Esc does nothing in the own window: s-item, cursor, drawer stay; no link message; stopped', () => {
    const { h } = at('#arch&seqonly&sim=s-1&step=2');
    h.flushTimers();
    const posts: unknown[][] = [];
    win(h).C4PM_LINK.post = (...a: unknown[]) => posts.push(a);
    const bubble = jest.fn();
    (h.sandbox.document as any).addEventListener('keydown', (e: { key: string }) => bubble(e.key));
    const e = key(h, 'Escape');
    expect([SIM(h).selected(), SIM(h).step(), $(h, 'seq-drawer').hidden]).toEqual(['s-1', 1, false]);
    expect(posts).toEqual([]);
    expect([e.stopped, e.prevented]).toEqual([1, 0]);   // no preventDefault: the browser's own Esc (leave full screen) works
    expect(bubble).not.toHaveBeenCalledWith('Escape');
    key(h, 'ArrowRight');
    expect(SIM(h).step()).toBe(2);
  });

  it('a page without &seqonly has no seq-only class', () => {
    const { h } = at('#arch&sim=s-1');
    h.flushTimers();
    expect(has($(h, 'root'), 'seq-only')).toBe(false);
  });
});

describe('height (drawer-resize.js)', () => {
  const drag = (h: HarnessResult, y0: number, y1: number) => {
    const edge = $(h, 'seq-drawer-edge');
    edge.dispatch('pointerdown', { clientY: y0, pointerId: 1 });
    edge.dispatch('pointermove', { clientY: y1, pointerId: 1 });
    edge.dispatch('pointerup', { clientY: y1, pointerId: 1 });
  };

  it('drag up grows it; clamped to 150 px and 78% of #center; stored as c4mp.seqH; --seq-h on the drawer', () => {
    const h = load();
    open(h);
    $(h, 'center').clientHeight = 1000;
    $(h, 'seq-drawer').clientHeight = 300;
    drag(h, 500, 400);
    expect($(h, 'seq-drawer').style['--seq-h']).toBe('400px');
    expect((h.sandbox.localStorage as any).__s['c4mp.seqH']).toBe('400');
    drag(h, 500, 2000);
    expect($(h, 'seq-drawer').style['--seq-h']).toBe('150px');
    drag(h, 500, -5000);
    expect(win(h).C4PM_SIMSEQ.height()).toBe(780);
    expect(win(h).C4PM_SIMSEQ.setHeight(10)).toBe(150);
    expect(win(h).C4PM_SIMSEQ.setHeight(NaN)).toBe(150);
  });

  it('a stored height comes back at load; storage that throws breaks nothing', () => {
    const s = STORE();
    s.setItem('c4mp.seqH', '333');
    const h = load({ globals: { localStorage: s } });
    expect($(h, 'seq-drawer').style['--seq-h']).toBe('333px');
    const t = load({ globals: { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } } });
    open(t);
    expect(() => win(t).C4PM_SIMSEQ.setHeight(300)).not.toThrow();
    expect($(t, 'seq-drawer').style['--seq-h']).toBe('300px');
  });
});
