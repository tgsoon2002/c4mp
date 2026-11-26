import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample, ioModel } from './helpers/nav-view';
import type { ViewModel } from '../src/types';

// P20-T5-D (b258): the left tree follows the mode: apps with their screens in io, the original rows in arch.

function load(model: ViewModel) {
  const h = runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop'] });
  const w = h.sandbox.window as any;
  // Architecture rows only: they carry data-id (Files rows carry data-path or data-dir).
  const rowEls = () => (w.document.getElementById('left').querySelectorAll('.lt-row') as any[]).filter(r => r.dataset.id);
  const rows = () => rowEls().map(r => ({
    id: r.dataset.id, kind: r.dataset.kind, tag: r.children[1].textContent, name: r.children[2].textContent,
  }));
  return { w, rows, rowEls };
}
// Open every closed row so lazy children exist.
function openAll(rowEls: () => any[]) {
  for (let i = 0; i < 20; i++) {
    const closed = rowEls().filter(r => r.getAttribute('aria-expanded') === 'false');
    if (!closed.length) return;
    closed.forEach(r => r.children[0].onclick({ stopPropagation() {} }));
  }
}
const IO_ROWS = ['IO view', 'Web app', 'Login', 'Home', 'Cart', 'Shop mobile app', 'MHome'];

describe('left tree by mode (b258)', () => {
  it('io-only page opened in io shows apps then screens with the screen tag', () => {
    const { w, rows, rowEls } = load(ioModel(loadSample()));
    w.C4PM_MODE.set('io');
    openAll(rowEls);
    expect(rows().map(r => r.name)).toEqual(IO_ROWS);
    expect(rows().filter(r => r.kind === 'screen').every(r => r.tag === 'screen')).toBe(true);
    // b263: no C1/C2/C3 in the io tree; the words come from the kind
    expect(rows().map(r => r.tag)).toEqual(['all', 'app', 'screen', 'screen', 'screen', 'app', 'screen']);
  });

  it('normal page: set(io) swaps rows, set(arch) restores the originals', () => {
    const { w, rows, rowEls } = load(loadSample());
    const before = rows();
    expect(before[0].name).toBe('sample-shop');
    w.C4PM_MODE.set('io');
    openAll(rowEls);
    expect(rows().map(r => r.name)).toEqual(IO_ROWS);
    w.C4PM_MODE.set('arch');
    expect(rows()).toEqual(before);
    expect(before[0].tag).toBe('C1');   // arch words unchanged
  });

  it('clicking a screen row selects through C4PM_MAP', () => {
    const { w, rowEls } = load(ioModel(loadSample()));
    w.C4PM_MODE.set('io');
    openAll(rowEls);
    const calls: string[] = [];
    const sel = w.C4PM_MAP.select;
    w.C4PM_MAP.select = (id: string) => { calls.push(id); return sel(id); };
    rowEls().find(r => r.dataset.id === 'shop.web.cart').onclick();
    expect(calls).toEqual(['shop.web.cart']);
  });
});
