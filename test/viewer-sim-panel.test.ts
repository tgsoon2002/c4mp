import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult, FakeEl } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';
import { simHtml, simModel } from './helpers/sim-view';
import type { ViewModel } from '../src/types';

// Phase 25 UI10 (b760): viewer/sim-panel.js, the right panel of a selected s-item (crumbs, header, buttons, pills, notes, step
// cards, Stored as) and the "In simulations" section of a c-item. Page: simHtml() (test/helpers/sim-view.ts): flow s-1 "Place an
// order" (7 steps, step 4 unverified, rows at steps 5 and 6), journey s-2 (outside, s-1 inline, outside: 9 steps).

const IDS = ['btn-gear', 'settings-pop'];
const load = (html = simHtml()): HarnessResult => runViewerScripts(html, { extraIds: IDS });
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const MAP = (h: HarnessResult) => win(h).C4PM_MAP;
const kids = (e: FakeEl) => e.children.filter((c) => c._classes) as FakeEl[];
const all = (h: HarnessResult, cls: string) => h.panel.querySelectorAll('.' + cls);
const text = (e: FakeEl) => serializeText(e).replace(/\s+/g, ' ').trim();
const cards = (h: HarnessResult) => all(h, 'st-card');
const sectionOf = (h: HarnessResult, label: string) => all(h, 'pn-section').find((s) => text(s.children[0]).startsWith(label)) ?? null;
const chips = (h: HarnessResult) => {
  const sec = sectionOf(h, 'In simulations');
  return sec ? sec.querySelectorAll('.pn-dep-chip') : [];
};
/** The page of simModel() after `fn` changed it (a fresh model each call). */
function withSims(fn: (m: ViewModel) => void): string {
  const m = simModel();
  fn(m);
  return renderViewHtml(m);
}

describe('no s-item selected', () => {
  it('a page without s-items: no panel take-over, no "In simulations"', () => {
    const h = load(renderViewHtml(storageModel()));
    expect(win(h).C4PM_SIM).toBeUndefined();
    MAP(h).select('api/routes');
    expect(sectionOf(h, 'In simulations')).toBeNull();
  });

  it('the panel is the summary until an s-item is selected', () => {
    const h = load();
    expect(cards(h)).toHaveLength(0);
    expect(text(h.panel)).not.toContain('Steps (click one to go there)');
  });
});

