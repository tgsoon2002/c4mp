import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import { withFakeView } from './helpers/fake-view';

// P20-T12 (b233), VIEW-0 (b337): the #view-switch segments in the top bar (one per registered view), run in the fake DOM.

const BASE = 'file:///x.html?a=1';

function setup(opts: { hash?: string; noNav?: boolean; stored?: Record<string, string>; storage?: boolean } = {}) {
  const model = loadSample();
  if (opts.noNav) delete (model as any).navView;
  const calls: unknown[][] = [];
  const store: Record<string, string> = { ...(opts.stored ?? {}) };
  const location = { href: BASE + (opts.hash ?? ''), hash: opts.hash ?? '' };
  const html = renderViewHtml(model);
  const h = runViewerScripts(opts.storage === false ? html : withFakeView(html), {
    extraIds: ['btn-gear', 'settings-pop'],
    globals: {
      location,
      open: (...a: unknown[]) => { calls.push(a); return { focus() {} }; },
      localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } },
    },
  });
  const doc = h.sandbox.document as any;
  const box = doc.getElementById('view-switch');
  const seg = (mode: string) => box.children.find((b: any) => b.getAttribute('data-mode') === mode);
  const pressed = () => box.children.filter((b: any) => b.getAttribute('aria-pressed') === 'true').map((b: any) => b.getAttribute('data-mode'));
  return { h, calls, location, box, seg, pressed, win: h.sandbox.window as any, pop: doc.getElementById('settings-pop') };
}

describe('VIEW-0 view switch', () => {
  it('one segment per registered view, in registration order: label, data-short, title', () => {
    const s = setup();
    expect(s.box.children.map((b: any) => [b.tagName, b.getAttribute('type'), b.getAttribute('data-mode'), b.textContent, b.getAttribute('data-short')])).toEqual([
      ['BUTTON', 'button', 'arch', 'Architecture view', 'Arch'],
      ['BUTTON', 'button', 'io', 'IO view', 'IO'],
      ['BUTTON', 'button', 'storage', 'Storage view', 'Storage'],
    ]);
    // b602: openIn 'window' (default): another view's title says where it opens; the current one is the plain name.
    expect(s.box.children.map((b: any) => b.getAttribute('title'))).toEqual(['Architecture view', 'IO view (opens in its own window)', 'Storage view (opens in its own window)']);
    expect(s.box.children.every((b: any) => !b.disabled)).toBe(true);
    expect(s.pressed()).toEqual(['arch']);
  });

  it('a real page has three segments; storage is disabled while C4PM_DATA has no storageView', () => {
    const s = setup({ storage: false });
    expect(s.box.children.map((b: any) => b.getAttribute('data-mode'))).toEqual(['arch', 'io', 'storage']);   // STOR-6a (b339)
    expect(s.seg('storage').disabled).toBe(true);
    expect(s.seg('storage').getAttribute('title')).toBe('Nothing for the Storage view in the plan yet');
    expect(s.seg('io').disabled).toBe(false);
  });

  it('pressed state follows hashchange', () => {
    const s = setup();
    s.location.hash = '#io';
    s.h.fireWindowEvent('hashchange');
    expect(s.pressed()).toEqual(['io']);
    s.location.hash = '#storage';
    s.h.fireWindowEvent('hashchange');
    expect(s.pressed()).toEqual(['storage']);
    s.location.hash = '';
    s.h.fireWindowEvent('hashchange');
    expect(s.pressed()).toEqual(['arch']);
  });

  it('plan without screens: the IO segment is disabled and titled; a click does nothing', () => {
    const s = setup({ noNav: true });
    expect(s.seg('io').disabled).toBe(true);
    expect(s.seg('io').getAttribute('title')).toBe('Nothing for the IO view in the plan yet');
    expect(s.seg('arch').disabled).toBe(false);
    s.seg('io').click();
    expect(s.calls).toEqual([]);
  });

  it('openIn "window": a click on another view opens its bare URL; the current view does nothing', () => {
    const s = setup();
    s.seg('arch').click();
    expect(s.calls).toEqual([]);
    s.seg('io').click();
    expect(s.calls).toEqual([[BASE + '#io&bare', 'c4pm-io', 'popup,width=1280,height=800']]);
    s.seg('storage').click();
    expect(s.calls[1]).toEqual([BASE + '#storage&bare', 'c4pm-storage', 'popup,width=1280,height=800']);
  });

  it('io page: a click on arch opens the arch URL', () => {
    const s = setup({ hash: '#io' });
    expect(s.pressed()).toEqual(['io']);
    s.seg('arch').click();
    expect(s.calls).toEqual([[BASE + '#arch&bare', 'c4pm-arch', 'popup,width=1280,height=800']]);
  });

  it('b602: the window hint in the title follows the current view and the openIn setting', () => {
    const s = setup();
    const titles = () => s.box.children.map((b: any) => b.getAttribute('title'));
    s.location.hash = '#io';
    s.h.fireWindowEvent('hashchange');
    expect(titles()).toEqual(['Architecture view (opens in its own window)', 'IO view', 'Storage view (opens in its own window)']);
    s.win.C4PM_SETTINGS.set('openIn', 'here');
    expect(titles()).toEqual(['Architecture view', 'IO view', 'Storage view']);
    s.win.C4PM_SETTINGS.set('openIn', 'window');
    expect(titles()).toEqual(['Architecture view (opens in its own window)', 'IO view', 'Storage view (opens in its own window)']);
  });

  it('setting "here": a click sets the hash and opens nothing', () => {
    const s = setup({ stored: { 'c4mp.settings': JSON.stringify({ openIn: 'here' }) } });
    s.seg('io').click();
    expect(s.location.hash).toBe('#io');
    s.h.fireWindowEvent('hashchange');
    expect(s.pressed()).toEqual(['io']);
    s.seg('storage').click();
    expect(s.location.hash).toBe('#storage');
    s.h.fireWindowEvent('hashchange');
    s.seg('arch').click();
    expect(s.location.hash).toBe('');
    expect(s.calls).toEqual([]);
  });

  it('settings popup has the "Open a view in" row', () => {
    const s = setup();
    expect(s.win.C4PM_SETTINGS.DEF.openIn.def).toBe('window');
    expect(s.win.C4PM_SETTINGS.DEF.openIn.opts).toEqual([['window', 'New window'], ['here', 'This window']]);
    expect(JSON.stringify(s.pop.children, (k, v) => (k === 'parentNode' ? undefined : v))).toContain('Open a view in');
  });
});
