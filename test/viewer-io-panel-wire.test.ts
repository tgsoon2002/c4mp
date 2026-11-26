import { renderViewHtml } from '../src/page/html';
import { buildNavView } from '../src/view/navLayout';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { NavEntry, NavPart, NavWireframe, ViewModel } from '../src/types';

// W13 (b309): the IO screen panel's 'Wireframe' section (renderScreenWireframe) and a part's placement line. Server facts come from
// NavEntry.wireframe and IoCard.viewport (W6); the drawn facts from C4PM_IOVIEW.wireOf / placed (W11 contract), stubbed in the sandbox.
// Sample: test/fixtures/nav-view/sample.json, with parts and wireframes added in memory and navView rebuilt by buildNavView.

const part = (fqn: string, kind: string, title: string, parts: NavPart[] = []): NavPart => ({ fqn, uid: null, kind, title, status: null, parts });
const wire = (over: Partial<NavWireframe>): NavWireframe => ({ file: 'plan/io/x.html', html: '<div></div>', refs: [], missing: [], ...over });

function model(wireframes: boolean): ViewModel {
  const m = loadSample();
  const entry = (fqn: string): NavEntry => m.nav!.groups.flatMap(g => g.entries).find(e => e.fqn === fqn)!;
  const home = entry('shop.web.home');
  home.parts = [
    part('shop.web.home.hero', 'region', 'Hero', [part('shop.web.home.hero.btn', 'control', 'Hero button')]),
    part('shop.web.home.side', 'region', 'Side', [part('shop.web.home.side.btn', 'control', 'Side button')]),
    part('shop.web.home.cta', 'control', 'Buy now'),
  ];
  entry('shop.mobile.mhome').metadata = { viewport: '400x900' };
  if (wireframes) {
    home.wireframe = wire({
      file: 'plan/io/shop.web.home.html',
      refs: [
        { ref: 'hero', fqn: 'shop.web.home.hero' },
        { ref: '<b>x', fqn: null, problem: 'unknown' },
        { ref: 'btn', fqn: null, problem: 'ambiguous', candidates: ['shop.web.home.hero.btn', 'shop.web.home.side.btn'] },
      ],
      missing: ['shop.web.home.cta'],
    });
    entry('shop.web.cart').wireframe = wire({ file: 'plan/io/shop.web.cart.html', html: undefined, error: 'over the 512 KB cap', missing: [] });
    entry('shop.mobile.mhome').wireframe = wire({ file: 'plan/io/shop.mobile.mhome.html', refs: [] });
  }
  m.navView = buildNavView(m.nav!);
  return m;
}

function load(m: ViewModel): HarnessResult {
  return runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: { href: 'file:///x.html#io', hash: '#io' } } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const select = (h: HarnessResult, id: string) => { win(h).C4PM_MAP.select(id); return h.panel; };
const wireSec = (h: HarnessResult) => h.panel.querySelectorAll('.pn-section').find(s => serializeText(s).startsWith('Wireframe'));
const notes = (el: FakeEl) => el.querySelectorAll('.pn-note').map(n => n.textContent);
const rowOf = (sec: FakeEl, word: string) => sec.querySelectorAll('.pn-rel').find(r => serializeText(r).startsWith(word))!;
// b610: the vm harness has no layout engine, so the real W11 wireOf answers 'not-drawn' ("no layout engine: DOMParser is missing") for
// every screen. A case about a DRAWN wireframe stubs wireOf with the state the browser measurer would give (W11 contract, ioView.js wireInfo).
const drawnAs = (h: HarnessResult, fqn: string, w: { state: string; reason?: string }) => {
  win(h).C4PM_IOVIEW.wireOf = (id: string) => (id === fqn ? w : null);
};

