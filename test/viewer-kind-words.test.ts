import { KIND_TABLE, kindsOfView, ViewName } from '../src/plan/kinds';
import { buildKindWords } from '../src/view/kindWords';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// b142: ONE kind table for the viewer, per view (src/view/kindWords.ts), injected as C4PM_DATA.kindWords and read through C4PM_MODE.

describe('buildKindWords', () => {
  const words = buildKindWords();

  it.each(['arch', 'io', 'storage'] as ViewName[])('every element kind of KIND_TABLE in the %s view has a row', view => {
    for (const k of kindsOfView(view)) {
      expect(words[view][k]).toBeDefined();
      expect(words[view][k].tag).toBeTruthy();
      expect(words[view][k].hud).toBeTruthy();
      expect(words[view][k].color).toBeTruthy();
    }
  });

  it('every element kind of KIND_TABLE has a row somewhere', () => {
    for (const k of Object.keys(KIND_TABLE)) expect(words.arch[k] ?? words.io[k] ?? words.storage[k]).toBeDefined();
  });

  it('storage rows: store, record, field', () => {
    expect(Object.keys(words.storage)).toEqual(['store', 'record', 'field']);
    expect(words.storage.store).toMatchObject({ tag: 'STORE', hud: 'Store', legend: 'Store' });
    expect(words.storage.record.hud).toBe('Record');
    expect(words.storage.field.hud).toBe('Field');
  });

  it('b266: io rows of command, options, flag, arg, route, body, param, tool', () => {
    expect(words.io.command).toMatchObject({ tag: 'cmd', region: 'COMMAND', hud: 'Command', legend: 'Command' });
    expect(words.io.options).toMatchObject({ tag: 'opts', region: 'OPTION GROUP', hud: 'Option group' });
    expect(words.io.flag).toMatchObject({ tag: 'flag', region: 'FLAG', hud: 'Flag' });
    expect(words.io.arg).toMatchObject({ tag: 'arg', region: 'ARG', hud: 'Argument' });
    expect(words.io.route).toMatchObject({ tag: 'route', region: 'ROUTE', hud: 'Route', legend: 'Route' });
    expect(words.io.body).toMatchObject({ tag: 'body', region: 'BODY', hud: 'Body' });
    expect(words.io.param).toMatchObject({ tag: 'param', region: 'PARAM', hud: 'Param' });
    expect(words.io.tool).toMatchObject({ tag: 'tool', region: 'TOOL', hud: 'Tool', legend: 'Tool' });
  });

  it('the io view overrides system and container only for the words', () => {
    expect(words.io.system).toMatchObject({ tag: 'all', region: 'ALL APPS', hud: 'All apps' });
    expect(words.io.container).toMatchObject({ tag: 'app', region: 'APP', hud: 'App' });
    expect(words.arch.system).toMatchObject({ tag: 'C1', region: 'C1 SYSTEM', hud: 'C1 · System' });
  });

  it('C1 A1 (b828): the context row is a holder with no region header; no other row is a holder', () => {
    expect(words.arch.context).toEqual({ tag: 'C1', hud: 'C1 · System context', color: 'c1', holder: true });
    const holders = (['arch', 'io', 'storage'] as const).flatMap(v => Object.keys(words[v]).filter(k => words[v][k].holder).map(k => `${v}:${k}`));
    expect(holders).toEqual(['arch:context']);
  });

  it('C1 A2 (b829): each arch element row carries its KIND_TABLE needsCode; io, storage and code rows carry none', () => {
    for (const k of kindsOfView('arch')) expect(words.arch[k].needsCode).toBe(KIND_TABLE[k].needsCode);
    expect(kindsOfView('arch').filter(k => words.arch[k].needsCode === false)).toEqual(['subregion', 'person', 'external']);
    const carriers = (['arch', 'io', 'storage'] as const).flatMap(v => Object.keys(words[v]).filter(k => 'needsCode' in words[v][k]).map(k => `${v}:${k}`));
    expect(carriers).toEqual(kindsOfView('arch').map(k => `arch:${k}`));
  });
});

describe('C4PM_MODE accessors in the page', () => {
  const at = (hash: string) => ({ href: 'file:///x.html' + hash, hash });
  const mode = (hash: string) => (runViewerScripts(renderViewHtml(loadSample()), { globals: { location: at(hash) } }).sandbox.window as any).C4PM_MODE;

  it('the page carries the table; arch words come from it', () => {
    const m = mode('');
    expect(m.tag('component')).toBe('C3');
    expect(m.region('external')).toBe('EXTERNAL');
    expect(m.word('file')).toBe('Files');
    expect(m.color('class')).toBe('cls');
    expect(m.color('unassigned')).toBe('unassigned');
  });

  it('legend: arch swatches in order; io adds its entry kinds (screen, command, route, tool)', () => {
    expect(mode('').legend().map((r: any) => r.label)).toEqual(['System', 'Container', 'Subregion', 'Component', 'Person', 'External', 'File', 'Function', 'Class']);
    expect(mode('#io').legend().map((r: any) => r.label)).toEqual(['System', 'Container', 'Subregion', 'Component', 'Person', 'External', 'File', 'Function', 'Class', 'Screen', 'Command', 'Route', 'Tool']);
  });

  it('a kind with no row returns undefined (callers fall back); a kind of another view is found', () => {
    const m = mode('');
    expect(m.tag('no-such-kind')).toBeUndefined();
    expect(m.color('no-such-kind')).toBeUndefined();
    expect(m.tag('screen')).toBe('screen');   // io row, found from the arch view
    expect(m.word('record', 'storage')).toBe('Record');
  });

  it('C1 A1 (b828): isHolder is true for the context only (from its row); a kind with no row is no holder', () => {
    const m = mode('');
    expect(m.isHolder('context')).toBe(true);
    expect(['system', 'container', 'person', 'external', 'screen', 'no-such-kind'].map(k => m.isHolder(k))).toEqual([false, false, false, false, false, false]);
  });

  it('C1 A2 (b829): needsCode is false for person, external and subregion (their rows); true for code kinds, other views and no row', () => {
    const m = mode('');
    expect(['person', 'external', 'subregion'].map(k => m.needsCode(k))).toEqual([false, false, false]);
    expect(['system', 'container', 'component', 'function', 'screen', 'store', 'no-such-kind'].map(k => m.needsCode(k))).toEqual([true, true, true, true, true, true, true]);
    expect(mode('#storage').needsCode('person')).toBe(false);   // found in the arch rows from another view
  });

  it('a page without kindWords answers undefined instead of throwing', () => {
    const html = renderViewHtml(loadSample()).replace(/"kindWords":\{.*?\}\}\}/, '"kindWordsGone":0');
    const w = runViewerScripts(html, { globals: { location: at('') } }).sandbox.window as any;
    expect(w.C4PM_MODE.tag('system')).toBeUndefined();
    expect(w.C4PM_MODE.legend()).toEqual([]);
  });
});
