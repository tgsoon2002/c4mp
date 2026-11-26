import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { storageModel, CLASSES } from './helpers/storage-view';
import { simHtml, simModel, CREATE } from './helpers/sim-view';

// Phase 25 UI3 (b753): viewer/sim.js, the simulation core (C4PM_SIM): selection and step cursor, the lit state per view
// (C4PM_STATE.map.sim), the sample-row state per step, keys, hash extras, goView. The page is simHtml() (test/helpers/sim-view.ts):
// flow s-1 (7 steps over IO, arch and storage) and journey s-2 (outside, s-1 inline, outside), built by buildViewSims.

const IDS = ['btn-gear', 'settings-pop'];
function load(hash?: string, html = simHtml()): HarnessResult {
  const globals: Record<string, unknown> = hash === undefined ? {} : { location: { href: 'file:///x.html' + hash, hash } };
  return runViewerScripts(html, { extraIds: IDS, globals });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const doc = (h: HarnessResult) => h.sandbox.document as any;
const lit = (h: HarnessResult) => Object.fromEntries(win(h).C4PM_STATE.map.sim.ids);
function key(h: HarnessResult, k: string, target: unknown = { tagName: 'DIV' }, mods: Record<string, boolean> = {}) {
  const e = {
    key: k, target, ...mods, prevented: 0, stopped: 0, defaultPrevented: false,
    preventDefault() { e.prevented++; e.defaultPrevented = true; }, stopPropagation() { e.stopped++; },
  };
  doc(h).dispatch('keydown', e);
  return e;
}

describe('a page without s-items', () => {
  it.each([['no sims key', storageModel()], ['an empty list', Object.assign(storageModel(), { sims: [] })]])('%s: C4PM_SIM stays undefined, map.sim null', (_, model) => {
    const h = load(undefined, renderViewHtml(model));
    expect(win(h).C4PM_SIM).toBeUndefined();
    expect(win(h).C4PM_STATE.map.sim).toBeNull();
    expect(() => key(h, 'ArrowRight')).not.toThrow();
  });
});

describe('the fixture (buildViewSims on the sample ids)', () => {
  it('s-1 has 7 steps on the real node ids, step 4 unverified; s-2 plays s-1 inline (9 steps)', () => {
    const [s1, s2] = simModel().sims!;
    expect(s1.steps.map((s) => s.targets[0].nodeId)).toEqual(['shop.web.login', 'shop.web.home', 'api/routes', CREATE, CLASSES, 'api/payments', 'shop.web.cart']);
    expect(s1.steps.map((s) => s.view)).toEqual(['io', 'io', 'arch', 'arch', 'storage', 'arch', 'io']);
    expect(s1.steps[3].unverified).toBeTruthy();
    expect(s2.steps.map((s) => s.view)).toEqual(['outside', 'io', 'io', 'arch', 'arch', 'storage', 'arch', 'io', 'outside']);
    expect(s2.steps[4].unverified).toBeTruthy();
  });
});

describe('select / go / act', () => {
  it('select sets the s-item with no cursor; an unknown id clears; listeners hear each change', () => {
    const h = load();
    const S = SIM(h);
    const heard: any[] = [];
    S.onChange((e: any) => heard.push({ ...e }));
    expect(S.items().map((s: any) => s.id)).toEqual(['s-1', 's-2']);
    expect(S.selected()).toBeNull();
    S.select('s-1');
    expect([S.selected(), S.step(), S.curStep()]).toEqual(['s-1', null, null]);
    expect(S.byId('s-2').kind).toBe('journey');
    expect(S.byId('nope')).toBeNull();
    S.go(2);
    expect(S.step()).toBe(2);
    expect(S.curStep().n).toBe(3);
    S.select('nope');
    expect([S.selected(), S.step()]).toEqual([null, null]);
    expect(heard).toEqual([{ sim: 's-1', step: null, what: 'select' }, { sim: 's-1', step: 2, what: 'step' }, { sim: null, step: null, what: 'select' }]);
  });

  it('go clamps, null or a non-integer = no step; without an s-item it does nothing', () => {
    const S = SIM(load());
    S.go(3);
    expect(S.step()).toBeNull();
    S.select('s-1');
    S.go(99);
    expect(S.step()).toBe(6);
    S.go(-5);
    expect(S.step()).toBe(0);
    S.go(null);
    expect(S.step()).toBeNull();
    S.go(1.5);
    expect(S.step()).toBeNull();
    expect(S.steps().length).toBe(7);
    expect(S.steps('s-2').length).toBe(9);
    expect(S.steps('nope')).toEqual([]);
  });

  it('act: next / prev step with a fly (from no cursor: first / last), whole, clear, present, seq; an unknown name throws', () => {
    const S = SIM(load());
    const calls: any[] = [];
    Object.assign(S.hooks, {
      fly: (st: any) => calls.push(['fly', st.n]), fitPath: () => calls.push(['fit']),
      present: (id: string, i: number) => calls.push(['present', id, i]), seq: (on?: boolean) => calls.push(['seq', on]),
    });
    S.act('next');
    expect(calls).toEqual([]);   // no s-item: nothing
    S.select('s-1');
    expect(calls).toEqual([['fit']]);
    S.act('next');
    expect(S.step()).toBe(0);
    S.act('next');
    S.act('prev');
    S.act('prev');   // stays at the first
    expect(S.step()).toBe(0);
    S.act('whole');
    expect(S.step()).toBeNull();
    S.act('prev');
    expect(S.step()).toBe(6);
    S.act('present');
    S.act('seq');
    S.act('clear');
    expect(S.selected()).toBeNull();
    expect(calls).toEqual([['fit'], ['fly', 1], ['fly', 2], ['fly', 1], ['fly', 1], ['fit'], ['fly', 7], ['present', 's-1', 6], ['seq', undefined], ['seq', false]]);
    expect(() => S.act('jump')).toThrow(/unknown action/);
  });

  it('select with fit false does not fit; while presenting, go hands the index to presentGo and select ends present', () => {
    const S = SIM(load());
    const calls: any[] = [];
    let on = false;
    Object.assign(S.hooks, {
      fitPath: () => calls.push('fit'), presenting: () => on, presentGo: (i: number) => calls.push(['presentGo', i]), presentEnd: () => { on = false; calls.push('end'); },
    });
    S.select('s-1', { fit: false });
    expect(calls).toEqual([]);
    on = true;
    S.go(4);
    expect(calls).toEqual([['presentGo', 4]]);
    S.go(5, { fromPres: true });
    expect(S.step()).toBe(5);
    S.select('s-2', { fromPres: true, fit: false });
    expect(on).toBe(true);
    S.select('s-1', { fit: false });
    expect(calls).toEqual([['presentGo', 4], 'end']);
  });
});

describe('map.sim: what each view lights', () => {
  it('arch: targets, both ends of each call, the calls with both ends drawn, the steps here; current flags', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    S.go(3);
    const sim = win(h).C4PM_STATE.map.sim;
    expect(sim).toMatchObject({ id: 's-1', step: 3, view: 'arch', cur: 3 });
    expect(lit(h)).toEqual({
      api: { ns: [3, 5, 6, 7], cur: false },
      'api/routes': { ns: [3, 4], cur: true },
      [CREATE]: { ns: [4], cur: true },
      'api/payments': { ns: [6], cur: false },
    });
    expect(sim.calls).toEqual([{ n: 4, from: 'api/routes', to: CREATE, label: 'create(order)', unverified: true, cur: true, reply: false }]);
    expect(sim.list).toEqual([
      { n: 3, i: 2, ids: ['api/routes'], cur: false }, { n: 4, i: 3, ids: [CREATE], cur: true }, { n: 6, i: 5, ids: ['api/payments'], cur: false },
    ]);
    expect(S.litFor('arch').calls).toEqual(sim.calls);
  });

  it('a mode change recomputes it: io lights the screens, storage the record (target and rows); clearing sets null', () => {
    const h = load();
    const S = SIM(h);
    const heard: string[] = [];
    S.onChange((e: any) => heard.push(e.what));
    S.select('s-1');
    S.go(4);
    win(h).C4PM_MODE.set('io');
    expect(win(h).C4PM_STATE.map.sim.view).toBe('io');
    expect(lit(h)).toEqual({ 'shop.web.login': { ns: [1], cur: false }, 'shop.web.home': { ns: [2], cur: false }, 'shop.web.cart': { ns: [7], cur: false } });
    expect(win(h).C4PM_STATE.map.sim.calls).toEqual([]);
    win(h).C4PM_MODE.set('storage');
    expect(lit(h)).toEqual({ [CLASSES]: { ns: [5, 6], cur: true } });
    expect(win(h).C4PM_STATE.map.sim.list).toEqual([{ n: 5, i: 4, ids: [CLASSES], cur: true }]);
    expect(win(h).C4PM_STATE.map.sim.tables[CLASSES].touched).toBe(true);
    S.select(null);
    expect(win(h).C4PM_STATE.map.sim).toBeNull();
    expect(heard).toEqual(['select', 'step', 'view', 'view', 'select']);
    win(h).C4PM_MODE.set('arch');
    expect(heard).toHaveLength(5);   // no s-item: a mode change says nothing
  });

  it('outside steps light nothing; the journey numbers its inline flow steps on', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-2');
    S.go(0);
    expect(lit(h)['api/routes']).toEqual({ ns: [4, 5], cur: false });
    expect(S.stepTarget(S.curStep())).toBe('Reads the newsletter');
    expect(S.litFor('io').list.map((x: any) => x.n)).toEqual([2, 3, 8]);
  });
});

