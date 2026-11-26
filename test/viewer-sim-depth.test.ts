import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { simHtml, CREATE } from './helpers/sim-view';
import { CLASSES } from './helpers/storage-view';

// Phase 25 b853 S3a (b864): the flow depth of viewer/sim.js: C4PM_SIM.depth() / setDepth / DEPTHS (own localStorage key
// 'c4mp.simDepth', the hash extra &depth= read once and not saved) and the flow API over C4PM_SIMFLOW (sim-flow.js):
// flow(id?), flowIndex(i, id?), curFlow(), lanes(id?). The page is simHtml() (test/helpers/sim-view.ts): flow s-1 has 7
// steps (io, io, arch, arch, storage, arch, io); at container the server groups them [[0,1],[2,3],[4],[5],[6]] (S1).
// Nothing visible changes at code (the default).

const KEY = 'c4mp.simDepth';
const IDS = ['btn-gear', 'settings-pop'];
type Store = { __s: Record<string, string>; getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
const STORE = (init: Record<string, string> = {}): Store => {
  const s: Record<string, string> = { ...init };
  return { __s: s, getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); } };
};
const BLOCKED = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
function load(opts: { hash?: string; store?: unknown } = {}): HarnessResult {
  const globals: Record<string, unknown> = {};
  if (opts.store !== undefined) globals.localStorage = opts.store;
  if (opts.hash !== undefined) globals.location = { href: 'file:///x.html' + opts.hash, hash: opts.hash };
  return runViewerScripts(simHtml(), { extraIds: IDS, globals });
}
const SIM = (h: HarnessResult) => (h.sandbox.window as any).C4PM_SIM;
const members = (flow: any[]) => flow.map((f) => f.members);

describe('the depth setting', () => {
  it.each([
    ['no stored value', STORE(), 'code'],
    ['a stored container', STORE({ [KEY]: 'container' }), 'container'],
    ['a stored junk value', STORE({ [KEY]: 'nope' }), 'code'],
    ['a throwing localStorage', BLOCKED, 'code'],
  ])('%s -> depth() %s', (_, store, want) => {
    let h: HarnessResult | undefined;
    expect(() => { h = load({ store }); }).not.toThrow();
    expect(SIM(h!).depth()).toBe(want);
    expect(SIM(h!).DEPTHS).toEqual(['context', 'container', 'component', 'code']);
  });

  it('setDepth saves the key and tells the listeners (what: depth); the same value does nothing; an unknown one throws', () => {
    const store = STORE();
    const S = SIM(load({ store }));
    const heard: any[] = [];
    S.onChange((e: any) => heard.push({ ...e }));
    S.setDepth('container');
    expect(S.depth()).toBe('container');
    expect(store.__s[KEY]).toBe('container');
    S.setDepth('container');
    expect(heard).toEqual([{ sim: null, step: null, what: 'depth' }]);
    expect(() => S.setDepth('nope')).toThrow(/unknown depth/);
    expect(S.depth()).toBe('container');
  });

  it('a throwing localStorage: setDepth still changes the depth, nothing throws', () => {
    const S = SIM(load({ store: BLOCKED }));
    expect(() => S.setDepth('component')).not.toThrow();
    expect(S.depth()).toBe('component');
  });

  it('#arch&sim=s-1&step=4&depth=container: depth() container, the step as usual, nothing saved', () => {
    const store = STORE();
    const h = load({ hash: '#arch&sim=s-1&step=4&depth=container', store });
    expect(SIM(h).depth()).toBe('container');
    h.flushTimers();
    expect(SIM(h).step()).toBe(3);
    expect(SIM(h).hash().depth).toBe('container');
    expect(store.__s[KEY]).toBeUndefined();
  });

  it('a junk &depth= falls back to the stored value', () => {
    const h = load({ hash: '#arch&depth=nope', store: STORE({ [KEY]: 'context' }) });
    expect(SIM(h).depth()).toBe('context');
  });
});

