import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// P20-T5-E (b259): panel, search and legend follow the view (arch / io). Sample: test/fixtures/nav-view/sample.json.

function load(hash: string) {
  const loc = { href: 'file:///x.html' + hash, hash };
  const h = runViewerScripts(renderViewHtml(loadSample()), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: loc } });
  return { h, loc };
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const el = (h: HarnessResult, id: string): FakeEl => (h.sandbox.document as any).getElementById(id);
const panelText = (h: HarnessResult) => serializeText(h.panel);
const type = (h: HarnessResult, q: string) => {
  h.search.value = q;
  h.search.dispatch('input', { target: h.search });
  h.flushTimers();
};
const rows = (h: HarnessResult) => h.searchResults.querySelectorAll('.pn-search-result');
const legend = (h: HarnessResult) => serializeText(el(h, 'legend'));
const sections = (h: HarnessResult) => h.panel.querySelectorAll('.pn-section');
const sectionText = (h: HarnessResult, title: string) => serializeText(sections(h).find(s => serializeText(s).startsWith(title))!);

describe('IO view: screen panel', () => {
  it('shows status, uid with copy button, group, Navigates to and Reached from with labels', () => {
    const { h } = load('#io');
    win(h).C4PM_MAP.select('shop.web.home');
    const t = panelText(h);
    expect(t).toContain('Home');
    expect(t).toContain('screen');
    expect(t).toContain('done');
    expect(t).toContain('uid u-home');
    expect(h.panel.querySelectorAll('.pn-copy').map(b => b.textContent)).toEqual(['Copy uid']);
    expect(sectionText(h, 'Group')).toContain('Web app');
    const to = sectionText(h, 'Navigates to');
    expect(to).toContain('Cart');
    expect(to).toContain('MHome');
    const from = sectionText(h, 'Reached from');
    expect(from).toContain('Login');
    expect(from).toContain('"Sign in"');
    expect(from).toContain('Cart');
    expect(from).toContain('"Back"');
    expect(t).not.toContain('Depends on');
    expect(t).not.toContain('Copy remove command');
  });

  it('a link selects that screen; the breadcrumb runs through the group', () => {
    const { h } = load('#io');
    const w = win(h);
    w.C4PM_MAP.select('shop.web.home');
    const to = sections(h).find(s => serializeText(s).startsWith('Navigates to'))!;
    (to.querySelectorAll('button').find(b => b.textContent === 'Cart') as any).onclick();   // the panel sets onclick, as the deps chips do
    expect(w.C4PM_STATE.map.selectedId).toBe('shop.web.cart');
    expect(panelText(h)).toContain('uid u-cart');
    expect(h.panel.querySelectorAll('.pn-crumb').map(b => b.textContent)).toEqual(['IO view', 'Web app', 'Cart']);
  });

  it('a group lists its screens; the summary counts screens', () => {
    const { h } = load('#io');
    expect(panelText(h)).toContain('4 screens');
    win(h).C4PM_MAP.select('shop.web');
    expect(sectionText(h, 'Screens')).toContain('Login');
    expect(panelText(h)).not.toContain('Used by');
  });
});

describe('IO view: search and legend', () => {
  it('search "cart" finds the Cart screen and selecting works; Content behaves as Names', () => {
    const { h } = load('#io');
    type(h, 'cart');
    expect(rows(h).length).toBe(1);
    expect(serializeText(rows(h)[0])).toContain('Cart');
    rows(h)[0].click();
    expect(win(h).C4PM_STATE.map.selectedId).toBe('shop.web.cart');
    win(h).C4PM_SETTINGS.set('search', 'content');
    type(h, 'u-mhome');
    expect(serializeText(rows(h)[0])).toContain('MHome');
    type(h, 'shop.web');
    expect(rows(h).length).toBe(4);   // the group and its 3 screens, by fqn
  });

  it('legend has Screen only in io; switching back restores arch panel, search and legend', () => {
    const { h, loc } = load('#io');
    expect(legend(h)).toContain('Screen');
    loc.hash = '';
    h.fireWindowEvent('hashchange');
    expect(legend(h)).not.toContain('Screen');
    type(h, 'cart');
    expect(rows(h).length).toBe(0);
    win(h).C4PM_MAP.select(win(h).C4PM_DATA.root.children[0].id);
    expect(panelText(h)).not.toContain('Navigates to');
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    expect(legend(h)).toContain('Screen');
    type(h, 'cart');
    expect(rows(h).length).toBe(1);
  });

  it('arch page: no Screen swatch', () => {
    expect(legend(load('').h)).not.toContain('Screen');
  });
});
