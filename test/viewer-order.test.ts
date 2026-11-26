import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView, PANEL_SCRIPTS, PRELUDE_SCRIPTS, SHELL_SCRIPTS, VIEWER_SCRIPTS } from '../src/page/html';

// P14-G1: pins the concatenation order of the viewer scripts and the 2-script-tag rule.

let tmp: string;
let html: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-order-')));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'order-demo' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
  html = buildView({ repo: tmp }).html;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('P14-G1 viewer script order', () => {
  it('state, camera, render, controls, map API, tree come in that order', () => {
    const at = (s: string) => {
      const i = html.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = ['window.C4PM_STATE = {', '// camera.js:', '// render.js:', '// controls.js:', 'window.C4PM_MAP = {', 'window.C4PM_TREE'].map(at);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  // P16-B18: enable when B22 fills board.js (it then defines window.C4PM_BOARD).
  it.todo('window.C4PM_BOARD = comes after window.C4PM_TREE');

  it('the page has exactly two script tags', () => {
    expect((html.match(/<script>/g) ?? []).length).toBe(2);
  });

  // P20-T11 (b232): every script reads window.C4PM_SETTINGS, so the settings module is the first one.
  it('settings.js comes first', () => {
    const s = html.indexOf('window.C4PM_SETTINGS = {');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(html.indexOf('window.C4PM_EDIT = api'));
    expect(s).toBeLessThan(html.indexOf('// camera.js:'));
  });

  // LAY-12a (b377): state.js creates C4PM_STATE after settings and mode, before every reader.
  it('settings.js, mode.js, state.js come in that order', () => {
    const order = ['window.C4PM_SETTINGS = {', 'window.C4PM_MODE = api', 'window.C4PM_STATE = {'].map(s => html.indexOf(s));
    order.forEach(i => expect(i).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  // LAY-12a (b377): a viewer file that is not listed would silently never load; a listed file that is missing would throw at build.
  it('every viewer/*.js is in VIEWER_SCRIPTS or SHELL_SCRIPTS (c4pm serve shell only, SV4 b791), and in one list only', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'viewer')).filter(f => f.endsWith('.js')).sort();
    // Phase 35 C (b945): PRELUDE_SCRIPTS (store.js, brand.js) are the third list: at the start of the script block of every page
    expect([...PRELUDE_SCRIPTS, ...VIEWER_SCRIPTS, ...SHELL_SCRIPTS].sort()).toEqual(files);
    expect(SHELL_SCRIPTS.filter(f => VIEWER_SCRIPTS.includes(f))).toEqual([]);
    expect(PRELUDE_SCRIPTS.filter(f => VIEWER_SCRIPTS.includes(f) || SHELL_SCRIPTS.includes(f))).toEqual([]);
  });

  // P20-T5-0 (b254): settings < mode < map < openView < link < panel < tree.
  it('mode.js, openView.js and link.js sit between settings.js, map.js and panel.js', () => {
    const at = (s: string) => {
      const i = html.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = ['window.C4PM_SETTINGS = {', 'window.C4PM_MODE = api', 'window.C4PM_MAP = {', 'window.C4PM_OPEN = function', 'window.C4PM_LINK = {', '/* panel.js: Detail panel', 'window.C4PM_TREE'].map(at);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  // LAY-12c (b389): the panel parts load after link.js in PANEL_SCRIPTS order (each reads only the parts before it), panel.js last, then tree.js.
  it('the panel parts come in PANEL_SCRIPTS order between link.js and tree.js', () => {
    const marker = (f: string) => (f === 'panel.js' ? '\n/* panel.js: Detail panel' : '\n// ' + f + ': ');
    const order = ['window.C4PM_LINK = {', ...PANEL_SCRIPTS.map(marker), 'window.C4PM_TREE'].map(s => html.indexOf(s));
    order.forEach(i => expect(i).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it('edit.js comes before the map group', () => {
    const e = html.indexOf('window.C4PM_EDIT = api');
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThan(html.indexOf('// camera.js:'));
  });
});
