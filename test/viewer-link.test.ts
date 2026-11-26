import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import { simModel } from './helpers/sim-view';
import { makeBus } from './helpers/link-bus';

// P20-T5-H (b262): the window link. Two page instances (two harness runs) talk over a fake BroadcastChannel
// (makeBus, test/helpers/link-bus.ts: one shared in-memory bus, synchronous, or queued until bus.flush() with async: true).

const IDS = ['btn-gear', 'settings-pop'];
function page(globals: Record<string, unknown>, model = loadSample(), ids: string[] = []): HarnessResult {
  return runViewerScripts(renderViewHtml(model), { extraIds: [...IDS, ...ids], globals });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const lit = (h: HarnessResult) => win(h).C4PM_MAP.highlightInfo().lit;

describe('window link (b262)', () => {
  it('two pages count each other and say so in status()', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    expect(win(a).C4PM_LINK.status()).toBe('no other window yet');
    const b = page({ BroadcastChannel });
    expect(win(a).C4PM_LINK.status()).toBe('1 other window');
    expect(win(b).C4PM_LINK.status()).toBe('1 other window');
    const c = page({ BroadcastChannel });
    expect(win(a).C4PM_LINK.status()).toBe('2 other windows');
    expect(win(c).C4PM_LINK.status()).toBe('2 other windows');
    expect(bus.sent.every(s => s.name === 'c4pm-link:/repo/shop')).toBe(true);
    expect(bus.sent[0].data).toMatchObject({ type: 'hello', view: 'arch', id: null });
    expect(typeof bus.sent[0].data.from).toBe('string');
  });

  it('pagehide sends bye and the other page stops counting it', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    b.fireWindowEvent('pagehide');
    expect(bus.sent[bus.sent.length - 1].data.type).toBe('bye');
    expect(win(a).C4PM_LINK.status()).toBe('no other window yet');
  });

  it('a mode change sends hello with the new view', () => {
    const { bus, BroadcastChannel } = makeBus();
    page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    const before = bus.sent.length;
    win(b).C4PM_MODE.set('io');
    const hellos = bus.sent.slice(before).filter(s => s.data.type === 'hello');
    expect(hellos).toHaveLength(1);
    expect(hellos[0].data.view).toBe('io');
  });

  it('a selection lights the id in the other page without selecting it; null clears', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    win(a).C4PM_MAP.select('api');
    expect(bus.sent[bus.sent.length - 1].data).toMatchObject({ type: 'sel', id: 'api', view: 'arch' });
    expect(lit(b)).toBe(1);
    expect(win(b).C4PM_MAP.state.hi.has('api')).toBe(true);
    expect(win(b).C4PM_MAP.selectedId()).toBeNull();
    expect(lit(a)).toBe(0);   // the sender lights nothing
    win(a).C4PM_MAP.select(null);
    expect(bus.sent[bus.sent.length - 1].data).toMatchObject({ type: 'sel', id: null });
    expect(lit(b)).toBe(0);
  });

  it('an id unknown in the receiving tree is ignored and keeps the current light', () => {
    const { BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    win(a).C4PM_MODE.set('io');   // loadTree clears a's selection: a sends sel null (b has no light yet)
    win(b).C4PM_MAP.setHighlight(['api']);
    expect(lit(b)).toBe(1);
    win(a).C4PM_MAP.select('shop.web.cart');   // b is in arch: no such node there
    expect(lit(b)).toBe(1);
    expect(win(b).C4PM_MAP.state.hi.has('api')).toBe(true);
  });

  it('the last light wins: a remote light replaces a local board-style light', () => {
    const { BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    win(b).C4PM_MAP.setHighlight(['api/services']);
    win(a).C4PM_MAP.select('api');
    expect([...win(b).C4PM_MAP.state.hi]).toEqual(['api']);
  });

  it("'light' (b130): lights the known ids, ignores unknown ones, none known keeps the light, [] clears; a new window gets the last light", () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    win(a).C4PM_LINK.light(['api/payments', 'nope']);
    expect(bus.sent[bus.sent.length - 1].data).toMatchObject({ type: 'light', ids: ['api/payments', 'nope'] });
    expect([...win(b).C4PM_MAP.state.hi]).toEqual(['api/payments']);
    win(a).C4PM_LINK.light(['nope']);
    expect([...win(b).C4PM_MAP.state.hi]).toEqual(['api/payments']);
    const c = page({ BroadcastChannel });   // joins later: says hello, a answers and re-sends the last light
    expect(win(c).C4PM_MAP.state.hi).toBeNull();   // the last light sent was ['nope']: unknown in c, ignored
    win(a).C4PM_LINK.light(['api/routes']);
    const d = page({ BroadcastChannel });
    expect([...win(d).C4PM_MAP.state.hi]).toEqual(['api/routes']);
    win(a).C4PM_LINK.light([]);
    expect(win(b).C4PM_MAP.state.hi).toBeNull();
  });

  it('setting off says bye, closes the channel, clears the light and the count; on reopens', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    win(a).C4PM_MAP.select('api');
    expect(lit(b)).toBe(1);
    win(b).C4PM_SETTINGS.set('link', 'off');
    expect(bus.sent[bus.sent.length - 1].data.type).toBe('bye');
    expect(bus.open.size).toBe(1);
    expect(lit(b)).toBe(0);
    expect(win(b).C4PM_LINK.status()).toBe('off');
    expect(win(a).C4PM_LINK.status()).toBe('no other window yet');
    const n = bus.sent.length;
    win(a).C4PM_MAP.select('api/services');   // b no longer listens
    expect(lit(b)).toBe(0);
    win(b).C4PM_MAP.select('api');            // and no longer sends
    expect(bus.sent.slice(n)).toHaveLength(1);   // only a's own sel went out; b sent nothing
    win(b).C4PM_SETTINGS.set('link', 'on');
    expect(bus.open.size).toBe(2);
    expect(win(b).C4PM_LINK.status()).toBe('1 other window');
    expect(win(a).C4PM_LINK.status()).toBe('1 other window');
    win(a).C4PM_MAP.select('api');
    expect(lit(b)).toBe(1);
  });

  it('a stored link=off page starts closed', () => {
    const { bus, BroadcastChannel } = makeBus();
    const store: Record<string, string> = { 'c4mp.settings': JSON.stringify({ link: 'off' }) };
    const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: () => {} };
    const h = page({ BroadcastChannel, localStorage });
    expect(bus.open.size).toBe(0);
    expect(win(h).C4PM_LINK.status()).toBe('off');
  });

  it('no BroadcastChannel: status says not available and the page still works', () => {
    const h = page({});
    expect(win(h).C4PM_LINK.status()).toBe('not available (each window works alone)');
    expect(() => win(h).C4PM_MAP.select('api')).not.toThrow();
    expect(win(h).C4PM_MAP.selectedId()).toBe('api');
    expect(() => win(h).C4PM_LINK.send('api')).not.toThrow();
    h.fireWindowEvent('pagehide');
    win(h).C4PM_SETTINGS.set('link', 'off');
    expect(win(h).C4PM_LINK.status()).toBe('off');
    win(h).C4PM_SETTINGS.set('link', 'on');
    expect(win(h).C4PM_LINK.status()).toBe('not available (each window works alone)');
  });

  it('a throwing BroadcastChannel constructor is the same as none', () => {
    const BroadcastChannel = function () { throw new Error('blocked'); };
    const h = page({ BroadcastChannel });
    expect(win(h).C4PM_LINK.status()).toBe('not available (each window works alone)');
    expect(() => win(h).C4PM_MAP.select('api')).not.toThrow();
  });
});

