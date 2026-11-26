import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';
import { simHtml } from './helpers/sim-view';

// Phase 25 b853 S2: viewer/sim-flow.js (C4PM_SIMFLOW), the pure flow steps of an s-item at one depth. The sims here are
// hand-made with the server's `step.at[d]` and `sim.depth[d]` (b853 S1), so this file does not need the server slice.

const page = runViewerScripts(simHtml(), { extraIds: ['btn-gear', 'settings-pop'] });
const win = page.sandbox.window as any;
const F: any = win.C4PM_SIMFLOW;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const ARCH = new Set(['api', 'routes', 'create', 'shop']);
const isArch = (id: string) => ARCH.has(id);

type At = { boxes: string[]; from: string; to: string; key: string | null };
const at = (boxes: string[], from: string, to: string): At => ({ boxes, from, to, key: boxes.join('|') });
const call = (from: string, to: string, fromLane: string, toLane: string, label = '', reply = false) => ({ from, to, fromLane, toLane, label, reply });
const tg = (view: string, nodeId: string, lane: string | null) => ({ ref: nodeId, uid: null, nodeId, view, name: nodeId, kind: 'x', entryId: null, lane });

// Five steps: io login, arch routes, arch create, storage orders, io cart. At container 1-3 merge (all in api); at
// context everything sits in the system 'shop'; at code each step is its own box.
function shopSim(): any {
  const steps: any[] = [
    { view: 'io', targets: [tg('io', 'login', 'web')], caption: 'Log in', state: 's0', durationSec: 2,
      call: call('person', 'web', 'person', 'web', 'open'),
      at: { context: at(['shop'], 'person', 'shop'), container: at(['web'], 'person', 'web'), component: at(['web'], 'person', 'web'), code: at(['web'], 'person', 'web') } },
    { view: 'arch', targets: [tg('arch', 'routes', 'api')], caption: 'POST /orders', durationSec: 3, missing: ['x'],
      call: call('web', 'routes', 'web', 'api', 'POST'),
      at: { context: at(['shop'], 'shop', 'shop'), container: at(['api'], 'web', 'api'), component: at(['routes'], 'web', 'routes'), code: at(['routes'], 'web', 'routes') } },
    { view: 'arch', targets: [tg('arch', 'create', 'api')], state: 's2', unverified: 'no link', missing: ['x', 'y'],
      call: call('routes', 'create', 'api', 'api', 'create'),
      at: { context: at(['shop'], 'shop', 'shop'), container: at(['api'], 'api', 'api'), component: at(['services'], 'routes', 'services'), code: at(['create'], 'routes', 'create') } },
    { view: 'storage', targets: [tg('storage', 'orders', 'api')], rows: [{ ref: 'r', recordId: 'orders', name: 'orders', pk: [], rows: [{ id: 1 }] }],
      caption: 'Save', state: 's3', durationSec: 5, unverified: 'later', unconnected: 'gap',
      call: call('api', 'api', 'api', 'api'),
      at: { context: at(['shop'], 'shop', 'shop'), container: at(['api'], 'api', 'api'), component: at(['api'], 'services', 'api'), code: at(['orders'], 'create', 'orders') } },
    { view: 'io', targets: [tg('io', 'cart', 'web')], caption: 'Cart',
      call: call('api', 'web', 'api', 'web', '', true),
      at: { context: at(['shop'], 'shop', 'shop'), container: at(['web'], 'api', 'web'), component: at(['web'], 'api', 'web'), code: at(['web'], 'orders', 'web') } },
  ].map((s, i) => Object.assign({ i, n: i + 1, stage: 0 }, s));
  const lanes = (ids: string[]) => ids.map((id, rank) => ({ id, name: id.toUpperCase(), sub: 'x', kind: 'container', rank }));
  return {
    id: 's-1', kind: 'flow', title: 'Shop', file: 'f', views: ['io', 'arch', 'storage'], steps,
    lanes: lanes(['person', 'web', 'api']),
    depth: {
      context: { groups: [[0, 1, 2, 3, 4]], lanes: lanes(['person', 'shop']) },
      container: { groups: [[0], [1, 2, 3], [4]], lanes: lanes(['person', 'web', 'api']) },
      component: { groups: [[0], [1], [2], [3], [4]], lanes: lanes(['person', 'web', 'routes', 'services', 'api']) },
      code: { groups: [[0], [1], [2], [3], [4]], lanes: lanes(['person', 'web', 'routes', 'create', 'orders']) },
    },
  };
}
const flow = (sim: any, d: string) => plain(F.flowSteps(sim, d, isArch));
const ADDED = ['first', 'last', 'members', 'views', 'boxes', 'archIds', 'arrows', 'call', 'captions'];