describe('W13 screen panel: Wireframe section', () => {
  it('no wireframe while another screen has one: the mark, the expected file, the size from the device', () => {
    const h = load(model(true));
    select(h, 'shop.web.login');
    const sec = wireSec(h)!;
    expect(notes(sec)).toEqual(['no wireframe']);
    const t = serializeText(sec);
    expect(t).toContain('expected file io/shop.web.login.html');
    expect(t).toContain('size 1280 x 800 (device)');
  });

  it('a page where no screen has a wireframe: no section', () => {
    const h = load(model(false));
    select(h, 'shop.web.home');
    expect(wireSec(h)).toBeUndefined();
    expect(serializeText(h.panel)).not.toContain('wireframe');
  });

  it('a server error: "wireframe not drawn" with the error text, no out-of-date lists', () => {
    const h = load(model(true));
    select(h, 'shop.web.cart');
    const sec = wireSec(h)!;
    expect(notes(sec)).toEqual(['wireframe not drawn']);
    const t = serializeText(sec);
    expect(t).toContain('over the 512 KB cap');
    expect(t).toContain('file plan/io/shop.web.cart.html');
    expect(sec.querySelectorAll('.pn-rel')).toEqual([]);
  });

  it('out of date: Missing (chip to the part), Unknown (the ref text), Ambiguous (the ref and its candidates as chips)', () => {
    const h = load(model(true));
    drawnAs(h, 'shop.web.home', { state: 'out-of-date', reason: 'not placed: shop.web.home.cta; unknown ref: <b>x; ambiguous ref: btn' });
    select(h, 'shop.web.home');
    const sec = wireSec(h)!;
    expect(notes(sec)).toEqual(['wireframe out of date']);
    const missing = rowOf(sec, 'Missing');
    expect(missing.querySelectorAll('.pn-dep-chip').map(b => [b.textContent, b.title])).toEqual([['Buy now', 'shop.web.home.cta']]);
    expect(serializeText(rowOf(sec, 'Unknown'))).toContain('<b>x');
    const amb = rowOf(sec, 'Ambiguous btn');
    expect(amb.querySelectorAll('.pn-dep-chip').map(b => b.textContent)).toEqual(['Hero button', 'Side button']);
    (missing.querySelectorAll('.pn-dep-chip')[0] as any).onclick();
    expect(win(h).C4PM_STATE.map.selectedId).toBe('shop.web.home.cta');
  });

  it('a ref like data-c4="<b>x" stays text: no element made, nothing set through innerHTML', () => {
    const h = load(model(true));
    select(h, 'shop.web.home');
    const sec = wireSec(h)!;
    expect(serializeText(rowOf(sec, 'Unknown'))).toMatch(/^Unknown\s+<b>x$/);
    const all = (el: FakeEl): FakeEl[] => [el, ...el.children.filter((c: any) => c.children).flatMap((c: any) => all(c))];
    expect(all(sec).filter(e => (e as any).tagName && String((e as any).tagName).toLowerCase() === 'b')).toEqual([]);
    expect(all(sec).map(e => e.innerHTML).filter(Boolean)).toEqual([]);
  });

  it('a clean wireframe: no mark, the size from viewport metadata and the file', () => {
    const h = load(model(true));
    drawnAs(h, 'shop.mobile.mhome', { state: 'ok' });
    select(h, 'shop.mobile.mhome');
    const sec = wireSec(h)!;
    expect(notes(sec)).toEqual([]);
    const t = serializeText(sec);
    expect(t).toContain('size 400 x 900 (viewport metadata)');
    expect(t).toContain('file plan/io/shop.mobile.mhome.html');
  });

  it('wireOf says not-drawn: "wireframe not drawn" and its reason; the server lists still show', () => {
    const h = load(model(true));
    win(h).C4PM_IOVIEW.wireOf = (fqn: string) => (fqn === 'shop.web.home' ? { state: 'not-drawn', reason: 'no layout engine' } : null);
    select(h, 'shop.web.home');
    const sec = wireSec(h)!;
    expect(notes(sec)).toEqual(['wireframe not drawn', 'wireframe out of date']);
    expect(serializeText(sec)).toContain('no layout engine');
  });
});

describe('W13 part panel: placement', () => {
  it('a part in wireframe.missing: "not placed in the wireframe"', () => {
    const h = load(model(true));
    expect(notes(select(h, 'shop.web.home.cta'))).toEqual(['not placed in the wireframe']);
  });

  it('placed() with hidden and two boxes: "shown sometimes", "placed 2 times"; no placed(): server facts only', () => {
    const h = load(model(true));
    expect(notes(select(h, 'shop.web.home.hero'))).toEqual([]);
    win(h).C4PM_IOVIEW.placed = (fqn: string) => (fqn === 'shop.web.home.hero' ? { boxes: 2, hidden: true } : null);
    expect(notes(select(h, 'shop.web.home.hero'))).toEqual(['shown sometimes', 'placed 2 times']);
  });

  it('a part of a screen without a wireframe: no placement line', () => {
    const h = load(model(false));
    expect(notes(select(h, 'shop.web.home.cta'))).toEqual([]);
  });
});
