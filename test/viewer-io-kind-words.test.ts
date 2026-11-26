import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { ViewModel, ViewNode } from '../src/types';

// b284: an IO entry is a ViewNode of kind 'screen', but the tree badge, the panel summary and the header chips
// use its real kind (node.io.kind) and the words of the kind table (C4PM_MODE).

const walk = (n: ViewNode, fn: (n: ViewNode) => void) => { fn(n); n.children.forEach(c => walk(c, fn)); };
/** The sample with Login a command and Cart a tool; Home stays a screen (shop.web has 3 entries, shop.mobile 1 screen). */
function mixed(): ViewModel {
  const m = loadSample();
  const kinds: Record<string, string> = { 'shop.web.login': 'command', 'shop.web.cart': 'tool' };
  ((m.nav!.groups[0] as any).entries as any[]).forEach(e => { if (kinds[e.fqn]) e.kind = kinds[e.fqn]; });
  walk(m.navView!.root, n => { if (kinds[n.id]) n.io = { kind: kinds[n.id], rows: [] } as any; });
  return m;
}
function load(model: ViewModel): HarnessResult {
  return runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: { href: 'file:///x.html#io', hash: '#io' } } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;

describe('IO entries show their real kind (b284)', () => {
  it('C4PM_MODE.counts: table order, lower-case word, plural by s, singular for 1', () => {
    const w = win(load(loadSample()));
    expect(w.C4PM_MODE.counts(['tool', 'command', 'screen', 'command', 'screen', 'screen'])).toBe('3 screens · 2 commands · 1 tool');
    expect(w.C4PM_MODE.counts([])).toBe('');
  });

  it('header chips: counts per kind', () => {
    const h = load(mixed());
    expect((h.sandbox.document as any).getElementById('bar-chips').textContent).toBe('2 apps · 2 screens · 1 command · 1 tool · 4 links');
  });

  it('panel summary: counts per kind', () => {
    const h = load(mixed());
    expect(serializeText(h.panel)).toContain('IO view: 2 groups · 2 screens · 1 command · 1 tool · 4 navigations');
  });

  it('left tree: the badge of an entry is the tag of its real kind', () => {
    const h = load(mixed());
    const rows = (win(h).document.getElementById('left').querySelectorAll('.lt-row') as any[]).filter(r => r.dataset.id);
    const open = () => rows.filter(r => r.getAttribute('aria-expanded') === 'false').forEach(r => r.children[0].onclick({ stopPropagation() {} }));
    for (let i = 0; i < 5; i++) open();
    const tagOf = (id: string) => (win(h).document.getElementById('left').querySelectorAll('.lt-row') as any[]).find(r => r.dataset.id === id).children[1].textContent;
    expect(tagOf('shop.web.login')).toBe('cmd');
    expect(tagOf('shop.web.cart')).toBe('tool');
    expect(tagOf('shop.web.home')).toBe('screen');
  });
});
