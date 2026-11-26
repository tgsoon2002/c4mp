import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { NavCall, ViewModel, ViewNode } from '../src/types';

// b130 (P20-T8) viewer: the screen panel's "Calls" row and the "Light implemented components" ring (setting lightImpl).
// Sample: test/fixtures/nav-view/sample.json; arch components there are api/routes, api/payments ... (no uid), so the uid
// route is exercised by giving api/routes a uid in memory.

const SCREEN = '#5B4FC9';   // --screen in the harness's fake getComputedStyle

const call = (over: Partial<NavCall>): NavCall => ({ from: 'shop.web.cart', via: null, to: 'x', toKind: 'component', toTitle: 'X', toUid: null, toComponent: null, label: null, ...over });

function model(): ViewModel {
  const m = loadSample();
  const find = (n: ViewNode, id: string): ViewNode | undefined => n.id === id ? n : n.children.map(c => find(c, id)).find(Boolean);
  find(m.root, 'api/routes')!.uid = 'u-routes';
  m.nav!.calls = [
    call({ to: 'api/payments', toComponent: 'api/payments', label: 'Pay', via: 'shop.web.cart.pay_btn' }),
    call({ to: 'api.payments.charge', toKind: 'function', toTitle: 'Price it', toComponent: 'api/payments' }),
    call({ to: 'api.routes', toUid: 'u-routes', toComponent: 'api.routes' }),
    call({ to: 'ghost.thing', toTitle: 'Ghost thing', toComponent: 'ghost' }),
    call({ to: 'db.orders', toKind: 'database', toComponent: 'api/models' }),
    call({ from: 'shop.web.login', to: 'api/utils', toComponent: 'api/utils' }),
  ];
  return m;
}

