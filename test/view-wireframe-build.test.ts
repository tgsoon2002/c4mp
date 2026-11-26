import * as fs from 'fs';
import * as path from 'path';
import { renderViewHtml, viewerDir } from '../src/page/html';
import { wireframeRules, WIREFRAME_CSS } from '../src/c4/wireframeHtml';
import { loadSample } from './helpers/nav-view';
import { runViewerScripts } from './helpers/viewer-harness';

// W10 (b306): every built page carries C4PM_DATA.wireframeRules (the server's one rule table, C2) and loads
// viewer/ioWireframe.js before the screens module, so the IO view can measure wireframes (C6, C7).

const DATA_SCRIPT = /window\.C4PM_DATA = ([^\n]*);(?:<\/script>)?\n/;   // JSON.stringify output has no raw newline

describe('renderViewHtml wires the wireframe measurer', () => {
  let html: string;
  beforeAll(() => { html = renderViewHtml(loadSample()); });

  it('C4PM_DATA.wireframeRules is the server rule table', () => {
    const data = JSON.parse(html.match(DATA_SCRIPT)![1]);
    expect(data.wireframeRules).toEqual(wireframeRules());
    expect(data.wireframeRules.css).toEqual([...WIREFRAME_CSS]);
  });

  it('ioWireframe.js comes before ioScreens.js in the scripts block', () => {
    const read = (f: string) => fs.readFileSync(path.join(viewerDir(), f), 'utf8');
    const scriptsAt = html.lastIndexOf('<script>');
    const wire = html.indexOf(read('ioWireframe.js'), scriptsAt);
    const screens = html.indexOf(read('ioScreens.js'), scriptsAt);
    expect(wire).toBeGreaterThan(scriptsAt);
    expect(screens).toBeGreaterThan(wire);
  });

  it('the page defines C4PM_IO_WIREFRAME; without a layout engine measureAll answers { ok: false, reason }, no throw', () => {
    const { sandbox } = runViewerScripts(html);
    const api = (sandbox as any).C4PM_IO_WIREFRAME;
    expect(typeof api.measureAll).toBe('function');
    const rules = (sandbox as any).C4PM_DATA.wireframeRules;
    const out = api.measureAll([{ fqn: 's1', html: '<div data-c4="a"></div>', viewport: { w: 100, h: 100 } }], rules);
    expect(Object.keys(out)).toEqual(['s1']);
    expect(out.s1.ok).toBe(false);
    expect(out.s1.reason).toMatch(/no layout engine/);
  });
});