describe('tableStateAt and rowsTableHtml', () => {
  it('no rows yet; the first rows are new; a changed cell and a new row; "as after" a step; the end', () => {
    const S = SIM(load());
    expect(S.tableStateAt('s-1', 3)).toEqual({});
    expect(S.tableStateAt('s-1', 4)).toEqual({
      [CLASSES]: { name: 'classes', cols: ['id', 'name', 'seats'], at: 4, touched: true, rows: [{ vals: { id: 'c-1', name: 'Yoga', seats: 10 }, ins: true, old: {} }] },
    });
    const at5 = S.tableStateAt('s-1', 5)[CLASSES];
    expect(at5).toMatchObject({ at: 5, touched: true });
    expect(at5.rows).toEqual([
      { vals: { id: 'c-1', name: 'Yoga', seats: 9 }, ins: false, old: { seats: 10 } },
      { vals: { id: 'c-2', name: 'Pilates', seats: 12 }, ins: true, old: {} },
    ]);
    const at6 = S.tableStateAt('s-1', 6)[CLASSES];
    expect(at6).toMatchObject({ at: 5, touched: false });
    expect(at6.rows.every((r: any) => !r.ins && !Object.keys(r.old).length)).toBe(true);
    expect(S.tableStateAt('s-1', null)).toEqual(S.tableStateAt('s-1', 6));
    expect(S.tableStateAt('s-2', 6)[CLASSES].at).toBe(6);   // the journey's inline copy of step 6
    expect(S.tableStateAt('nope', 2)).toEqual({});
  });

  it('rowsTableHtml: caption, heads, tr.ins, td.chg with the old value, "unchanged", only, every value escaped', () => {
    const S = SIM(load());
    const html = S.rowsTableHtml(S.tableStateAt('s-1', 5));
    expect(html).toBe('<div class="sim-rows"><table><caption>classes</caption><tr><th>id</th><th>name</th><th>seats</th></tr>' +
      '<tr><td>c-1</td><td>Yoga</td><td class="chg"><s>10</s> → 9</td></tr>' +
      '<tr class="ins"><td>c-2</td><td>Pilates</td><td>12</td></tr></table></div>');
    expect(S.rowsTableHtml(S.tableStateAt('s-1', 6))).toContain('<caption>classes · unchanged</caption>');
    expect(S.rowsTableHtml(S.tableStateAt('s-1', 5), ['other'])).toBe('');
    expect(S.rowsTableHtml({})).toBe('');
    const bad = { r: { name: '<b>t</b>', cols: ['a&b'], at: 0, touched: true, rows: [{ vals: { 'a&b': '"x" <i>' }, ins: false, old: { 'a&b': null } }] } };
    expect(S.rowsTableHtml(bad)).toBe('<div class="sim-rows"><table><caption>&lt;b&gt;t&lt;/b&gt;</caption><tr><th>a&amp;b</th></tr>' +
      '<tr><td class="chg"><s></s> → &quot;x&quot; &lt;i&gt;</td></tr></table></div>');
  });
});

