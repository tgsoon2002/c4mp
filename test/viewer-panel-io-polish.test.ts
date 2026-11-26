import * as fs from 'fs';
import * as path from 'path';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { ViewModel } from '../src/types';

// P20-T5-P (b263): IO view polish - panel title, uid row spacing, no repeated control label, status pill.

function load(model: ViewModel, hash = '#io') {
  const loc = { href: 'file:///x.html' + hash, hash };
  return runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: loc } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const text = (h: HarnessResult) => serializeText(h.panel);

describe('IO view polish (b263)', () => {
  it('nothing selected: the panel title says "IO view", not the repo name', () => {
    const sample = loadSample();
    const h = load(sample);
    expect(sample.title).not.toBe('IO view');
    expect(h.panel.querySelectorAll('h2').map(e => e.textContent)).toEqual(['IO view']);
  });

  it('a screen with meta.status shows the status pill', () => {
    const h = load(loadSample());
    win(h).C4PM_MAP.select('shop.web.home');
    expect(h.panel.querySelectorAll('.pn-status').map(e => e.textContent)).toEqual(['done']);
  });

  it('the uid row of both views gets its gap from the one .pn-uid .pn-copy rule', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'viewer', 'panel.css'), 'utf8');
    expect(src).toContain('.pn-uid .pn-copy { margin-left: 8px; }');
    const h = load(loadSample());
    win(h).C4PM_MAP.select('shop.web.home');
    expect(h.panel.querySelectorAll('.pn-uid')[0].querySelectorAll('.pn-copy').length).toBe(1);
  });

  it('a nav edge shows the quoted label only when it is its own; the control shows once', () => {
    const m = loadSample();
    m.nav!.edges = [
      { from: 'shop.web.login', to: 'shop.web.home', label: 'cart_btn', via: 'shop.web.login.cart_btn' },   // fallback label = control name
      { from: 'shop.web.login', to: 'shop.web.cart', label: 'Sign in', labelled: true, via: 'shop.web.login.submit' },   // own label
    ] as any;
    const h = load(m);
    win(h).C4PM_MAP.select('shop.web.login');
    const t = text(h);
    expect(t).toContain('via cart_btn');
    expect(t).not.toContain('"cart_btn"');
    expect(t).toContain('"Sign in" via submit');
  });

  it('an own label equal to the control name keeps its quotes (the labelled flag decides, not the comparison)', () => {
    const m = loadSample();
    m.nav!.edges = [{ from: 'shop.web.login', to: 'shop.web.home', label: 'submit', labelled: true, via: 'shop.web.login.submit' }] as any;
    const h = load(m);
    win(h).C4PM_MAP.select('shop.web.login');
    expect(text(h)).toContain('"submit" via submit');
  });

  it('breadcrumb chips in io use the io words, arch keeps C1/C2/C3', () => {
    const h = load(loadSample());
    win(h).C4PM_MAP.select('shop.web.home');
    const chips = h.panel.querySelectorAll('.pn-crumb-chip').map(e => e.textContent);
    expect(chips).toEqual(['all', 'app', 'screen']);
    const a = load(loadSample(), '');
    win(a).C4PM_MAP.select('sample-shop');
    expect(a.panel.querySelectorAll('.pn-crumb-chip').map(e => e.textContent)).toEqual(['C1']);
  });
});
