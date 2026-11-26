import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult, FakeEl } from './helpers/viewer-harness';
import { storageModel, CLASSES } from './helpers/storage-view';
import { simHtml, CREATE } from './helpers/sim-view';

// Phase 25 UI5 (b755): viewer/sim-list.js (the Simulations section at the bottom of #left, the tree row flags, the hint tail),
// tree.js (tab label per view, row decorators), controls.js (chips, setHintTail), summary.js (the Simulations bullet).
// Page: simHtml() (test/helpers/sim-view.ts): flow s-1 "Place an order" (7 steps, step 4 unverified), journey s-2 (9 steps, 3 stages).

const IDS = ['btn-gear', 'settings-pop'];
const TAIL = 'Esc: clear the selection, then the simulation\nSimulations (bottom left): select = path · ▶ = present';

function fakeStorage(init: Record<string, string> = {}) {
  const data: Record<string, string> = { ...init };
  return { data, getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => { data[k] = String(v); }, removeItem: (k: string) => { delete data[k]; } };
}
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

function load(opts: { html?: string; storage?: unknown; hash?: string } = {}): HarnessResult {
  const globals: Record<string, unknown> = { localStorage: opts.storage ?? fakeStorage() };
  if (opts.hash !== undefined) globals.location = { href: 'file:///x.html' + opts.hash, hash: opts.hash };
  return runViewerScripts(opts.html ?? simHtml(), { extraIds: IDS, globals });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const byId = (h: HarnessResult, id: string) => (h.sandbox.document as any).getElementById(id) as FakeEl;
const left = (h: HarnessResult) => byId(h, 'left');
type El = FakeEl & { hidden?: boolean };
const q = (h: HarnessResult, sel: string) => left(h).querySelector(sel) as El;
const sims = (h: HarnessResult) => q(h, '#sims');
const head = (h: HarnessResult) => q(h, '#sims-head') as FakeEl & { onclick: () => void };
const simRows = (h: HarnessResult) => q(h, '#sims-body').querySelectorAll('.lt-sim') as Array<FakeEl & { onclick: () => void }>;
const kids = (e: FakeEl) => e.children.filter((c) => c._classes) as FakeEl[];
const texts = (row: FakeEl) => kids(row).map((c) => c.textContent);
const treeRow = (h: HarnessResult, id: string) => left(h).querySelectorAll('.lt-row').find((r) => r.dataset.id === id) ?? null;
const flagOf = (row: FakeEl | null) => (row ? kids(row).find((c) => c._classes.has('sim-steps'))?.textContent ?? null : null);
const tabLabel = (h: HarnessResult) => q(h, '.lt-tab').textContent;

describe('the section', () => {
  it('is built last in #left, closed by default, head "Simulations (2)"; #left gets has-sims', () => {
    const h = load();
    const l = left(h);
    expect(l.children[l.children.length - 1].id).toBe('sims');
    expect(l._classes.has('has-sims')).toBe(true);
    expect(q(h, '#sims-title').textContent).toBe('Simulations (2)');
    expect(head(h).getAttribute('aria-expanded')).toBe('false');
    expect(q(h, '#sims-body').hidden).toBe(true);
    expect(simRows(h)).toHaveLength(0);
  });

  it('the head opens and closes it; the state is stored and read back', () => {
    const store = fakeStorage();
    const h = load({ storage: store });
    head(h).onclick();
    expect(store.data['c4mp.simsOpen']).toBe('open');
    expect(simRows(h)).toHaveLength(2);
    const again = load({ storage: store });
    expect(q(again, '#sims-body').hidden).toBe(false);
    head(again).onclick();
    expect(store.data['c4mp.simsOpen']).toBe('closed');
    expect(q(again, '#sims-body').hidden).toBe(true);
  });

  it('storage that throws: closed, and the head still toggles', () => {
    const h = load({ storage: throwing });
    expect(q(h, '#sims-body').hidden).toBe(true);
    head(h).onclick();
    expect(q(h, '#sims-body').hidden).toBe(false);
    expect(simRows(h)).toHaveLength(2);
  });

  it('rows: icon, title, "N steps" with its tooltip, "? 1" (s-2 plays s-1 inline, so it has the unverified step too), ▶; foot names the sim folder', () => {
    const h = load({ storage: fakeStorage({ 'c4mp.simsOpen': 'open' }) });
    const [r1, r2] = simRows(h);
    expect(texts(r1)).toEqual(['', 'Place an order', '7 steps', '? 1', '▶']);
    expect(texts(r2)).toEqual(['', 'Come back and buy', '9 steps', '? 1', '▶']);
    expect(kids(r1)[0].innerHTML).toMatch(/^<svg/);
    expect(kids(r1)[2].title).toBe('flow: 7 steps');
    expect(kids(r2)[2].title).toBe('journey: 3 stages, 9 steps (the flow stage plays inline)');
    expect(kids(r1)[3]._classes.has('unver')).toBe(true);
    expect(r1.title).toBe('s-1 · flow');
    expect(q(h, '.sims-foot').textContent).toBe('s-items live in .c4pm/projects/shop/sim/ · written on demand (AI or by hand), never by a scan');
  });

  it('▶ calls the present hook (not the row click); a row click selects and unselects', () => {
    const h = load({ storage: fakeStorage({ 'c4mp.simsOpen': 'open' }) });
    const S = win(h).C4PM_SIM;
    const calls: unknown[] = [];
    S.hooks.present = (id: string, i: number) => calls.push([id, i]);
    const play = kids(simRows(h)[1]).find((c) => c._classes.has('lt-play')) as FakeEl & { onclick: (e: unknown) => void };
    let stopped = 0;
    play.onclick({ stopPropagation: () => stopped++ });
    expect(calls).toEqual([['s-2', 0]]);
    expect(stopped).toBe(1);
    expect(S.selected()).toBeNull();
    simRows(h)[0].onclick();
    expect(S.selected()).toBe('s-1');
    expect(simRows(h)[0]._classes.has('selected')).toBe(true);
    simRows(h)[0].onclick();
    expect(S.selected()).toBeNull();
  });

  it('a selection opens it without saving; closed with a selection, the head shows "· s-1 title"', () => {
    const store = fakeStorage();
    const h = load({ storage: store });
    const S = win(h).C4PM_SIM;
    S.select('s-1');
    expect(q(h, '#sims-body').hidden).toBe(false);
    expect(store.data['c4mp.simsOpen']).toBeUndefined();
    expect(q(h, '#sims-sel').textContent).toBe('');
    head(h).onclick();
    expect(q(h, '#sims-sel').textContent).toBe('· s-1 Place an order');
    S.select(null);
    expect(q(h, '#sims-sel').textContent).toBe('');
  });

  it('hash sims=open opens it (not saved)', () => {
    const store = fakeStorage();
    const h = load({ storage: store, hash: '#arch&sims=open' });
    h.flushTimers();
    expect(q(h, '#sims-body').hidden).toBe(false);
    expect(store.data['c4mp.simsOpen']).toBeUndefined();
  });
});

describe('tree rows and the tab label', () => {
  it('lit rows get sim-lit and "step N · M" in arch, then in io and storage after a mode switch; clearing removes them', () => {
    const h = load();
    const w = win(h), S = w.C4PM_SIM;
    S.select('s-1');
    w.C4PM_TREE.reveal(CREATE);   // opens its ancestors: the row exists (the tree is lazy)
    expect(flagOf(treeRow(h, CREATE))).toBe('step 4');
    expect(treeRow(h, CREATE)!._classes.has('sim-lit')).toBe(true);
    w.C4PM_TREE.redecorate();   // idempotent: still one flag
    expect(kids(treeRow(h, CREATE)!).filter((c) => c._classes.has('sim-steps'))).toHaveLength(1);
    expect(tabLabel(h)).toBe('Architecture');
    w.C4PM_MODE.set('io');
    expect(tabLabel(h)).toBe('IO');
    expect(flagOf(treeRow(h, 'shop.web.login'))).toBe('step 1');
    expect(flagOf(treeRow(h, 'shop.web.cart'))).toBe('step 7');
    w.C4PM_MODE.set('storage');
    expect(tabLabel(h)).toBe('Storage');
    w.C4PM_TREE.reveal(CLASSES);
    expect(flagOf(treeRow(h, CLASSES))).toBe('step 5 · 6');
    S.select(null);
    expect(flagOf(treeRow(h, CLASSES))).toBeNull();
    expect(treeRow(h, CLASSES)!._classes.has('sim-lit')).toBe(false);
  });
});

// UI6 (b756): the 'sims' search provider (first: its rows come before the map rows).
describe('search finds s-items', () => {
  const type = (h: HarnessResult, text: string) => { h.search.value = text; h.search.dispatch('input', { target: h.search }); };
  const results = (h: HarnessResult) => h.searchResults.children as FakeEl[];
  const isSim = (r: FakeEl) => r._classes.has('sim-search-result');
  const simTexts = (r: FakeEl) => kids(r).map((c) => [Array.from(c._classes).join(' '), c.textContent]);

  it('"order": the s-1 row first (title / "s-item · flow · s-1", classes only), then the map rows', () => {
    const h = load();
    type(h, 'order');
    const rows = results(h);
    expect(isSim(rows[0])).toBe(true);
    expect(rows[0]._classes.has('pn-search-result')).toBe(true);
    expect(simTexts(rows[0])).toEqual([['pn-search-name', 'Place an order'], ['pn-search-detail', 's-item · flow · s-1']]);
    expect(rows[0].getAttribute('style')).toBeFalsy();
    expect(rows.slice(1).some(isSim)).toBe(false);
    expect(rows.length).toBeGreaterThan(1);   // map rows follow (OrderService and its methods)
  });

  it('"buy" finds s-2 by title; "journey" finds s-2 by kind; "s-1" by id; no hit, no s-item row', () => {
    const h = load();
    const simIds = () => results(h).filter(isSim).map((r) => kids(r)[1].textContent);
    type(h, 'buy');
    expect(simIds()).toEqual(['s-item · journey · s-2']);
    type(h, 'JOURNEY');
    expect(simIds()).toEqual(['s-item · journey · s-2']);
    type(h, 's-1');
    expect(simIds()).toEqual(['s-item · flow · s-1']);
    type(h, 'zzzz');
    expect(simIds()).toEqual([]);
  });

  it('Enter picks the first row: the s-item is selected, the box and the results are cleared', () => {
    const h = load();
    type(h, 'order');
    h.search.dispatch('keydown', { key: 'Enter', target: h.search });
    expect(win(h).C4PM_SIM.selected()).toBe('s-1');
    expect(h.search.value).toBe('');
    expect(results(h)).toHaveLength(0);
  });

  it('a click on an s-item row selects it', () => {
    const h = load();
    type(h, 'buy');
    results(h).find(isSim)!.click();
    expect(win(h).C4PM_SIM.selected()).toBe('s-2');
  });

  it('no s-items: no sims provider (registering the id again works), no s-item rows', () => {
    const h = load({ html: renderViewHtml(storageModel()) });
    type(h, 'order');
    expect(results(h).some(isSim)).toBe(false);
    expect(() => win(h).C4PM_SEARCH.registerSearchProvider({ id: 'sims', names: () => [], content: () => [] })).not.toThrow();
  });
});

describe('chips, hint, summary', () => {
  it('chips end with "· 2 simulations" in arch and io', () => {
    const h = load();
    expect(byId(h, 'bar-chips').textContent).toMatch(/ · 2 simulations$/);
    win(h).C4PM_MODE.set('io');
    expect(byId(h, 'bar-chips').textContent).toMatch(/ · 2 simulations$/);
  });

  it('the hint ends with the s-item lines in arch and io (the lines before kept)', () => {
    const h = load();
    const hint = byId(h, 'hud-bl');
    hint.textContent = 'Scroll or pinch: zoom\nDouble-click: dive in\nEsc: clear the selection';   // the html's text (the fake DOM has none)
    win(h).C4PM_CONTROLS.fillHeader();
    expect(hint.textContent).toBe('Scroll or pinch: zoom\nDouble-click: dive in\n' + TAIL);
    win(h).C4PM_MODE.set('io');
    expect(hint.textContent).toBe('Scroll or pinch: zoom · Drag: pan · Click: select\nDouble-click: zoom into a box · Fit: back out\nCmd/Ctrl+click: select and open the right panel\n' + TAIL);
    win(h).C4PM_MODE.set('arch');
    expect(hint.textContent.endsWith('\n' + TAIL)).toBe(true);
    expect(hint.textContent.split(TAIL)).toHaveLength(2);   // once, not stacked
  });

  it('the summary starts with the Simulations bullet', () => {
    const h = load();
    const ul = h.panel.querySelector('.pn-sims-note');
    expect(ul).not.toBeNull();
    expect(serializeText(ul!)).toBe('Simulations  open the section at the bottom of the left column and pick one: its path lights up in all three views. ▶ presents it step by step.');
  });

  it('no s-items: the empty section only (see "a page without s-items"); no flags, hint and chips unchanged, no bullet', () => {
    const h = load({ html: renderViewHtml(storageModel()) });
    expect(q(h, '#sims-title').textContent).toBe('Simulations (0)');   // K 2026-11-17: the section shows, with its count
    expect(left(h)._classes.has('has-sims')).toBe(true);
    expect(byId(h, 'bar-chips').textContent).not.toMatch(/simulation/);
    expect(byId(h, 'hud-bl').textContent).not.toMatch(/Simulations/);
    expect(h.panel.querySelector('.pn-sims-note')).toBeNull();
    expect(left(h).querySelectorAll('.sim-steps')).toHaveLength(0);
  });
});

// K 2026-11-17: the section shows on a page without s-items too, "Simulations (0)", with how to add one; nothing else of sims runs.
describe('a page without s-items', () => {
  const EMPTY = 'No simulations yet. Add one with c4mp sim add (or ask an AI agent through the MCP sim tools).';
  const FOOT = 's-items live in .c4pm/projects/<project>/sim/ · written on demand (AI or by hand), never by a scan';
  const bare = (storage?: unknown) => load({ html: renderViewHtml(storageModel()), storage });

  it('the same section, last in #left and closed: "Simulations (0)", no SIM', () => {
    const h = bare();
    const l = left(h);
    expect(l.children[l.children.length - 1].id).toBe('sims');
    expect(win(h).C4PM_SIM).toBeUndefined();
    expect(q(h, '#sims-title').textContent).toBe('Simulations (0)');
    expect(q(h, '#sims-sel').textContent).toBe('');
    expect(head(h).getAttribute('aria-expanded')).toBe('false');
    expect(head(h).getAttribute('aria-controls')).toBe('sims-body');
    expect(q(h, '#sims-body').hidden).toBe(true);
  });

  it('the head opens it (saved): no rows, the "No simulations yet" line, then the foot; closes it again', () => {
    const store = fakeStorage();
    const h = bare(store);
    head(h).onclick();
    expect(store.data['c4mp.simsOpen']).toBe('open');
    expect(q(h, '#sims-body').hidden).toBe(false);
    expect(head(h).getAttribute('aria-expanded')).toBe('true');
    expect(simRows(h)).toHaveLength(0);
    expect(kids(q(h, '#sims-body')).map((c) => [Array.from(c._classes).join(' '), c.textContent])).toEqual([['sims-empty', EMPTY], ['sims-foot', FOOT]]);
    head(h).onclick();
    expect(store.data['c4mp.simsOpen']).toBe('closed');
    expect(q(h, '#sims-body').hidden).toBe(true);
    expect(win(h).C4PM_SIM).toBeUndefined();
  });

  it('a stored open state opens it on load', () => {
    const h = bare(fakeStorage({ 'c4mp.simsOpen': 'open' }));
    expect(q(h, '#sims-body').hidden).toBe(false);
    expect(q(h, '.sims-empty').textContent).toBe(EMPTY);
  });
});
