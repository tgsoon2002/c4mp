import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { ViewModel } from '../src/types';

// P20-T5-F (b260): the top bar follows the view (title, count chips, edit-layout buttons).

const EDIT_BTNS = ['btn-edit', 'btn-reset', 'btn-arrange', 'btn-undo', 'btn-redo', 'btn-export'];

function load(model: ViewModel, loc: { href: string; hash: string }): HarnessResult {
  return runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop'], globals: { location: loc } });
}
const at = (hash: string) => ({ href: 'file:///x.html' + hash, hash });
const win = (h: HarnessResult) => h.sandbox.window as any;
const el = (h: HarnessResult, id: string) => (h.sandbox.document as any).getElementById(id);
const hidden = (h: HarnessResult) => EDIT_BTNS.map(id => !!el(h, id).hidden);

describe('top bar per view', () => {
  it('a page opened at #io paints the io title and chips on the first fill, edit buttons hidden', () => {
    const h = load(loadSample(), at('#io'));
    expect(el(h, 'title').textContent).toBe('IO view');
    expect(el(h, 'bar-chips').textContent).toBe('2 apps · 4 screens · 4 links');
    expect(hidden(h)).toEqual([true, true, true, true, true, true]);
  });

  it('HUD level label: io shows ioView.hud (focused entry word, else the entry kind words); words from the kind table; arch keeps C1 words (b263)', () => {
    const io = load(loadSample(), at('#io'));
    const hud = (h: HarnessResult) => el(h, 'hud-level').textContent;
    win(io).C4PM_MAP.flyTo('shop.web');
    io.frames.runToCompletion();
    expect(hud(io)).toBe(win(io).C4PM_IOVIEW.hud());
    expect(hud(io)).toBe('Screen');   // the sample has screens only
    expect(win(io).C4PM_MODE.word('container')).toBe('App');
    expect(win(io).C4PM_MODE.word('screen')).toBe('Screen');
    expect(win(io).C4PM_MODE.word('system')).toBe('All apps');
    const arch = load(loadSample(), at(''));
    expect(win(arch).C4PM_MODE.word('container')).toBe('C2 · Containers');   // b142: arch words are rows of the same table
  });

  it('HUD with a screen and a command entry and nothing focused: the kind words joined, screen first', () => {
    const m = loadSample();
    ((m.nav!.groups[0] as any).entries as any[])[0].kind = 'command';
    const h = load(m, at('#io'));
    expect(win(h).C4PM_IOVIEW.hud()).toBe('Screen · Command');
  });

  it('switch to arch restores title, chips and buttons; back to io hides them again', () => {
    const m = loadSample();
    const arch = load(m, at(''));
    const archTitle = el(arch, 'title').textContent, archChips = el(arch, 'bar-chips').textContent;
    expect(archTitle).not.toBe('IO view');
    expect(hidden(arch)).toEqual([false, true, true, true, true, true]);
    const loc = at('#io');
    const h = load(m, loc);
    loc.hash = '';
    h.fireWindowEvent('hashchange');
    expect(el(h, 'title').textContent).toBe(archTitle);
    expect(el(h, 'bar-chips').textContent).toBe(archChips);
    expect(hidden(h)).toEqual([false, true, true, true, true, true]);
    win(h).C4PM_MAP.setEdit(true);
    expect(hidden(h)).toEqual([false, false, false, false, false, false]);
    win(h).C4PM_MAP.setEdit(false);
    expect(hidden(h)).toEqual([false, true, true, true, true, true]);
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    expect(el(h, 'title').textContent).toBe('IO view');
  });

  it('edit mode on, then switch to io: edit turns off and the buttons are hidden', () => {
    const loc = at('');
    const h = load(loadSample(), loc);
    win(h).C4PM_MAP.setEdit(true);
    expect(win(h).C4PM_STATE.map.edit).toBe(true);
    loc.hash = '#io';
    h.fireWindowEvent('hashchange');
    expect(win(h).C4PM_STATE.map.edit).toBe(false);
    expect(el(h, 'btn-edit').getAttribute('aria-pressed')).toBe('false');
    expect(hidden(h)).toEqual([true, true, true, true, true, true]);
    win(h).C4PM_MAP.setEdit(true);   // even a programmatic edit keeps the io buttons hidden
    expect(hidden(h)).toEqual([true, true, true, true, true, true]);
  });

  it('chips use singular for 1 and plural otherwise', () => {
    const m = loadSample();
    m.nav!.groups = [m.nav!.groups[0]];
    const g: any = m.nav!.groups[0];
    g.entries = g.entries.slice(0, 1);
    m.nav!.edges = m.nav!.edges.slice(0, 1);
    expect(el(load(m, at('#io')), 'bar-chips').textContent).toBe('1 app · 1 screen · 1 link');
    m.nav!.edges = [];
    expect(el(load(m, at('#io')), 'bar-chips').textContent).toBe('1 app · 1 screen · 0 links');
  });
});

describe('Esc clears the selection in the IO view only', () => {
  it('#io: Esc clears the selection and the panel returns to the summary; Esc typing in an input does not', () => {
    const h = load(loadSample(), at('#io'));
    const w = win(h), doc = h.sandbox.document as any;
    w.C4PM_MAP.select('shop.web.home');
    doc.dispatch('keydown', { key: 'Escape', target: { tagName: 'INPUT' } });
    expect(w.C4PM_STATE.map.selectedId).toBe('shop.web.home');
    doc.dispatch('keydown', { key: 'Escape', target: { tagName: 'DIV' } });
    expect(w.C4PM_STATE.map.selectedId).toBeNull();
    expect(serializeText(h.panel)).toContain('IO view: 2 groups');
  });

  it('arch view: Esc leaves a selected c-item alone (board rule P16-B22)', () => {
    const h = load(loadSample(), at(''));
    const w = win(h), doc = h.sandbox.document as any;
    const id = w.C4PM_DATA.root.children[0].id;
    w.C4PM_MAP.select(id);
    doc.dispatch('keydown', { key: 'Escape', target: { tagName: 'DIV' } });
    expect(w.C4PM_STATE.map.selectedId).toBe(id);
  });
});