describe('C4PM_SIMFLOW on the page', () => {
  it('is absent on a page without s-items, present with them; DEPTHS widest first', () => {
    const none = runViewerScripts(renderViewHtml(storageModel()), { extraIds: ['btn-gear', 'settings-pop'] });
    expect((none.sandbox.window as any).C4PM_SIMFLOW).toBeUndefined();
    expect(plain(F.DEPTHS)).toEqual(['context', 'container', 'component', 'code']);
    expect(Object.keys(F).sort()).toEqual(['DEPTHS', 'allLanes', 'flowIndex', 'flowSteps', 'lanesAt']);
  });

  it('an unknown depth throws (flowSteps, lanesAt); isArch must be a function', () => {
    expect(() => F.flowSteps(shopSim(), 'system', isArch)).toThrow(/unknown depth system/);
    expect(() => F.lanesAt(shopSim(), undefined)).toThrow(/unknown depth/);
    expect(() => F.flowSteps(shopSim(), 'code')).toThrow(/isArch/);
  });
});

describe('a merged group (container, steps 2-4)', () => {
  const fl = flow(shopSim(), 'container');
  const g = fl[1];

  it('gives 3 flow steps numbered over the flow, members ascending', () => {
    expect(fl.map((s: any) => [s.i, s.n, s.first, s.last, s.members])).toEqual([[0, 1, 0, 0, [0]], [1, 2, 1, 3, [1, 2, 3]], [2, 3, 4, 4, [4]]]);
  });

  it('merges targets and rows in order (not rolled up), views by first appearance, boxes as a union', () => {
    expect(g.targets.map((t: any) => t.nodeId)).toEqual(['routes', 'create', 'orders']);
    expect(g.rows.map((r: any) => r.recordId)).toEqual(['orders']);
    expect([g.view, g.views, g.stage, g.boxes, g.archIds]).toEqual(['arch', ['arch', 'storage'], 0, ['api'], ['api']]);
    expect(fl[0].archIds).toEqual([]);   // 'web' is not an arch node
  });

  it('captions in order, state of the last member, seconds summed (4 for a step without), first unverified / unconnected, missing union', () => {
    expect([g.captions, g.caption, g.state, g.durationSec]).toEqual([['POST /orders', 'Save'], 'POST /orders', 's3', 3 + 4 + 5]);
    expect([g.unverified, g.unconnected, g.missing]).toEqual(['no link', 'gap', ['x', 'y']]);
    expect('at' in g).toBe(false);   // `at` belongs to one original step
  });

  it('state = the last member that has one (the state after the group); none when no member has one', () => {
    const sim = shopSim();
    delete sim.steps[3].state;
    expect(flow(sim, 'container')[1].state).toBe('s2');
    delete sim.steps[2].state;
    expect('state' in flow(sim, 'container')[1]).toBe(false);
  });

  it('keeps only the crossing arrow (web > api); call carries the member lanes at the depth', () => {
    expect(g.arrows).toEqual([{ from: 'web', to: 'api', label: 'POST', reply: false, unverified: false }]);
    expect(g.call).toEqual({ from: 'web', to: 'api', fromLane: 'web', toLane: 'api', label: 'POST', reply: false });
  });

  it('context: one flow step in the system box, its arrow person > shop', () => {
    const [c] = flow(shopSim(), 'context');
    expect([c.members, c.boxes, c.archIds, c.durationSec]).toEqual([[0, 1, 2, 3, 4], ['shop'], ['shop'], 2 + 3 + 4 + 5 + 4]);
    expect(c.arrows.map((a: any) => a.from + '>' + a.to)).toEqual(['person>shop']);
  });
});