// Phase 25 UI3 (b753): generic messages (on / post with replay) and the 'sim' message of sim.js.
describe('window link: generic messages and the s-item (UI3)', () => {
  const SIM = (h: HarnessResult) => win(h).C4PM_SIM;

  it('on / post: a registered type reaches the other page with the payload fields; an unregistered type is dropped', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    const got: any[] = [];
    win(b).C4PM_LINK.on('note', (d: any) => got.push(d));
    win(a).C4PM_LINK.post('other', { x: 1 });
    expect(got).toEqual([]);
    expect(bus.sent[bus.sent.length - 1].data).toMatchObject({ type: 'other', x: 1 });
    win(a).C4PM_LINK.post('note', { x: 2, type: 'sel', view: 'nope' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'note', x: 2, view: 'arch' });
    expect(win(b).C4PM_MAP.state.hi).toBeNull();   // the payload's 'type' never turns it into a 'sel'
    expect(win(b).C4PM_LINK.status()).toBe('1 other window');
  });

  it('the built-in types are not free; on needs a function', () => {
    const h = page({});
    for (const type of ['hello', 'bye', 'sel', 'light', '']) {
      expect(() => win(h).C4PM_LINK.on(type, () => {})).toThrow(/not a free message type/);
      expect(() => win(h).C4PM_LINK.post(type, {})).toThrow(/not a free message type/);
    }
    expect(() => win(h).C4PM_LINK.on('note', null)).toThrow(/must be a function/);
    expect(() => win(h).C4PM_LINK.post('note', { x: 1 })).not.toThrow();   // no channel: a no-op
  });

  it('replay: a window that joins later gets the last replayed payload of each type, not the plain ones', () => {
    const { bus, BroadcastChannel } = makeBus({ async: true });
    const a = page({ BroadcastChannel });
    win(a).C4PM_LINK.post('note', { v: 1 }, { replay: true });
    win(a).C4PM_LINK.post('note', { v: 2 }, { replay: true });
    win(a).C4PM_LINK.post('plain', { v: 3 });
    const c = page({ BroadcastChannel });
    const got: any[] = [];
    win(c).C4PM_LINK.on('note', (d: any) => got.push(d.v));
    win(c).C4PM_LINK.on('plain', (d: any) => got.push(d.v));
    bus.flush();
    expect(got).toEqual([2]);
  });

  it("'sim' both ways: the other page follows the s-item and the cursor without a fly or an echo", () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel }, simModel());
    const b = page({ BroadcastChannel }, simModel());
    const flown: number[] = [];
    SIM(b).hooks.fly = (st: any) => flown.push(st.n);
    SIM(a).select('s-1');
    expect(bus.sent[bus.sent.length - 1].data).toMatchObject({ type: 'sim', sim: 's-1', step: null });
    expect([SIM(b).selected(), SIM(b).step()]).toEqual(['s-1', null]);
    const fromA = bus.sent[0].data.from;
    const n = bus.sent.length;
    SIM(a).act('next');
    // UI7: a's next flies, so a switches to the step's view (io) and sends its own 'sel' / 'hello' (the older mode-change
    // messages, correct). The rule pinned here: a sends exactly one 'sim' and b sends nothing (no echo).
    const after = bus.sent.slice(n);
    expect(after.filter(s => s.data.from !== fromA)).toEqual([]);
    expect(after.filter(s => s.data.type === 'sim')).toHaveLength(1);
    expect(SIM(b).step()).toBe(0);
    expect(win(b).C4PM_STATE.map.sim.step).toBe(0);
    SIM(b).go(4);
    expect([SIM(a).selected(), SIM(a).step()]).toEqual(['s-1', 4]);
    expect(flown).toEqual([]);
    SIM(b).select(null);
    expect(SIM(a).selected()).toBeNull();
  });

  it("'sim' with the path strip loaded: a remote select / step never fits, flies or changes b's view, and b sends nothing", () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel }, simModel());
    const b = page({ BroadcastChannel }, simModel());
    expect(win(b).C4PM_SIMSTRIP).toBeDefined();
    const fromA = bus.sent[0].data.from;
    const calls: string[] = [];
    const fit = SIM(b).hooks.fitPath, fly = SIM(b).hooks.fly, flyTo = win(b).C4PM_CAM.flyTo;
    SIM(b).hooks.fitPath = () => { calls.push('fitPath'); fit(); };
    SIM(b).hooks.fly = (st: any) => { calls.push('fly'); fly(st); };
    win(b).C4PM_CAM.flyTo = (...x: any[]) => { calls.push('flyTo'); return flyTo(...x); };
    const n = bus.sent.length;
    SIM(a).select('s-1');
    SIM(a).act('next');
    expect([SIM(b).selected(), SIM(b).step()]).toEqual(['s-1', 0]);
    expect(win(a).C4PM_MODE.get()).toBe('io');   // the local side flies to the step's view
    expect(win(b).C4PM_MODE.get()).toBe('arch');
    expect(calls).toEqual([]);
    expect(bus.sent.slice(n).filter(s => s.data.from !== fromA)).toEqual([]);
  });

  it("'sim' replay: a window that joins later selects the same s-item and step", () => {
    const { bus, BroadcastChannel } = makeBus({ async: true });
    const a = page({ BroadcastChannel }, simModel());
    SIM(a).select('s-2');
    SIM(a).go(5);
    bus.flush();
    const c = page({ BroadcastChannel }, simModel());
    bus.flush();
    expect([SIM(c).selected(), SIM(c).step()]).toEqual(['s-2', 5]);
    expect(win(c).C4PM_LINK.status()).toBe('1 other window');
  });

  it('b797: Esc in the &seqonly window clears nothing there or in the main window', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel }, simModel());
    const hash = '#arch&seqonly&sim=s-1';
    const b = page({ BroadcastChannel, location: { href: 'file:///x.html' + hash, hash } }, simModel(),
      ['seq-drawer', 'seq-drawer-edge', 'seq-bar', 'seq-body', 'center']);
    b.flushTimers();   // sim.js applies the hash after a timeout
    expect([SIM(a).selected(), SIM(b).selected()]).toEqual(['s-1', 's-1']);
    const fromB = bus.sent.find(s => s.data.type === 'sim')!.data.from;
    const n = bus.sent.length;
    (b.sandbox.document as any).dispatch('keydown', { key: 'Escape', target: { tagName: 'DIV' }, stopPropagation() {}, preventDefault() {} });
    expect([SIM(a).selected(), SIM(b).selected()]).toEqual(['s-1', 's-1']);
    expect(bus.sent.slice(n).filter(s => s.data.from === fromB)).toEqual([]);
  });

  it("a page without s-items drops 'sim' messages", () => {
    const { BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel }, simModel());
    const b = page({ BroadcastChannel });
    expect(win(b).C4PM_SIM).toBeUndefined();
    expect(() => SIM(a).select('s-1')).not.toThrow();
    expect(win(b).C4PM_LINK.status()).toBe('1 other window');
  });
});

