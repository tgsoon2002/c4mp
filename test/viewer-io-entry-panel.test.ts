import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { IoCard, ViewModel, ViewNode } from '../src/types';

// b128/b234/p27: what the panel shows for an IO entry: the Design section and a command entry's parts. Fake canvas, no browser.

const CARD = {
  kind: 'screen',
  device: 'web',
  design: 'https://figma.example/home',
  rows: [
    { id: 'shop.web.home.hero', kind: 'region', title: 'Hero', depth: 0 },
    { id: 'shop.web.home.cta', kind: 'control', title: 'Buy now', depth: 1, nav: { to: 'shop.web.cart', label: 'Buy' } },
    { id: 'shop.web.home.plain', kind: 'control', title: 'Plain control', depth: 1 },
    { id: 'shop.web.home.empty', kind: 'state', title: 'Empty basket', depth: 0, status: 'planned' },
  ],
} as IoCard;
const walk = (n: ViewNode, fn: (n: ViewNode) => void) => { fn(n); n.children.forEach(c => walk(c, fn)); };
function withIo(m: ViewModel, design: string | null = CARD.design!): ViewModel {
  walk(m.navView!.root, n => { if (n.id === 'shop.web.home') { n.io = { ...CARD, design: design ?? undefined }; if (design === null) delete n.io.design; } });
  return m;
}
function load(m: ViewModel, hash: string): HarnessResult {
  return runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: { href: 'file:///x.html' + hash, hash } } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;

describe('IO panel: Design section', () => {
  const panelFor = (design: string | null) => {
    const h = load(withIo(loadSample(), design), '#io');
    win(h).C4PM_MAP.select('shop.web.home');
    return h.panel;
  };
  it('http(s) design is a link with target _blank and rel noopener', () => {
    const p = panelFor('https://figma.example/home');
    const a = p.querySelectorAll('a').find(x => x.textContent === 'https://figma.example/home')!;
    expect(a.href).toBe('https://figma.example/home');
    expect((a as any).target).toBe('_blank');
    expect((a as any).rel).toContain('noopener');
  });
  it('a path or javascript: value is plain text, never a link; no design: no section', () => {
    for (const d of ['design/home.png', 'javascript:alert(1)']) {
      const p = panelFor(d);
      expect(serializeText(p)).toContain('Design');
      expect(serializeText(p)).toContain(d);
      expect(p.querySelectorAll('a').length).toBe(0);
    }
    expect(serializeText(panelFor(null))).not.toContain('Design');
  });
});


const CMD = {
  kind: 'command',
  rows: [
    { id: 'c.run.opts', kind: 'options', title: 'Options', depth: 0 },
    { id: 'c.run.file', kind: 'flag', title: '--file <path>', depth: 1 },
    { id: 'c.run.dry', kind: 'flag', title: '--dry-run', depth: 1 },
    { id: 'c.run.name', kind: 'arg', title: '<name>', depth: 0 },
  ],
} as unknown as IoCard;

describe('IO panel with a command entry', () => {
  function withCommand(m: ViewModel): ViewModel {
    walk(m.navView!.root, n => { if (n.id === 'shop.web.home') n.io = { ...CMD }; });
    ((m.nav!.groups[0] as any).entries as any[]).find(e => e.fqn === 'shop.web.home').kind = 'command';
    return m;
  }
  const loadCmd = () => {
    const h = load(withCommand(loadSample()), '#io');
    const io = win(h).C4PM_DATA.kindWords.io;
    Object.entries({ command: 'cmd', options: 'opts', flag: 'flag', arg: 'arg' }).forEach(([k, t]) => { io[k] = { tag: t, hud: k[0].toUpperCase() + k.slice(1), color: 'screen' }; });
    return h;
  };

  it('panel: the entry kind in the header, its parts, Calls; no navigation sections', () => {
    const h = loadCmd();
    win(h).C4PM_MAP.select('shop.web.home');
    const t = serializeText(h.panel);
    expect(t).toContain('command');
    expect(t).toContain('Parts');
    expect(t).toContain('--file <path>');
    expect(t).toContain('Calls');
    expect(t).not.toContain('Navigates to');
    expect(t).not.toContain('Reached from');
  });
});
