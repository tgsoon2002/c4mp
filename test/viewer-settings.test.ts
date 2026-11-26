import path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import { TOOL_VERSION } from '../src/constants';
import { runViewerScripts } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';

// P20-T11 (b232): the settings popup (gear) and the C4PM_SETTINGS module, run in the fake DOM.

const IDS = ['btn-details', 'details-pop', 'btn-gear', 'settings-pop', 'search-mode', 'search-hint'];

// oldPage: a page built before P33, its data has no toolVersion.
// live: a fake C4PM_LIVE (a served page, b646); none = the static page.
function setup(store: Record<string, string> = {}, storage?: unknown, oldPage = false, live?: unknown) {
  const { model } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  const ls = storage ?? {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  let html = renderViewHtml(model);
  if (oldPage) html = html.replace(`,"toolVersion":${JSON.stringify(TOOL_VERSION)}`, '');
  const h = runViewerScripts(html, { extraIds: IDS, globals: live ? { localStorage: ls, C4PM_LIVE: live } : { localStorage: ls } });
  // the fake DOM does not read the markup's `hidden` attribute: both popups start hidden, as in the page
  // and has no Node.contains: give the four popup elements one
  const has = (a: any, b: any): boolean => a === b || (a.children ?? []).some((c: any) => has(c, b));
  ['settings-pop', 'details-pop', 'btn-gear', 'btn-details'].forEach(id => {
    const e = (h.sandbox.document as any).getElementById(id);
    if (id.endsWith('pop')) e.hidden = true;
    e.contains = (t: unknown) => has(e, t);
  });
  return { h, store };
}

const doc = (h: HarnessResult) => h.sandbox.document as any;
const win = (h: HarnessResult) => h.sandbox.window as any;
const el = (h: HarnessResult, id: string): FakeEl => doc(h).getElementById(id);
const settings = (h: HarnessResult) => win(h).C4PM_SETTINGS;
const pop = (h: HarnessResult) => el(h, 'settings-pop');
const choice = (h: HarnessResult, text: string): FakeEl => pop(h).querySelectorAll('button').find(b => b.textContent === text)!;
const hidden = (e: FakeEl) => (e as any).hidden;
const theme = (h: HarnessResult) => doc(h).documentElement.getAttribute('data-theme');
const switchBtn = (h: HarnessResult, text: string): FakeEl => el(h, 'search-mode').children.find(c => c.textContent === text)!;

describe('P20-T11 settings popup', () => {
  it('the gear opens and closes the popup: second click, Esc, outside click; (i) and gear exclude each other', () => {
    const { h } = setup();
    const gear = el(h, 'btn-gear');
    gear.click();
    expect(hidden(pop(h))).toBe(false);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    gear.click();
    expect(hidden(pop(h))).toBe(true);
    gear.click();
    doc(h).dispatch('keydown', { key: 'Escape' });
    expect(hidden(pop(h))).toBe(true);
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    gear.click();
    doc(h).dispatch('click', { target: el(h, 'map') });
    expect(hidden(pop(h))).toBe(true);
    gear.click();
    doc(h).dispatch('click', { target: choice(h, 'Dark') });   // a click inside the popup keeps it open
    expect(hidden(pop(h))).toBe(false);
    el(h, 'btn-details').click();
    expect(hidden(pop(h))).toBe(true);
    expect(hidden(el(h, 'details-pop'))).toBe(false);
  });

  // P33: the build that made the page sits in the title row (top-right); an old page without toolVersion shows none.
  it('the title row shows the c4pm version as "c4pm <version>" in .set-version; none when the page data has no toolVersion', () => {
    const { h } = setup();
    const title = pop(h).querySelector('.set-title')!;
    const ver = title.querySelectorAll('.set-version');
    expect(ver.length).toBe(1);
    expect(ver[0].textContent).toBe(TOOL_VERSION.replace('@', ' '));
    expect(ver[0].textContent).toMatch(/^c4mp \d+\.\d+\.\d+/);
    const old = setup({}, undefined, true).h;
    expect(win(old).C4PM_DATA.toolVersion).toBeUndefined();
    expect(pop(old).querySelector('.set-title')).not.toBeNull();
    expect(pop(old).querySelectorAll('.set-version').length).toBe(0);
  });

  it('one row per table key; Theme Dark sets data-theme, System removes it; the choice is stored', () => {
    const { h, store } = setup();
    expect(pop(h).querySelectorAll('.set-row').length).toBe(Object.keys(settings(h).DEF).length);
    expect(theme(h)).toBeUndefined();
    choice(h, 'Dark').click();
    expect(theme(h)).toBe('dark');
    expect(choice(h, 'Dark').getAttribute('aria-pressed')).toBe('true');
    expect(choice(h, 'System').getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(store['c4mp.settings']).theme).toBe('dark');
    choice(h, 'Light').click();
    expect(theme(h)).toBe('light');
    choice(h, 'System').click();
    expect(theme(h)).toBeUndefined();
  });

  it('a stored value is applied at load; an invalid or unparsable stored value falls back to its default', () => {
    expect(theme(setup({ 'c4mp.settings': JSON.stringify({ theme: 'dark' }) }).h)).toBe('dark');
    const bad = setup({ 'c4mp.settings': JSON.stringify({ theme: 'purple', search: 7 }) }).h;
    expect(settings(bad).get('theme')).toBe('system');
    expect(settings(bad).get('search')).toBe('names');
    expect(settings(setup({ 'c4mp.settings': '{not json' }).h).get('help')).toBe('show');
  });

  it('Light implemented components (b130): default off, On/Off stored, onChange fires', () => {
    const { h, store } = setup();
    expect(settings(h).get('lightImpl')).toBe('off');
    expect(settings(h).DEF.lightImpl.label).toBe('Light implemented components');
    const seen: string[] = [];
    settings(h).onChange((k: string, v: string) => seen.push(k + '=' + v));
    settings(h).set('lightImpl', 'on');
    expect(seen).toEqual(['lightImpl=on']);
    expect(JSON.parse(store['c4mp.settings']).lightImpl).toBe('on');
  });

  it('Help text Hide sets no-help on #root; Show removes it', () => {
    const { h } = setup();
    choice(h, 'Hide').click();
    expect(el(h, 'root').classList.contains('no-help')).toBe(true);
    choice(h, 'Show').click();
    expect(el(h, 'root').classList.contains('no-help')).toBe(false);
  });

  it('Search starts in is one value: the popup and the search-box switch both set it, a reload keeps it', () => {
    const { h, store } = setup();
    choice(h, 'Content').click();
    expect(win(h).C4PM_SEARCH.mode()).toBe('content');
    expect(JSON.parse(store['c4mp.settings']).search).toBe('content');
    switchBtn(h, 'Names').click();
    expect(settings(h).get('search')).toBe('names');
    expect(choice(h, 'Names').getAttribute('aria-pressed')).toBe('true');
    switchBtn(h, 'Content').click();
    expect(choice(h, 'Content').getAttribute('aria-pressed')).toBe('true');
    expect(win(setup(store).h).C4PM_SEARCH.mode()).toBe('content');
  });

  it('migrates c4pm.searchMode once into c4mp.settings and removes the old key; a stored value wins', () => {
    const { h, store } = setup({ 'c4pm.searchMode': 'content' });
    expect(settings(h).get('search')).toBe('content');
    expect(JSON.parse(store['c4mp.settings']).search).toBe('content');
    expect('c4pm.searchMode' in store).toBe(false);
    const kept = setup({ 'c4mp.settings': JSON.stringify({ search: 'names' }), 'c4pm.searchMode': 'content' }).h;
    expect(settings(kept).get('search')).toBe('names');
  });

  // Phase 35 C (b945): the saved settings of an earlier version live under c4pm.*; they are read, and every write goes to c4mp.* only.
  it('an old c4pm.settings value is read when c4mp.settings is missing; the new key wins; writes go to c4mp.settings only', () => {
    const old = setup({ 'c4pm.settings': JSON.stringify({ theme: 'dark' }) });
    expect(theme(old.h)).toBe('dark');
    expect('c4mp.settings' in old.store).toBe(false);   // reading writes nothing
    choice(old.h, 'Light').click();
    expect(JSON.parse(old.store['c4mp.settings']).theme).toBe('light');
    expect(JSON.parse(old.store['c4pm.settings']).theme).toBe('dark');   // the old key is never written
    const both = setup({ 'c4pm.settings': JSON.stringify({ theme: 'dark' }), 'c4mp.settings': JSON.stringify({ theme: 'light' }) });
    expect(theme(both.h)).toBe('light');
  });

  it('C4PM_STORE: get reads the new key else the old one, set writes the new key only, remove drops both, blocked storage is silent', () => {
    const store: Record<string, string> = { 'c4pm.leftWidth': '300', 'c4mp.rightWidth': '400', 'c4pm.rightWidth': '999' };
    const S = win(setup(store).h).C4PM_STORE;
    expect(S.get('c4mp.leftWidth')).toBe('300');
    expect(S.get('c4mp.rightWidth')).toBe('400');
    expect(S.get('c4mp.nothing')).toBeNull();
    S.set('c4mp.leftWidth', '310');
    expect(store['c4mp.leftWidth']).toBe('310');
    expect(store['c4pm.leftWidth']).toBe('300');
    S.remove('c4mp.rightWidth');
    expect('c4mp.rightWidth' in store || 'c4pm.rightWidth' in store).toBe(false);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const B = win(setup({}, blocked).h).C4PM_STORE;
    expect(B.get('c4mp.x')).toBeNull();
    expect(() => { B.set('c4mp.x', '1'); B.remove('c4mp.x'); }).not.toThrow();
  });

  it('blocked storage: defaults, set still works for the page; an unknown key or value throws', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const { h } = setup({}, blocked);
    expect(settings(h).get('theme')).toBe('system');
    choice(h, 'Dark').click();
    expect(theme(h)).toBe('dark');
    expect(() => settings(h).set('theme', 'purple')).toThrow();
    expect(() => settings(h).get('nope')).toThrow();
  });

  // LAY-12b (b382): link.js registers the 'Window link' status line (settings.js names no later script).
  it('setStatus: the registered text is the row status line; a key without a status line or a non-function throws', () => {
    const { h } = setup();
    const link = settings(h).DEF.link;
    expect(link.status()).toBe(win(h).C4PM_LINK.status());   // link.js registered it at its load
    settings(h).setStatus('link', () => 'custom line');
    expect(link.status()).toBe('custom line');
    expect(() => settings(h).setStatus('theme', () => 'x')).toThrow('no status line');
    expect(() => settings(h).setStatus('nope', () => 'x')).toThrow('no status line');
    expect(() => settings(h).setStatus('link', 'x' as any)).toThrow('fn must be a function');
  });
});

