import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { CHROME, runChrome } from './helpers/chrome';

// P14-T30: "file-only (no parser)" labels in the Files tree row, the file panel and the component panel.
// Real headless Chrome (skipped when missing), same harness shape as viewer-tree.test.ts.

const chromeIt = fs.existsSync(CHROME) ? it : it.skip;

const FILE_ONLY_NOTE = 'File-only: functions and imports are not read for this language (no parser yet).';
const TREE_LABEL = 'file-only (no parser)';
const COMPONENT_LINE = '2 of 3 files are file-only (no parser)';

let withFileOnly: string;
let withoutFileOnly: string;

function makeRepo(prefix: string, javaFiles: boolean): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fileonly-demo' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  if (javaFiles) {
    fs.writeFileSync(path.join(tmp, 'src', 'Main.java'), 'class Main {}\n');
    fs.writeFileSync(path.join(tmp, 'src', 'Util.java'), 'class Util {}\n');
  }
  return tmp;
}

let tmpWith: string;
let tmpWithout: string;

beforeAll(() => {
  tmpWith = makeRepo('c4pm-fileonly-', true);
  tmpWithout = makeRepo('c4pm-fileonly-none-', false);
  withFileOnly = buildView({ repo: tmpWith, config: { languages: ['typescript', 'files'] } }).html;
  withoutFileOnly = buildView({ repo: tmpWithout }).html;
});

afterAll(() => {
  fs.rmSync(tmpWith, { recursive: true, force: true });
  fs.rmSync(tmpWithout, { recursive: true, force: true });
});

// Runs after load: reads the Files rows, opens each file in the panel, selects the component
// that holds the file-only files, and writes the measurements as JSON into <pre id="__m">.
const DRIVE = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)}, qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var M=window.C4PM_MAP, o={};
  var panelText=function(){return q('#panel').textContent};
  var rowText=function(p){var r=q('#lt-files .lt-row[data-path="'+p+'"]'); return r ? r.textContent : null};
  o.javaRow=rowText('src/Main.java');
  o.tsRow=rowText('src/index.ts');
  o.flagSpans=qa('#lt-files .lt-flag-fileonly').length;
  // file panel: file-only file shows the note, a parsed file does not
  var mainRow=q('#lt-files .lt-row[data-path="src/Main.java"]'); if(mainRow) mainRow.click();
  o.javaPanelNote=panelText().indexOf(${JSON.stringify(FILE_ONLY_NOTE)})>=0;
  var tsRow=q('#lt-files .lt-row[data-path="src/index.ts"]'); if(tsRow) tsRow.click();
  o.tsPanelNote=panelText().indexOf(${JSON.stringify(FILE_ONLY_NOTE)})>=0;
  // component panel: the component whose direct children include a file-only file
  var comp=null;
  (function walk(n){ if(!comp && n.kind==='component' && (n.children||[]).some(function(c){return c.fileOnly})) comp=n; (n.children||[]).forEach(walk); })(window.C4PM_DATA.root);
  o.compFound=!!comp;
  if(comp){
    M.ancestorsOf(comp.id).forEach(function(a){var r=q('.lt-row[data-id="'+a+'"]'); if(r && r.getAttribute('aria-expanded')==='false') r.querySelector('.lt-twist').click();});
    var row=q('.lt-row[data-id="'+comp.id+'"]');
    o.compRowFound=!!row;
    if(row) row.click();
  }
  o.compLine=panelText().indexOf(${JSON.stringify(COMPONENT_LINE)})>=0;
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

// Same page, scripts removed: the visible text a repo without file-only data must not gain.
const DRIVE_NONE = `(function(){setTimeout(function(){
  var q=function(s){return document.querySelector(s)}, qa=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
  var M=window.C4PM_MAP, o={};
  var comp=null;
  (function walk(n){ if(!comp && n.kind==='component') comp=n; (n.children||[]).forEach(walk); })(window.C4PM_DATA.root);
  if(comp){
    M.ancestorsOf(comp.id).forEach(function(a){var r=q('.lt-row[data-id="'+a+'"]'); if(r && r.getAttribute('aria-expanded')==='false') r.querySelector('.lt-twist').click();});
    var row=q('.lt-row[data-id="'+comp.id+'"]'); if(row) row.click();
  }
  var c=document.body.cloneNode(true);
  Array.prototype.slice.call(c.querySelectorAll('script')).forEach(function(s){s.remove()});
  var text=c.textContent;
  o.labelHits=text.split(${JSON.stringify(TREE_LABEL)}).length-1;
  o.noteHits=text.split(${JSON.stringify(FILE_ONLY_NOTE)}).length-1;
  o.countHits=text.indexOf('files are file-only')>=0 ? 1 : 0;
  var p=document.createElement('pre');p.id='__m';p.textContent=JSON.stringify(o);document.body.appendChild(p);
},400)})();`;

function run(page: string, dir: string): Record<string, any> {
  const file = path.join(dir, 'fileonly-page.html');
  fs.writeFileSync(file, page);
  const dom = runChrome(['--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=3000', '--window-size=1400,900', `file://${file}`]);
  const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
  if (!m) throw new Error('measurement element not found in dumped DOM');
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe('P14-T30 file-only labels', () => {
  chromeIt('real browser: tree row, file panel and component panel show the file-only label when fileOnly data exists', () => {
    const m = run(withFileOnly.replace('</body>', `<script>${DRIVE}</script></body>`), tmpWith);
    expect(m.javaRow).toContain(TREE_LABEL);
    expect(m.tsRow).not.toContain(TREE_LABEL);
    expect(m.flagSpans).toBe(2);
    expect(m.javaPanelNote).toBe(true);
    expect(m.tsPanelNote).toBe(false);
    expect(m.compFound).toBe(true);
    expect(m.compLine).toBe(true);
  });

  chromeIt('real browser: a repo without file-only data renders none of the new text', () => {
    const m = run(withoutFileOnly.replace('</body>', `<script>${DRIVE_NONE}</script></body>`), tmpWithout);
    expect(m.labelHits).toBe(0);
    expect(m.noteHits).toBe(0);
    expect(m.countHits).toBe(0);
  });
});