describe('arrows of a group', () => {
  // One group of every step at depth d; each step's arrow is the same pair at d and in its call (code reads the call).
  function arrowSim(ends: Array<[string, string]>, d = 'container', grouped = true): any {
    const steps = ends.map(([from, to], i) => ({
      i, n: i + 1, stage: 0, view: 'arch', targets: [], unverified: i === 2 ? 'u' : undefined,
      call: call(from, to, 'l', 'l', 'L' + i), at: { [d]: at([from], from, to) },
    }));
    const groups = grouped ? [steps.map(s => s.i)] : steps.map(s => [s.i]);
    return { id: 's', steps, lanes: [], depth: { [d]: { groups, lanes: [] } } };
  }

  it('drops the inside-one-box arrows when another crosses; one per from>to, the first wins', () => {
    const [g] = flow(arrowSim([['a', 'a'], ['b', 'c'], ['b', 'c'], ['c', 'd']]), 'container');
    expect(g.arrows).toEqual([
      { from: 'b', to: 'c', label: 'L1', reply: false, unverified: false },
      { from: 'c', to: 'd', label: 'L3', reply: false, unverified: false },
    ]);
    expect(g.call).toEqual({ from: 'b', to: 'c', fromLane: 'b', toLane: 'c', label: 'L1', reply: false });
  });

  it.each(['context', 'container', 'component'])('%s: every self-arrow is dropped, also in a one-member group; call null', d => {
    const [g] = flow(arrowSim([['a', 'a'], ['a', 'a']], d), d);
    expect([g.arrows, g.call]).toEqual([[], null]);
    const single = flow(arrowSim([['a', 'a'], ['a', 'b']], d, false), d);
    expect(single.map((s: any) => s.arrows.map((a: any) => a.from + '>' + a.to))).toEqual([[], ['a>b']]);
    expect(single.map((s: any) => s.call && s.call.label)).toEqual([null, 'L1']);
  });

  it('code keeps today\'s arrows: an inside arrow stays when no member crosses, and in a one-member group', () => {
    expect(flow(arrowSim([['a', 'a'], ['a', 'a']], 'code'), 'code')[0].arrows.map((a: any) => a.label)).toEqual(['L0']);
    const [one] = flow(arrowSim([['a', 'a']], 'code', false), 'code');
    expect(one.call).toEqual({ from: 'a', to: 'a', fromLane: 'a', toLane: 'a', label: 'L0', reply: false });
  });

  it('no call at all gives call null', () => {
    const sim = arrowSim([['a', 'b']]);
    sim.steps[0].call = null;
    expect(flow(sim, 'container')[0]).toMatchObject({ arrows: [], call: null });
  });
});

describe('code: one member per flow step', () => {
  it('each flow step equals the original step apart from the added keys; call lanes = at.code', () => {
    const sim = shopSim();
    const fl = flow(sim, 'code');
    expect(fl).toHaveLength(5);
    fl.forEach((fs: any, k: number) => {
      const orig = plain(sim.steps[k]);
      const rest = Object.fromEntries(Object.entries(fs).filter(([key]) => ADDED.indexOf(key) < 0));
      expect(rest).toEqual({ ...orig, call: undefined });   // call is checked on the next line
      expect(fs.call).toEqual({ ...orig.call, fromLane: orig.at.code.from, toLane: orig.at.code.to });
      expect(fs.arrows).toEqual([{ from: orig.call.from, to: orig.call.to, label: orig.call.label, reply: orig.call.reply, unverified: !!orig.unverified }]);
      expect([fs.first, fs.last, fs.members, fs.views]).toEqual([k, k, [k], [orig.view]]);
    });
    expect(fl.map((s: any) => s.archIds)).toEqual([[], ['routes'], ['create'], [], []]);   // the arch targets, as today
    expect(fl.map((s: any) => s.captions)).toEqual([['Log in'], ['POST /orders'], [], ['Save'], ['Cart']]);
    expect(fl[1].call.toLane).toBe('routes');   // was the container lane 'api'
  });
});