describe('names and views', () => {
  it('nameOf, stepTarget, viewWord', () => {
    const S = SIM(load());
    const st = S.steps('s-1')[3];
    expect(S.nameOf(st.targets[0])).toBe('Services.create');
    expect(S.stepTarget(st)).toBe('Services.create');
    expect(['arch', 'io', 'storage', 'outside', 'x'].map(S.viewWord)).toEqual(['Architecture', 'IO', 'Storage', 'Outside', 'x']);
  });

  it('goView: the current view runs at once; another view switches (no location: C4PM_MODE.set) and runs after the tree loaded', () => {
    const h = load();
    const S = SIM(h);
    const ran: string[] = [];
    S.goView('arch', () => ran.push('arch:' + win(h).C4PM_MODE.get()));
    S.goView('io', () => ran.push('io:' + win(h).C4PM_MODE.get() + ':' + !!win(h).C4PM_MAP.nodeById('shop.web.cart')));
    expect(ran).toEqual(['arch:arch', 'io:io:true']);
  });

  it('goView with a location: sets the hash (keeping &bare), runs on hashchange', () => {
    const h = load('#arch&bare');
    const S = SIM(h);
    const ran: string[] = [];
    S.goView('storage', () => ran.push(win(h).C4PM_MODE.get()));
    const loc = win(h).location;
    expect(loc.hash).toBe('#storage&bare');
    expect(ran).toEqual([]);
    h.fireWindowEvent('hashchange');
    expect(ran).toEqual(['storage']);
  });
});

