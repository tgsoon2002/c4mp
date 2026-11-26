import { renderViewHtml } from '../src/page/html';
import { buildNavView } from '../src/view/navLayout';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { NavEntry, NavModel, NavPart } from '../src/types';

// IO view: a part (region, control, flag, state, ...) is a node of the tree: selection, panel, tree and search work on it.

const part = (fqn: string, kind: string, parts: NavPart[] = [], meta?: Record<string, string>): NavPart => ({ fqn, uid: null, kind, title: fqn.split('.').pop()!, status: null, parts, ...(meta ? { meta } : {}) });
const entry = (kind: string, fqn: string, rank: number, parts: NavPart[], parent: string | null = null): NavEntry => ({ kind, fqn, uid: null, title: fqn.split('.').pop()!, status: null, rank, order: 0, parent, parts });

const NAV: NavModel = {
  groups: [
    { fqn: 'w', title: 'Web', technology: 'React', word: 'App', entries: [
      entry('screen', 'w.home', 0, [part('w.home.hero', 'region', [part('w.home.hero.go', 'control', [part('w.home.hero.go.busy', 'state')])]), part('w.home.err', 'state')]),
      entry('screen', 'w.cart', 1, [part('w.cart.list', 'region', [part('w.cart.list.row', 'control')])]),
    ] },
    { fqn: 'c', title: 'CLI', technology: 'commander', word: 'CLI', entries: [
      entry('command', 'c.run', 0, [part('c.run.opts', 'options', [part('c.run.opts.file', 'flag', [], { type: 'path', required: 'true' })])]),
      entry('command', 'c.run.sub', 0, [part('c.run.sub.name', 'arg')], 'c.run'),
    ] },
  ],
  edges: [{ from: 'w.home', to: 'w.cart', label: 'Go on', labelled: true, via: 'w.home.hero.go' }],
  calls: [],
};

function load(): HarnessResult {
  const m = loadSample();
  m.nav = NAV;
  m.navView = buildNavView(NAV);
  return runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: { href: 'file:///x.html#io', hash: '#io' } } });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const sectionText = (h: HarnessResult, title: string) => {
  const s = h.panel.querySelectorAll('.pn-section').find(x => serializeText(x).startsWith(title));
  return s ? serializeText(s) : null;
};

describe('IO part nodes', () => {
  it('every part is a node under its entry or parent part; a subcommand is a child of its command', () => {
    const w = win(load());
    const by = (id: string) => w.C4PM_MAP.nodeById(id);
    expect(by('w.home.hero').parent.id).toBe('w.home');
    expect(by('w.home.hero.go').parent.id).toBe('w.home.hero');
    expect(by('w.home.hero.go.busy').kind).toBe('state');
    expect(by('c.run.opts.file').parent.id).toBe('c.run.opts');
    expect(by('c.run.sub').parent.id).toBe('c.run');
    expect(w.C4PM_DATA.navView.root.children[1].children.map((c: any) => c.id)).toEqual(['c.run']);   // the subcommand is not under the app
    expect(by('c.run.opts.file').meta).toMatchObject({ type: 'path', required: 'true' });
  });

  it('the layout writes rects into the part nodes', () => {
    const w = win(load());
    ['w.home.hero', 'w.home.hero.go', 'c.run.opts.file'].forEach(id => { const n = w.C4PM_MAP.nodeById(id); expect(n.w).toBeGreaterThan(0); expect(n.h).toBeGreaterThan(0); });
  });

  it('a click on a row selects the row node (not its box); a click on a box selects the box', () => {
    const h = load(), w = win(h), map = w.C4PM_STATE.map;
    const clickAt = (id: string, then: string) => {
      const n = w.C4PM_MAP.nodeById(id);
      map.cam = w.C4PM_CAM.fitCam(n, 0.6);
      w.C4PM_STATE.requestDraw(); h.frames.runToCompletion();
      const x = (n.x + n.w / 2) * map.cam.s + map.cam.tx, y = (n.y + n.h / 2) * map.cam.s + map.cam.ty;
      expect(w.C4PM_CAM.hitTest(x, y).id).toBe(then);
    };
    clickAt('c.run.opts.file', 'c.run.opts.file');
    clickAt('w.home.hero.go', 'w.home.hero.go');
  });

  it('panel of a control: crumbs, id, Goes to, States; of a flag: type and required', () => {
    const h = load(), w = win(h);
    w.C4PM_MAP.select('w.home.hero.go');
    const t = serializeText(h.panel);
    expect(h.panel.querySelectorAll('.pn-crumb').map(b => b.textContent)).toEqual(['IO view', 'Web', 'home', 'hero', 'go']);
    expect(t).toContain('id w.home.hero.go');
    expect(sectionText(h, 'Goes to')).toContain('cart · Go on');
    expect(sectionText(h, 'States')).toContain('busy');
    w.C4PM_MAP.select('c.run.opts.file');
    expect(serializeText(h.panel)).toContain('type path');
    expect(serializeText(h.panel)).toContain('required');
  });

  it('panel of a screen: region / control counts, States, Inside; of a command: its parts and subcommands', () => {
    const h = load(), w = win(h);
    w.C4PM_MAP.select('w.home');
    expect(serializeText(h.panel)).toContain('1 region');
    expect(serializeText(h.panel)).toContain('1 control');
    expect(sectionText(h, 'States')).toContain('err');
    expect(sectionText(h, 'Inside')).toContain('hero');
    w.C4PM_MAP.select('c.run');
    expect(sectionText(h, 'Inside')).toContain('opts');
    expect(sectionText(h, 'Inside')).toContain('sub');
    expect(serializeText(h.panel)).not.toContain('Parts');
  });

  it('the summary counts the subcommand as a command', () => {
    const h = load();
    expect(serializeText(h.panel)).toContain('2 commands');
  });

  it('tree: apps open at load, a flag is listed under its command once the rows open, the subcommand under its command', () => {
    const h = load(), w = win(h);
    const ids = () => (w.document.getElementById('left').querySelectorAll('.lt-row') as any[]).map(r => r.dataset.id).filter(Boolean);
    expect(ids()).toEqual(expect.arrayContaining(['w', 'w.home', 'w.cart', 'c', 'c.run']));
    expect(ids()).not.toContain('c.run.opts.file');
    w.C4PM_MAP.select('c.run.opts.file');   // reveal opens the ancestors
    expect(ids()).toEqual(expect.arrayContaining(['c.run.opts', 'c.run.opts.file', 'c.run.sub']));
  });

  it('search finds a part by name with its path, and a pick closes the popup', () => {
    const h = load(), w = win(h);
    h.search.value = 'file';
    h.search.dispatch('input', { target: h.search });
    h.flushTimers();
    const rows = h.searchResults.querySelectorAll('.pn-search-result');
    expect(rows.length).toBe(1);
    expect(serializeText(rows[0])).toContain('CLI › run › opts');
    rows[0].click();
    expect(w.C4PM_STATE.map.selectedId).toBe('c.run.opts.file');
    expect(h.search.value).toBe('');
  });
});