const loc = (hash: string) => ({ href: 'file:///x.html' + hash, hash });
function load(hash = '#io', store: Record<string, string> = {}) {
  const ls = { getItem: (k: string) => (k in store ? store[k] : null), setItem: (k: string, v: string) => { store[k] = String(v); }, removeItem: () => {} };
  const location = loc(hash);
  const h = runViewerScripts(renderViewHtml(model()), { extraIds: ['btn-gear', 'settings-pop'], globals: { location, localStorage: ls } });
  return { h, location };
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const calls = (h: HarnessResult) => h.panel.querySelectorAll('.pn-section').find(s => serializeText(s).startsWith('Calls'))!;
const settle = (h: HarnessResult) => { h.frames.runToCompletion(); for (let i = 0; i < 60; i++) h.frames.flush(); };

describe('b130 screen panel: Calls', () => {
  it('rows for accepted kinds only, with label and via; unresolved target is plain text; none when empty', () => {
    const { h } = load();
    win(h).C4PM_MAP.select('shop.web.cart');
    const sec = calls(h);
    const t = serializeText(sec);
    expect(t).toContain('Payments');   // component target: its arch node name (its toTitle 'X' is not used)
    expect(t).not.toContain('X');
    expect(t).toContain('"Pay" via pay_btn');
    expect(t).toContain('Price it');   // b277 item 3: function target: its title (NavCall.toTitle), not the last fqn segment
    expect(t).not.toContain('charge');
    expect(sec.querySelectorAll('button').find(b => b.textContent === 'Price it')!.title).toBe('api.payments.charge');   // tooltip stays the fqn
    expect(t).toContain('Ghost thing');   // not on the map: plain text, its title
    expect(t).not.toContain('orders');   // toKind 'database' is not accepted
    expect(sec.querySelectorAll('button').length).toBe(3);   // payments, charge, routes; ghost is plain text
    win(h).C4PM_MAP.select('shop.web.home');
    expect(serializeText(calls(h))).toBe('Calls none');
  });

  it('click, openIn here: arch view, node selected, hash cleared', () => {
    const { h, location } = load();
    const w = win(h);
    w.C4PM_SETTINGS.set('openIn', 'here');
    w.C4PM_MAP.select('shop.web.login');
    (calls(h).querySelectorAll('button')[0] as any).onclick();
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect(w.C4PM_MAP.selectedId()).toBe('api/utils');
    expect(location.hash).toBe('');
  });

  it('click, openIn window: light message with the arch ids, then C4PM_OPEN(arch); uid route and function->component both resolve', () => {
    const { h } = load();
    const w = win(h);
    const lit: string[][] = [], opened: string[] = [];
    w.C4PM_LINK.light = (ids: string[]) => lit.push(ids);
    w.C4PM_OPEN = (m: string) => opened.push(m);
    w.C4PM_MAP.select('shop.web.cart');
    const btns = calls(h).querySelectorAll('button') as any[];
    btns.forEach(b => b.onclick());
    expect(lit).toEqual([['api/payments'], ['api/payments'], ['api/routes']]);
    expect(opened).toEqual(['arch', 'arch', 'arch']);
    expect(w.C4PM_MODE.get()).toBe('io');   // this window stays
  });
});

describe('b130 board item on a screen (IO view)', () => {
  it('a b-item linked to a screen lights it in the IO view and the note counts it', () => {
    const m = model();
    const g = [{ id: 'planned', name: 'Planned', status: 'planned' }];
    const link = { uid: 'u-cart', nodeId: 'shop.web.cart', name: 'Cart', kind: 'screen', state: 'has-code', findingCount: 0 };
    m.board = { statuses: ['planned'], kinds: ['task'], findings: [], boards: [{ id: 'sprint', name: 'S', groups: g, items: [
      { id: 'b1', title: 'Cart UI', kind: 'task', status: 'planned', dependsOn: [], links: ['u-cart'], tags: [], linked: [link], deadLinks: [] }] }] } as any;
    const h = runViewerScripts(renderViewHtml(m), { extraIds: ['board-drawer', 'center', 'btn-board'], globals: { location: loc('#io') } });
    settle(h);
    win(h).C4PM_BOARD.select('b1');
    expect(win(h).C4PM_MAP.highlightInfo().lit).toBe(1);
    const note = (h.sandbox.document as any).getElementById('map-wrap').children.find((c: any) => c.id === 'bd-note');
    expect(note.children[0].textContent).toContain('1 c-item lit');
  });
});

describe('b130 Light implemented components', () => {
  const rings = (h: HarnessResult) => h.opLog.filter(o => o.op === 'stroke' && o.style === SCREEN).length;
  const draw = (h: HarnessResult) => { settle(h); win(h).C4PM_MAP.flyTo('api'); settle(h); h.opLog.length = 0; win(h).C4PM_MAP.draw(); };

  it('default off: nothing drawn; on: a ring per implemented component, no dimming; off clears', () => {
    const { h } = load('');
    expect(win(h).C4PM_SETTINGS.get('lightImpl')).toBe('off');
    draw(h);
    expect(rings(h)).toBe(0);
    win(h).C4PM_SETTINGS.set('lightImpl', 'on');
    draw(h);
    expect(rings(h)).toBe(3);   // api/payments (called twice, one ring), api/routes, api/utils; api/models is a database target: not counted
    const m = win(h).C4PM_MAP.state;
    expect([...m.impl].sort()).toEqual(['api/payments', 'api/routes', 'api/utils']);
    expect(m.implN['api/payments']).toBe(2);
    expect(m.implN.api).toBe(4);   // the container rolls its components up
    expect(m.hi).toBeNull();       // not the board/link highlight: nothing dims
    win(h).C4PM_SETTINGS.set('lightImpl', 'off');
    draw(h);
    expect(rings(h)).toBe(0);
    expect(m.impl).toBeNull();
  });

  it('a closed container shows one rolled-up ring; the IO view builds none; leaving it rebuilds', () => {
    const { h } = load('', { 'c4mp.settings': JSON.stringify({ lightImpl: 'on' }) });
    settle(h);
    h.opLog.length = 0; win(h).C4PM_MAP.draw();
    expect(rings(h)).toBeGreaterThanOrEqual(1);   // root view: api is a bubble holding implemented components
    win(h).C4PM_MODE.set('io');
    expect(win(h).C4PM_MAP.state.impl).toBeNull();
    win(h).C4PM_MODE.set('arch');
    expect(win(h).C4PM_MAP.state.impl.size).toBe(3);
  });
});