describe('keys', () => {
  it('Esc: the arch rule (QU1): a selected c-item stays and so does the s-item; with none the s-item clears (stopPropagation)', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    win(h).C4PM_MAP.select('api');
    let e = key(h, 'Escape');
    expect([win(h).C4PM_MAP.selectedId(), S.selected(), e.stopped]).toEqual(['api', 's-1', 0]);
    win(h).C4PM_MAP.select(null);
    e = key(h, 'Escape');
    expect([S.selected(), e.stopped]).toEqual([null, 1]);
    e = key(h, 'Escape');   // nothing selected: nothing happens
    expect(e.stopped).toBe(0);
  });

  it('Esc in the IO view: the c-item first (controls.js), then the s-item', () => {
    const h = load();
    const S = SIM(h);
    win(h).C4PM_MODE.set('io');
    S.select('s-1');
    win(h).C4PM_MAP.select('shop.web.cart');
    key(h, 'Escape');
    expect([win(h).C4PM_MAP.selectedId(), S.selected()]).toEqual([null, 's-1']);
    key(h, 'Escape');
    expect(S.selected()).toBeNull();
  });

  it('Esc with a b-item selected leaves the s-item', () => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    win(h).C4PM_BOARD = { selectedId: () => 'b1' };
    key(h, 'Escape');
    expect(S.selected()).toBe('s-1');
    win(h).C4PM_BOARD = { selectedId: () => null };
    key(h, 'Escape');
    expect(S.selected()).toBeNull();
  });

  it('← → step the cursor (preventDefault) only with an s-item; typing is ignored; presentKey goes first', () => {
    const h = load();
    const S = SIM(h);
    expect(key(h, 'ArrowRight').prevented).toBe(0);
    S.select('s-1');
    expect(key(h, 'ArrowRight').prevented).toBe(1);
    expect(S.step()).toBe(0);
    key(h, 'ArrowRight');
    expect(S.step()).toBe(1);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) key(h, 'ArrowLeft', { tagName });
    key(h, 'Escape', { tagName: 'DIV', isContentEditable: true });
    expect([S.selected(), S.step()]).toEqual(['s-1', 1]);
    key(h, 'ArrowLeft');
    expect(S.step()).toBe(0);
    S.hooks.presentKey = (ev: any) => ev.key === 'ArrowRight';
    const e = key(h, 'ArrowRight');
    expect([S.step(), e.stopped, e.prevented]).toEqual([0, 1, 0]);
  });
});

describe('keys with a modifier', () => {
  it.each(['metaKey', 'ctrlKey', 'altKey', 'shiftKey'])('← / → with %s held change no step and leave defaultPrevented false', (mod) => {
    const h = load();
    const S = SIM(h);
    S.select('s-1');
    S.go(3);
    for (const k of ['ArrowLeft', 'ArrowRight']) {
      const e = key(h, k, { tagName: 'DIV' }, { [mod]: true });
      expect([S.step(), e.defaultPrevented, e.prevented]).toEqual([3, false, 0]);
    }
  });
});