// b646 (SV13b): in a served page the file (C4PM_LIVE.settings) wins at load and changes are pushed.
describe('served page (b646)', () => {
  type Call = { m: string; p: string; b: any };
  // live.js polls api/wait through the same request: only api/settings calls are kept.
  function liveSetup(file: Record<string, unknown>, store: Record<string, string> = {}, reject = false) {
    const calls: Call[] = [];
    const live = {
      generation: 1, stamps: {}, settings: file, error: null, dirty: () => {}, isDirty: () => false,
      request: (m: string, p: string, b: any) => {
        if (p !== 'api/settings') return new Promise(() => {});
        calls.push({ m, p, b });
        return reject ? Promise.reject(new Error('down')) : Promise.resolve({ status: 200, json: { ok: true } });
      },
    };
    return { ...setup(store, undefined, false, live), calls };
  }

  it('the file wins at load: valid values only; the browser copy follows', () => {
    const { h, store, calls } = liveSetup({ theme: 'dark', search: 'BAD', bogus: 'x' }, { 'c4mp.settings': JSON.stringify({ theme: 'light', search: 'content' }) });
    expect(settings(h).get('theme')).toBe('dark');
    expect(settings(h).get('search')).toBe('content');
    expect(JSON.parse(store['c4mp.settings']).theme).toBe('dark');
    expect(theme(h)).toBe('dark');
    h.flushTimers();
    expect(calls).toEqual([]);   // loading from the file sends nothing back
  });

  it('a change is sent once, 300 ms after the last one, with all six settings', () => {
    const { h, calls } = liveSetup({});
    settings(h).set('help', 'hide');
    h.flushTimers();
    expect(calls.length).toBe(1);
    expect(calls[0].m).toBe('PUT');
    expect(Object.keys(calls[0].b.settings).sort()).toEqual(Object.keys(settings(h).DEF).sort());
    expect(Object.keys(calls[0].b.settings).length).toBe(6);
    expect(calls[0].b.settings.help).toBe('hide');
    settings(h).set('theme', 'dark');
    settings(h).set('openIn', 'here');
    h.flushTimers();
    expect(calls.length).toBe(2);
    expect(calls[1].b.settings).toMatchObject({ theme: 'dark', openIn: 'here', help: 'hide' });
  });

  it('the static page never sends a request', () => {
    const { h, store } = setup();
    settings(h).set('help', 'hide');
    h.flushTimers();
    expect(JSON.parse(store['c4mp.settings']).help).toBe('hide');
  });

  it('a rejected PUT: no throw, the setting stays', async () => {
    const { h, calls } = liveSetup({}, {}, true);
    settings(h).set('help', 'hide');
    expect(() => h.flushTimers()).not.toThrow();
    await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(settings(h).get('help')).toBe('hide');
  });

  it('the popup note names the file in a served page and the browser in a static one', () => {
    const texts = (h: HarnessResult) => pop(h).children.map(c => c.textContent);
    expect(texts(liveSetup({}).h).some(t => t.startsWith('Kept in your c4mp settings file'))).toBe(true);
    expect(texts(setup().h).some(t => t.startsWith('Kept in this browser only'))).toBe(true);
  });
});