// Phase 25 UI17 slice 1 (b767): the link knows each other window's view, and whether it shows a map (the &seqonly window
// of UI14 does not: its messages say map: false).
describe('UI17 peers', () => {
  const LINK = (h: HarnessResult) => win(h).C4PM_LINK;
  const SEQ_HASH = '#arch&seqonly&sim=s-1';
  const SEQ_IDS = ['seq-drawer', 'seq-drawer-edge', 'seq-bar', 'seq-body', 'center'];

  it('two pages list each other with id, view and map; id() differs per page', () => {
    const { BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    expect(typeof LINK(a).id()).toBe('string');
    expect(LINK(a).id()).not.toBe(LINK(b).id());
    expect(LINK(a).peers()).toEqual([{ id: LINK(b).id(), view: 'arch', map: true }]);
    expect(LINK(b).peers()).toEqual([{ id: LINK(a).id(), view: 'arch', map: true }]);
    LINK(a).peers()[0].view = 'changed';   // a copy: the caller cannot change the list
    expect(LINK(a).peers()[0].view).toBe('arch');
  });

  it('a view switch and a pagehide update the list and call onPeers', () => {
    const { BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    const b = page({ BroadcastChannel });
    const spy = jest.fn();
    LINK(a).onPeers(spy);
    win(b).C4PM_MODE.set('io');
    expect(LINK(a).peers()).toEqual([{ id: LINK(b).id(), view: 'io', map: true }]);
    expect(spy).toHaveBeenCalled();
    spy.mockClear();
    b.fireWindowEvent('pagehide');
    expect(LINK(a).peers()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => LINK(a).onPeers(null)).toThrow(/must be a function/);
  });

  it('setting off empties the list and calls onPeers once', () => {
    const { BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel });
    page({ BroadcastChannel });
    const spy = jest.fn();
    LINK(a).onPeers(spy);
    win(a).C4PM_SETTINGS.set('link', 'off');
    expect(LINK(a).peers()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the &seqonly window says map: false; a normal window adds no map key', () => {
    const { bus, BroadcastChannel } = makeBus();
    const a = page({ BroadcastChannel }, simModel());
    const b = page({ BroadcastChannel, location: { href: 'file:///x.html' + SEQ_HASH, hash: SEQ_HASH } }, simModel(), SEQ_IDS);
    b.flushTimers();   // sim.js applies the hash after a timeout: b posts its 'sim' too
    const fromA = LINK(a).id(), fromB = LINK(b).id();
    const sentB = bus.sent.filter(s => s.data.from === fromB);
    const sentA = bus.sent.filter(s => s.data.from === fromA);
    expect(sentB.length).toBeGreaterThan(0);
    expect(sentB.every(s => s.data.map === false)).toBe(true);
    expect(sentA.length).toBeGreaterThan(0);
    expect(sentA.every(s => !('map' in s.data))).toBe(true);
    expect(LINK(a).peers()).toEqual([{ id: fromB, view: 'arch', map: false }]);
    expect(LINK(b).peers()).toEqual([{ id: fromA, view: 'arch', map: true }]);
  });
});