describe('the flow API', () => {
  it('flow of s-1: one flow step per step at code; the S1 groups at container; flowIndex and curFlow map the cursor', () => {
    const S = SIM(load({ store: STORE() }));
    S.select('s-1');
    expect(members(S.flow())).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    expect(S.flow().map((f: any) => f.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(members(S.flow('s-1'))).toEqual(members(S.flow()));
    S.setDepth('container');
    expect(members(S.flow())).toEqual([[0, 1], [2, 3], [4], [5], [6]]);
    expect(S.flowIndex(3)).toBe(1);
    expect(S.flowIndex(6, 's-1')).toBe(4);
    expect(S.flowIndex(null)).toBeNull();
    expect(S.curFlow()).toBeNull();
    S.go(3);
    expect(S.step()).toBe(3);   // the cursor stays the original index
    expect([S.curFlow().first, S.curFlow().last]).toEqual([2, 3]);
  });

  it('b853 S6b: flow(id, d) gives the flow steps at depth d (cached per s-id and d); depth() and flow(id) stay this window\'s', () => {
    const S = SIM(load({ store: STORE() }));
    S.select('s-1');
    const c = S.flow('s-1', 'container');
    expect(members(c)).toEqual([[0, 1], [2, 3], [4], [5], [6]]);
    expect(S.flow('s-1', 'container')).toBe(c);
    expect(S.depth()).toBe('code');
    expect(members(S.flow('s-1'))).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    expect(S.flow('s-1', 'code')).toBe(S.flow('s-1'));
  });

  it('lanes(): the lanes at the depth (container = sim.lanes)', () => {
    const S = SIM(load({ store: STORE() }));
    S.select('s-1');
    S.setDepth('container');
    expect(S.lanes()).toEqual(S.byId('s-1').lanes);
    expect(S.lanes('s-1')).toEqual(S.lanes());
  });

  it('the cache: the same array twice at one depth, a new one after setDepth', () => {
    const S = SIM(load({ store: STORE() }));
    S.select('s-1');
    const a = S.flow();
    expect(S.flow()).toBe(a);
    S.setDepth('container');
    const b = S.flow();
    expect(b).not.toBe(a);
    expect(S.flow()).toBe(b);
    S.setDepth('code');
    expect(S.flow()).not.toBe(a);
    expect(members(S.flow())).toEqual(members(a));
  });

  it('setDepth fits the path once with an s-item and no cursor; with a cursor it does not', () => {
    const S = SIM(load({ store: STORE() }));
    let fits = 0;
    S.hooks.fitPath = () => { fits++; };
    S.setDepth('container');
    expect(fits).toBe(0);   // no s-item
    S.select('s-1');
    fits = 0;
    S.setDepth('component');
    expect(fits).toBe(1);
    S.go(3);
    S.setDepth('code');
    expect(fits).toBe(1);
  });
});

// b853 S3b (b864): lighting and navigation at the chosen depth. litFor / openEarly / act / the fly / stepTarget / nameOfId
// read the flow steps; map.sim adds depth, flowStep (the flow index) and tablesAt (the flow step's last original index).
// The original index stays the cursor (step(), the link message, presentGo). At container s-1 (the S1 fixture):
// flow 1 = [0,1] web (login, home), 2 = [2,3] api (Routes, create: api -> api, a self-arrow), 3 = [4] app.api (classes,
// arrow api -> app.api), 4 = [5] api (Payments, app.api -> api), 5 = [6] web (cart, api -> web). shop.web and app.api are
// not arch nodes, so arch lights only api: its box at flow 2 and 4, an arrow end at 2, 3, 4 and 5.
describe('S3b: lighting and navigation at the depth', () => {
  const at = (d: string, more: { hash?: string } = {}) => load({ store: STORE({ [KEY]: d }), ...more });
  const mapSim = (h: HarnessResult) => (h.sandbox.window as any).C4PM_STATE.map.sim;
  const ids = (r: any) => Object.fromEntries(r.ids);

  it('container, go(3): map.sim carries depth, flowStep and tablesAt; arch lights api by flow numbers, no calls', () => {
    const h = at('container');
    const S = SIM(h);
    S.select('s-1');
    S.go(3);
    expect(mapSim(h)).toMatchObject({ id: 's-1', step: 3, flowStep: 1, depth: 'container', tablesAt: 3, cur: 3 });
    const r = S.litFor('arch');
    expect(ids(r)).toEqual({ api: { ns: [2, 3, 4, 5], cur: true } });
    expect(r.calls).toEqual([]);   // api -> api is dropped above code; the other arrows have one end outside the arch tree
    expect(r.list).toEqual([{ n: 2, i: 1, ids: ['api'], cur: true }, { n: 4, i: 3, ids: ['api'], cur: false }]);
  });

  it('container: io lights the screens and storage the record by flow numbers', () => {
    const S = SIM(at('container'));
    S.select('s-1');
    S.go(4);
    expect(ids(S.litFor('io'))).toEqual({
      'shop.web.login': { ns: [1], cur: false }, 'shop.web.home': { ns: [1], cur: false }, 'shop.web.cart': { ns: [5], cur: false },
    });
    expect(ids(S.litFor('storage'))).toEqual({ [CLASSES]: { ns: [3, 4], cur: true } });
    expect(S.litFor('storage').list).toEqual([{ n: 3, i: 2, ids: [CLASSES], cur: true }]);
  });

  it('no cursor: flowStep and tablesAt null, the tables as after the last step; openEarly over every flow step', () => {
    const h = at('container');
    const S = SIM(h);
    S.select('s-1');
    expect(mapSim(h)).toMatchObject({ step: null, flowStep: null, tablesAt: null, depth: 'container' });
    expect(mapSim(h).tables[CLASSES].at).toBe(5);
    const open = (h.sandbox.window as any).C4PM_STATE.map.openEarly;
    expect(open.has('api')).toBe(true);
    expect(open.has(CREATE)).toBe(false);
  });

  it('container, go(3): openEarly holds the flow step\'s box api, not the code targets inside it', () => {
    const h = at('container');
    const S = SIM(h);
    S.select('s-1');
    S.go(3);
    const open = (h.sandbox.window as any).C4PM_STATE.map.openEarly;
    expect(open.has('api')).toBe(true);
    expect(open.has('api/routes')).toBe(false);
    expect(open.has(CREATE)).toBe(false);
  });

  it('act at container moves by flow step: next 0, 2, 4, prev 2; from no cursor prev = the last flow step; clamped', () => {
    const S = SIM(at('container'));
    S.select('s-1');
    const seen: number[] = [];
    ['next', 'next', 'next', 'prev'].forEach((a) => { S.act(a); seen.push(S.step()); });
    expect(seen).toEqual([0, 2, 4, 2]);
    S.go(null);
    S.act('prev');
    expect(S.step()).toBe(6);
    S.act('next');
    expect(S.step()).toBe(6);
    S.go(1);
    S.act('prev');
    expect(S.step()).toBe(0);
  });

  it('a remote sim message keeps the original index: step() 3, flowIndex(3) 1', () => {
    const chans: any[] = [];
    class FakeBC { onmessage: ((ev: { data: unknown }) => void) | null = null; constructor() { chans.push(this); } postMessage() {} close() {} }
    const h = runViewerScripts(simHtml(), { extraIds: IDS, globals: { localStorage: STORE({ [KEY]: 'container' }), BroadcastChannel: FakeBC } });
    chans.forEach((c) => c.onmessage && c.onmessage({ data: { type: 'sim', from: 'w-other', view: 'arch', sim: 's-1', step: 3 } }));
    const S = SIM(h);
    expect(S.depth()).toBe('container');
    expect(S.step()).toBe(3);
    expect(S.flowIndex(3)).toBe(1);
    expect(mapSim(h).flowStep).toBe(1);
  });

  it('the fly gets the flow step; presentGo and the link message keep the original index', () => {
    const h = at('container');
    const S = SIM(h);
    const flown: any[] = [], pres: any[] = [], posts: any[] = [];
    (h.sandbox.window as any).C4PM_LINK.post = (...a: any[]) => posts.push(a);
    S.hooks.fly = (st: any) => flown.push(st);
    S.select('s-1');
    S.go(2, { go: true });
    expect(flown.map((f) => [f.n, f.members])).toEqual([[2, [2, 3]]]);
    expect(posts[posts.length - 1][1]).toEqual({ sim: 's-1', step: 2 });
    Object.assign(S.hooks, { presenting: () => true, presentGo: (...a: any[]) => pres.push(a) });
    S.go(3, { go: true });
    expect(pres).toEqual([[3, { go: true }]]);
  });

  it('stepTarget names a flow step by its boxes above code; an original step and code keep today\'s rule', () => {
    const S = SIM(at('container'));
    S.select('s-1');
    expect(S.flow().map((f: any) => S.stepTarget(f))).toEqual(['Web app', 'Api', 'Api', 'Api', 'Web app']);
    expect(S.stepTarget(S.steps()[2])).toBe('Routes');
    S.setDepth('code');
    expect(S.stepTarget(S.flow()[2])).toBe('Routes');
  });

  it('nameOfId finds a lane only a depth lists (code: the classes record lane)', () => {
    const S = SIM(load({ store: STORE() }));
    expect(S.nameOfId('app.api.db.classes', S.byId('s-1'))).toBe('classes');
    expect(S.nameOfId('nope', S.byId('s-1'))).toBe('nope');
  });

  it('code: map.sim, litFor, act and the fly as on the original steps', () => {
    const h = load({ store: STORE() });
    const S = SIM(h);
    S.select('s-1');
    S.go(3);
    expect(mapSim(h)).toMatchObject({ step: 3, flowStep: 3, depth: 'code', tablesAt: 3 });
    expect(ids(S.litFor('arch'))).toEqual({
      api: { ns: [3, 5, 6, 7], cur: false }, 'api/routes': { ns: [3, 4], cur: true }, [CREATE]: { ns: [4], cur: true }, 'api/payments': { ns: [6], cur: false },
    });
    const flown: any[] = [];
    S.hooks.fly = (st: any) => flown.push(st);
    S.act('next');
    expect(S.step()).toBe(4);
    expect(flown).toHaveLength(1);
    expect([flown[0].n, flown[0].targets]).toEqual([5, S.steps()[4].targets]);
  });

  describe('the storage sample label', () => {
    function drawTexts(h: HarnessResult, sim: unknown): string[] {
      const texts: string[] = [];
      const state: Record<string, any> = { globalAlpha: 1, font: '', lineWidth: 1, shadowBlur: 0 };
      const ctx: any = new Proxy({}, {
        get: (_t, k: string) => {
          if (k === 'fillText') return (q: string) => texts.push(String(q));
          if (k === 'measureText') return (q: string) => ({ width: String(q).length * 6 });
          if (k in state) return state[k];
          return () => undefined;
        },
        set: (_t, k: string, v) => { state[k] = v; return true; },
      });
      const w = h.sandbox.window as any;
      const map = { ctx, cam: { s: 1, tx: 100, ty: 100 }, cw: 1e6, ch: 1e6, selectedId: null, hi: null, sim };
      w.C4PM_STORAGEVIEW.draw(map, w.C4PM_RENDER.theme.readColors(), 0);
      return texts.filter((t) => /^(rows|no rows yet) · /.test(t));
    }
    const storageAt = (d: string) => at(d, { hash: '#storage' });

    it.each([
      [null, 'rows · end of s-1 · as after step 4'],
      [3, 'no rows yet · step 2'],
      [4, 'rows · step 3 · changed here'],
      [6, 'rows · step 5 · as after step 4'],
    ])('container, cursor %s: "%s"', (i, text) => {
      const h = storageAt('container');
      SIM(h).select('s-1');
      if (i !== null) SIM(h).go(i);
      expect(drawTexts(h, mapSim(h))).toEqual([text]);
    });

    it('curI is tablesAt: a record last changed at tablesAt reads "unchanged"', () => {
      const h = storageAt('container');
      SIM(h).select('s-1');
      SIM(h).go(6);
      expect(drawTexts(h, { ...mapSim(h), tablesAt: 5 })).toEqual(['rows · step 5 · unchanged']);
    });

    it('an old page object (no depth, flowStep, tablesAt) reads as today, at any depth', () => {
      const h = storageAt('container');
      const strip = (o: any) => { const c = { ...o }; delete c.depth; delete c.flowStep; delete c.tablesAt; return c; };
      SIM(h).select('s-1');
      SIM(h).go(6);
      expect(drawTexts(h, strip(mapSim(h)))).toEqual(['rows · step 7 · as after step 6']);
      SIM(h).go(null);
      expect(drawTexts(h, strip(mapSim(h)))).toEqual(['rows · end of s-1 · as after step 6']);
    });
  });
});
