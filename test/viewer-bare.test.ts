import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import { readFileSync } from 'fs';
import { join } from 'path';

// P20-T5-Q (b264): '&bare' in the hash = a window that shows only the map. mode.js sets class 'bare' on #root once.

function load(hash: string, storage: Record<string, string> = {}) {
  const loc = { href: 'file:///x.html' + hash, hash };
  const h = runViewerScripts(renderViewHtml(loadSample()), {
    extraIds: ['btn-gear', 'settings-pop', 'view-toast'],
    globals: {
      location: loc,
      open: () => ({ focus() {} }),
      localStorage: { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => { storage[k] = v; } },
    },
  });
  const w = h.sandbox.window as any;
  const root = (h.sandbox.document as any).getElementById('root');
  return { w, root, loc, storage };
}

describe('bare window', () => {
  it.each([
    ['#io&bare', true, 'io'],
    ['#arch&bare', true, 'arch'],
    ['#io', false, 'io'],
    ['', false, 'arch'],
  ])('hash %j: bare %s, mode %s', (hash, bare, mode) => {
    const { w, root } = load(hash);
    expect(w.C4PM_MODE.bare()).toBe(bare);
    expect(root.classList.contains('bare')).toBe(bare);
    expect(w.C4PM_MODE.get()).toBe(mode);
  });

  it('writes no collapse key', () => {
    const { storage } = load('#io&bare');
    expect(Object.keys(storage).filter(k => /^c4pm\.(leftCollapsed|rightCollapsed|topHidden)$/.test(k))).toEqual([]);
  });

  it('the flag does not change on hashchange', () => {
    const { w, root, loc } = load('#io&bare');
    loc.hash = '#arch';
    expect(w.C4PM_MODE.bare()).toBe(true);
    expect(root.classList.contains('bare')).toBe(true);
  });

  it('C4PM_OPEN urls end with &bare', () => {
    const calls: string[] = [];
    const loc = { href: 'file:///x.html?a=1#io', hash: '#io' };
    const h = runViewerScripts(renderViewHtml(loadSample()), {
      extraIds: ['view-toast'],
      globals: { location: loc, open: (u: string) => { calls.push(u); return { focus() {} }; } },
    });
    const w = h.sandbox.window as any;
    w.C4PM_OPEN('io');
    w.C4PM_OPEN('arch');
    expect(calls).toEqual(['file:///x.html?a=1#io&bare', 'file:///x.html?a=1#arch&bare']);
  });

  it('#root.bare css hides the chrome and keeps the camera buttons', () => {
    const css = readFileSync(join(__dirname, '../viewer/style.css'), 'utf8');
    const block = css.slice(css.indexOf('#root.bare #header'));
    const hidden = block.slice(0, block.indexOf('{'));
    for (const id of ['#header', '#left', '#panel-col', '#board-drawer', '.side-toggle', '.edge-toggle', '#hud-bl', '#legend', '#made-with']) {   // b168: the credit link too
      expect(hidden).toContain('#root.bare ' + id);
    }
    for (const id of ['#hud-tr', '#hud-tl', '#btn-up', '#btn-fit']) expect(hidden).not.toContain(id);
  });
});