describe('fallback: no usable depth data gives identity groups and sim.lanes', () => {
  const broken: Array<[string, (s: any) => void]> = [
    ['no sim.depth', s => { delete s.depth; }],
    ['a step without at', s => { delete s.steps[2].at; }],
    ['a step without at[d]', s => { delete s.steps[2].at.container; }],
    ['groups that skip a step', s => { s.depth.container.groups = [[0], [1, 2], [4]]; }],
    ['groups out of order', s => { s.depth.container.groups = [[0], [2, 1, 3], [4]]; }],
  ];
  it.each(broken)('%s', (_, spoil) => {
    const sim = shopSim();
    spoil(sim);
    const fl = flow(sim, 'container');
    expect(fl.map((s: any) => s.members)).toEqual([[0], [1], [2], [3], [4]]);
    fl.forEach((fs: any, k: number) => {
      expect(fs.call).toEqual(plain(sim.steps[k].call));   // the original lanes
      expect(fs.boxes).toEqual([]);
    });
    expect(fl.map((s: any) => s.archIds)).toEqual([[], ['routes'], ['create'], [], []]);
    expect(plain(F.lanesAt(sim, 'container'))).toEqual(plain(sim.lanes));
  });

  // b853 S3a: the page has at/depth since S1
  it('the page fixture (S1 at / depth): s-1 merges at container, one flow step per step at code', () => {
    const s1 = win.C4PM_DATA.sims[0];
    const members = (d: string) => plain(F.flowSteps(s1, d, () => true)).map((s: any) => s.members);
    expect(members('container')).toEqual([[0, 1], [2, 3], [4], [5], [6]]);
    expect(members('code')).toEqual(s1.steps.map((s: any) => [s.i]));
    expect(F.flowSteps(null, 'code', isArch)).toEqual([]);
  });

  it('the page fixture with every at and depth deleted gives one flow step per step at every depth', () => {
    const s1 = plain(win.C4PM_DATA.sims[0]);
    delete s1.depth;
    s1.steps.forEach((st: any) => { delete st.at; });
    plain(F.DEPTHS).forEach((d: string) => {
      const fl = plain(F.flowSteps(s1, d, () => true));
      expect(fl.map((s: any) => s.members)).toEqual(s1.steps.map((s: any) => [s.i]));
      expect(fl.map((s: any) => s.n)).toEqual(s1.steps.map((s: any) => s.n));
    });
  });
});

describe('flowIndex, lanesAt, allLanes', () => {
  it('flowIndex maps an original index to the flow step that holds it; null for null / unknown', () => {
    const fl = F.flowSteps(shopSim(), 'container', isArch);
    expect([0, 1, 2, 3, 4].map(i => F.flowIndex(fl, i))).toEqual([0, 1, 1, 1, 2]);
    expect([null, undefined, 5, -1].map(i => F.flowIndex(fl, i))).toEqual([null, null, null, null]);
    expect(F.flowIndex(null, 0)).toBeNull();
  });

  it('lanesAt gives the depth lanes; allLanes = sim.lanes then new ids of every depth', () => {
    const sim = shopSim();
    expect(plain(F.lanesAt(sim, 'component')).map((l: any) => l.id)).toEqual(['person', 'web', 'routes', 'services', 'api']);
    expect(plain(F.allLanes(sim)).map((l: any) => l.id)).toEqual(['person', 'web', 'api', 'shop', 'routes', 'services', 'create', 'orders']);
    delete sim.depth;
    expect(plain(F.allLanes(sim)).map((l: any) => l.id)).toEqual(['person', 'web', 'api']);
  });
});