describe('hash extras (read once at load)', () => {
  it('#arch&sim=s-1&step=3 selects and moves the cursor with a fly after the first fit', () => {
    const h = load('#arch&sim=s-1&step=3');
    const S = SIM(h);
    const flown: number[] = [];
    S.hooks.fly = (st: any) => flown.push(st.n);
    expect(S.selected()).toBeNull();
    h.flushTimers();
    expect([S.selected(), S.step(), flown]).toEqual(['s-1', 2, [3]]);
    expect(S.hash()).toEqual({ seqonly: false, sim: 's-1', step: '3' });
  });

  it('&stay=1 keeps the view (no fly); &sims=open, &seq=1, &present=N call their hooks; &seqonly is read', () => {
    const h = load('#io&sim=s-2&step=2&stay=1&sims=open&seq=1&present=4&seqonly&junk=1');
    const S = SIM(h);
    const calls: any[] = [];
    Object.assign(S.hooks, { fly: () => calls.push('fly'), openList: () => calls.push('list'), seq: (on: boolean) => calls.push(['seq', on]), present: (id: string, i: number) => calls.push(['present', id, i]) });
    h.flushTimers();
    expect(win(h).C4PM_MODE.get()).toBe('io');
    expect(S.step()).toBe(1);
    expect(calls).toEqual(['list', ['seq', true], ['present', 's-2', 3]]);
    expect(S.hash()).toEqual({ seqonly: true, sim: 's-2', step: '2', stay: '1', sims: 'open', seq: '1', present: '4' });
  });

  it('an unknown s-id selects nothing', () => {
    const h = load('#arch&sim=s-9');
    h.flushTimers();
    expect(SIM(h).selected()).toBeNull();
  });
});

// UI17 slice 2 (b848): the three hook points sim-present.js fills (presentState, presentGo opts, presentRemote). The
// hooks are the public C4PM_SIM.hooks. The 'sim' handler is reached through a fake BroadcastChannel: the test hands
// link.js's channel a message as a real one would.
describe('UI17 hooks', () => {
  function linked(): { h: HarnessResult; deliver(data: unknown): void } {
    const chans: any[] = [];
    class FakeBC { onmessage: ((ev: { data: unknown }) => void) | null = null; constructor() { chans.push(this); } postMessage() {} close() {} }
    const h = runViewerScripts(simHtml(), { extraIds: IDS, globals: { BroadcastChannel: FakeBC } });
    return { h, deliver: (data) => chans.forEach(c => c.onmessage && c.onmessage({ data })) };
  }

  it('presentState adds its { pres } to the posted sim payload; null leaves the key out', () => {
    const h = load();
    const S = SIM(h);
    const posts: any[][] = [];
    win(h).C4PM_LINK.post = (...a: any[]) => posts.push(a);
    S.select('s-1');
    S.hooks.presentState = () => ({ pres: { lead: true } });
    S.go(1);
    expect(posts[posts.length - 1]).toEqual(['sim', { sim: 's-1', step: 1, pres: { lead: true } }, { replay: true }]);
    S.hooks.presentState = () => null;
    S.go(1);
    const payload = posts[posts.length - 1][1];
    expect(payload).toEqual({ sim: 's-1', step: 1 });
    expect(Object.keys(payload)).toEqual(['sim', 'step']);
  });

  it('while presenting, go hands presentGo the index and the opts', () => {
    const S = SIM(load());
    const calls: any[][] = [];
    Object.assign(S.hooks, { presenting: () => true, presentGo: (...a: any[]) => calls.push(a) });
    S.select('s-1', { fromPres: true, fit: false });
    S.go(2, { remote: true });
    expect(calls).toEqual([[2, { remote: true }]]);
  });

  it('presentRemote gets every received sim message, also one with the same s-item and step', () => {
    const { h, deliver } = linked();
    const S = SIM(h);
    const got: any[] = [];
    S.hooks.presentRemote = (d: any) => got.push(d);
    const msg = { type: 'sim', from: 'w-other', view: 'arch', sim: 's-1', step: 2, pres: { lead: 'w-other' } };
    deliver(msg);
    expect([S.selected(), S.step()]).toEqual(['s-1', 2]);
    deliver(msg);   // nothing changes: select / go are not called, the hook still is
    expect(got).toEqual([msg, msg]);
  });
});