describe('the s-item panel', () => {
  it('flow s-1: crumbs, header, buttons, pills, unverified note, steps, Stored as, in this order', () => {
    const h = load();
    SIM(h).select('s-1');
    expect(kids(h.panel).map((c) => c.className)).toEqual(['pn-breadcrumb', 'pn-header', 'pbtns', 'pn-meta-pills', 'pn-note info', 'pn-section', 'pn-section']);
    expect(text(all(h, 'pn-breadcrumb')[0])).toBe('s-item Simulations › s-1 · .c4pm/projects/shop/sim/s-1.json');
    expect(all(h, 'pn-crumb-chip')[0].textContent).toBe('s-item');
    const h2 = all(h, 'pn-header')[0].children[0];
    expect(h2._text).toBe('Place an order');
    expect(all(h, 'pn-kind')[0].textContent).toBe('Flow');
    expect(all(h, 'pbtn').map((b) => [b.textContent, b.dataset.act, b._classes.has('main')])).toEqual([
      ['▶ Present', 'present', true], ['≡ Sequence', 'seq', false], ['✕ Clear', 'clear', false],
    ]);
    expect(all(h, 'pn-badge').map((b) => b.textContent)).toEqual(['7 steps', 'views: IO · Architecture · Storage', 'person: Customer']);
    expect(all(h, 'pn-note')[0].textContent).toBe('sim-step-unverified (info): step 4: no call found from Routes to OrderService.create. '
      + 'The step stays; it is drawn dashed until the code has the call.');
    expect(text(sectionOf(h, 'Steps')!.children[0])).toBe('Steps (click one to go there)');
    expect(cards(h)).toHaveLength(7);
    expect(all(h, 'pn-row').map((r) => kids(r).map((c) => c.textContent))).toEqual([['file', '.c4pm/projects/shop/sim/s-1.json'], ['kind', 'flow'], ['id', 's-1']]);
  });

  it('cards: number, view chip, target, call line, caption, state; unver on step 4; cur follows the cursor with its note', () => {
    const h = load();
    SIM(h).select('s-1');
    const c = cards(h);
    expect(c.map((x) => x.dataset.step)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    const top = (x: FakeEl) => kids(x.children[0]).map((e) => [e.className, e.textContent]);
    expect(top(c[0])[0]).toEqual(['st-n', '1']);
    expect(top(c[0])[1]).toEqual(['vchip io', 'IO']);
    expect(top(c[2])[1]).toEqual(['vchip arch', 'Architecture']);
    expect(top(c[4])[1]).toEqual(['vchip storage', 'Storage']);
    expect(top(c[3])[3]).toEqual(['vchip unver', '? unverified']);
    expect(kids(c[3].children[0])[3].title).toBe('no call found from Routes to OrderService.create');
    expect(c.map((x) => x._classes.has('unver'))).toEqual([false, false, false, true, false, false, false]);
    // call line: arch names of both ends (a method as 'Component.name', as the server names targets), then the label
    expect(c[3].querySelector('.st-state')!.textContent).toBe('Routes → Services.create · create(order)');
    expect(c[0].querySelector('.st-state')!.textContent).not.toContain(' · ');
    expect(c[2].querySelector('.st-cap')!.textContent).toBe('POST /orders');
    const state = c[0].querySelectorAll('.st-state').find((e) => e._text === 'state: ')!;
    expect([state.children[0].tagName, state.children[0].textContent]).toEqual(['B', 'signed out']);
    expect(cards(h).some((x) => x._classes.has('cur'))).toBe(false);
    SIM(h).go(3);
    expect(cards(h).map((x) => x._classes.has('cur'))).toEqual([false, false, false, true, false, false, false]);
    expect(all(h, 'pn-note').map((n) => n.textContent)[1]).toBe('Step cursor: step 4 of 7. Every view, the path strip and the sequence show this step; '
      + '← → move it, "All" in the strip shows the whole path.');
  });

  it('rows tables: classes ins / chg from rowsTableHtml, values escaped', () => {
    const h = load(withSims((m) => { m.sims![0].steps[5].rows![0].rows[1].name = '<img src=x>'; }));
    SIM(h).select('s-1');
    const rows = cards(h).map((x) => x.querySelector('.st-rows'));
    expect(rows.map((r) => !!r)).toEqual([false, false, false, false, true, true, false]);
    expect(rows[4]!.innerHTML).toContain('<div class="sim-rows">');
    expect(rows[4]!.innerHTML).toContain('<tr class="ins">');   // step 5: the first rows are new
    expect(rows[5]!.innerHTML).toContain('<td class="chg"><s>10</s> → 9</td>');
    expect(rows[5]!.innerHTML).toContain('&lt;img src=x&gt;');
    expect(rows[5]!.innerHTML).not.toContain('<img');
  });

  it('names and captions with markup go in as text', () => {
    const h = load(withSims((m) => { m.sims![0].title = '<b>t</b>'; m.sims![0].steps[0].caption = '<i>c</i>'; }));
    SIM(h).select('s-1');
    expect(all(h, 'pn-header')[0].children[0]._text).toBe('<b>t</b>');
    expect(all(h, 'st-cap')[0].textContent).toBe('<i>c</i>');
    expect(all(h, 'st-cap')[0].innerHTML).toBe('');
  });

  it('a check message loses its own leading place (T7 "s-1 steps 7-8: "); one without it is shown unchanged', () => {
    const h = load(withSims((m) => {
      const s = m.sims![0].steps;
      s[3].unverified = 's-1 steps 3-4: shop.api.payments.charge has no code yet (planned only)';
      s[1].unconnected = 's-1 step 2: no relation from A to B';
      s[2].unconnected = 's-1 stage 1: no relation from C to D';
      s[4].unconnected = 'plain message';
    }));
    SIM(h).select('s-1');
    expect(all(h, 'pn-note')[0].textContent).toBe('sim-step-unverified (info): step 4: shop.api.payments.charge has no code yet (planned only). '
      + 'The step stays; it is drawn dashed until the code has the call.');
    expect(kids(cards(h)[3].children[0])[3].title).toBe('shop.api.payments.charge has no code yet (planned only)');
    expect([1, 2, 4].map((i) => cards(h)[i].querySelector('.st-note')!.textContent)).toEqual([
      'sim-step-unconnected: no relation from A to B', 'sim-step-unconnected: no relation from C to D', 'sim-step-unconnected: plain message',
    ]);
  });

  it('unconnected and missing show as small notes on the card', () => {
    const h = load(withSims((m) => { m.sims![0].steps[1].unconnected = 'no relation from A to B'; m.sims![0].steps[1].missing = ['x.y', 'z']; }));
    SIM(h).select('s-1');
    expect(cards(h)[1].querySelectorAll('.st-note').map((n) => n.textContent)).toEqual(['sim-step-unconnected: no relation from A to B', 'sim-target-missing: x.y, z']);
    expect(cards(h)[0].querySelectorAll('.st-note')).toHaveLength(0);
  });

  it('journey s-2: stage headers with goals, inflow cards, outside chip and text', () => {
    const h = load();
    SIM(h).select('s-2');
    expect(all(h, 'pn-kind')[0].textContent).toBe('Journey');
    expect(all(h, 'pn-badge').map((b) => b.textContent).slice(0, 2)).toEqual(['9 steps', '3 stages']);
    const list = all(h, 'st-list')[0];
    expect(kids(list).map((e) => (e._classes.has('st-stage') ? 'S' : e._classes.has('inflow') ? 'f' : 'c')).join('')).toBe('ScSfffffffSc');
    expect(all(h, 'st-stage').map((s) => [s._text, s.children.map((g) => g.textContent).join('')])).toEqual([
      ['Stage 1 · Discover · outside', ''], ['Stage 2 · Buy · flow s-1', 'goal: Place the order'], ['Stage 3 · Follow-up · outside', ''],
    ]);
    const c = cards(h);
    expect(kids(c[0].children[0]).map((e) => [e.className, e.textContent])).toEqual([['st-n', '1'], ['vchip out', 'outside · email'], ['st-tgt', 'Newsletter tool']]);
    expect(c[0].querySelector('.st-state')!.textContent).toBe('Reads the newsletter');
    expect(kids(c[8].children[0]).map((e) => e.className)).toEqual(['st-n', 'vchip out']);   // no from: no target
  });
});

// b853 S4 (b865, K Q9): the panel keeps the original cards and numbers; every card of the cursor's merged step is cur.
describe('flow depth', () => {
  it('at container with step 3 the cards of steps 3 and 4 (one flow step) are both cur', () => {
    const h = load();
    SIM(h).setDepth('container');
    SIM(h).select('s-1');
    expect(cards(h).some((x) => x._classes.has('cur'))).toBe(false);
    SIM(h).go(2);
    expect(cards(h).map((x) => x.querySelector('.st-n')!.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(cards(h).map((x) => x._classes.has('cur'))).toEqual([false, false, true, true, false, false, false]);
    SIM(h).go(4);
    expect(cards(h).map((x) => x._classes.has('cur'))).toEqual([false, false, false, false, true, false, false]);
  });
});

describe('clicks', () => {
  it('a card goes to its step with the fly; the buttons call act', () => {
    const h = load();
    const fly = jest.fn(), present = jest.fn(), seq = jest.fn();
    Object.assign(SIM(h).hooks, { fly, present, seq });
    SIM(h).select('s-1');
    cards(h)[4].click();
    expect(SIM(h).step()).toBe(4);
    expect(fly).toHaveBeenCalledTimes(1);
    expect(cards(h)[4]._classes.has('cur')).toBe(true);
    all(h, 'pbtn')[0].click();
    expect(present).toHaveBeenCalledWith('s-1', 4);
    all(h, 'pbtn')[1].click();
    expect(seq).toHaveBeenCalledTimes(1);
    all(h, 'pbtn')[2].click();
    expect(SIM(h).selected()).toBeNull();
    expect(cards(h)).toHaveLength(0);   // panel.js drew the summary
  });
});

describe('with a c-item', () => {
  it('"In simulations (N steps)" lists every step that touches the node or a node inside it', () => {
    const h = load();
    MAP(h).select('api/routes');
    expect(text(sectionOf(h, 'In simulations')!.children[0])).toBe('In simulations (4 steps)');
    expect(chips(h).map((c) => c.textContent)).toEqual(['s-1 · step 3', 's-1 · step 4', 's-2 · step 4', 's-2 · step 5']);
    expect(chips(h)[0].title).toBe('Place an order: POST /orders');
  });

  it('a container counts the steps of the nodes inside it (targets and call ends); a node no step touches gets no section', () => {
    const h = load();
    MAP(h).select('api');
    expect(chips(h).map((c) => c.textContent)).toEqual([3, 4, 5, 6, 7].map((n) => 's-1 · step ' + n).concat([4, 5, 6, 7, 8].map((n) => 's-2 · step ' + n)));
    MAP(h).select('api/services');   // OrderService.create inside it: s-1 step 4 (target and call end)
    expect(chips(h).map((c) => c.textContent)).toEqual(['s-1 · step 4', 's-2 · step 5']);
    MAP(h).select('api/models');
    expect(sectionOf(h, 'In simulations')).toBeNull();
  });

  it('a chip selects its s-item and goes to the step; the c-item panel stays', () => {
    const h = load();
    MAP(h).select('api/routes');
    chips(h)[3].click();
    expect(SIM(h).selected()).toBe('s-2');
    expect(SIM(h).step()).toBe(4);
    expect(MAP(h).selectedId()).toBe('api/routes');
    expect(cards(h)).toHaveLength(0);
  });

  it('selecting a c-item over an s-item shows the c-item; clearing it shows the s-item again', () => {
    const h = load();
    SIM(h).select('s-1');
    expect(cards(h)).toHaveLength(7);
    MAP(h).select('api/routes');
    expect(cards(h)).toHaveLength(0);
    expect(sectionOf(h, 'In simulations')).not.toBeNull();
    SIM(h).go(2);   // the cursor moves under a c-item: its panel stays
    expect(cards(h)).toHaveLength(0);
    MAP(h).select(null);
    expect(cards(h)).toHaveLength(7);
    expect(cards(h)[2]._classes.has('cur')).toBe(true);
  });
});
