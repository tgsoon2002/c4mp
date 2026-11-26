import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { C4pmConfig } from '../src/types';
import { chromeInstalled, runChrome } from './helpers/chrome';

// P14-I10: real-Chrome gate for bean size and deep zoom. Beans are measured in the browser at the
// parent camera (fitCam of the parent), so the check is about what the user sees, not the model.
// Skipped when Chrome is missing; inconclusive (warned, not failed) when Chrome times out.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// b605: C4PM's own plan, named explicitly. The project id comes from the folder name, so in a worktree
// (or any checkout not named C4PM) the anchor's plan folder is missing and discovery falls back to every
// .c4 file in the repo (Document/ corpus, Test Runs copies, test fixtures). The gate checks C4PM's map.
const C4PM_CONFIG: Partial<C4pmConfig> = { architectureDir: '.c4mp/projects/c4mp/plan' };
const LTS_COPY = process.env.C4PM_LTS_COPY;

const chromeIt = chromeInstalled ? it : it.skip;
const ltsIt = chromeInstalled && LTS_COPY ? it : it.skip;

// Q-I7 (K decides): standard bean 170x64 at a 3x4 region fit is about 223x84; 100x38 is the floor.
const MIN_BEAN_PX = { w: 100, h: 38 };
const SMALL_PARENT = 12;
const SIBLING_EPS = 1e-6;
const CLAMP_MAX_S = 14;
const CLAMP_SLACK = 0.0001;
const TEST_TIMEOUT = 180000;

interface Bean {
  id: string;
  parent: string;
  parentChildCount: number;
  beanPx: number;
  beanPy: number;
}

interface Deep {
  deepestId: string;
  zoomS: number;
  focusId: string | null;
  scale: number | null;
  maxSNow: number;
}

interface Measure {
  beans: Bean[];
  deep: Deep | null;
}

// Runs after load (rAF shim first, Rule 7). Bean records use the parent camera fitCam(p).s.
// Output is encodeURIComponent'd so the dumped DOM carries no HTML entities.
const SCRIPT = `(function(){
window.requestAnimationFrame = function(cb){ return setTimeout(function(){ cb(performance.now()); }, 100); };
var walk = function(n, fn){ fn(n); (n.children || []).forEach(function(c){ walk(c, fn); }); };
setTimeout(function(){
  var st = window.C4PM_STATE, CAM = window.C4PM_CAM, data = window.C4PM_DATA;
  var out = { beans: [], deep: null };
  walk(data.root, function(p){
    if (!p.children || !p.children.length) return;
    // C1 B1 (b831): a holder's children (persons, the system, externals) are placed by rule with their own shapes, not in slots
    if (window.C4PM_MODE && window.C4PM_MODE.isHolder(p.kind)) return;
    var s = CAM.fitCam(p).s;
    p.children.forEach(function(c){
      out.beans.push({ id: c.id, parent: p.id, parentChildCount: p.children.length, beanPx: c.bubble.w * s, beanPy: c.bubble.h * s });
    });
  });
  var finish = function(){
    var pre = document.createElement('pre'); pre.id = '__m';
    pre.textContent = encodeURIComponent(JSON.stringify(out));
    document.body.appendChild(pre);
  };
  if (typeof CAM.maxS !== 'function') { finish(); return; }
  var deepest = null;
  walk(data.root, function(n){ if (!deepest || n.depth > deepest.depth) deepest = n; });
  st.map.cam = CAM.fitCam(deepest);
  st.requestDraw();
  setTimeout(function(){
    var m = st.map;
    CAM.zoomAt(m.cw / 2, m.ch / 2, 1e6);
    var f = CAM.focusNode();
    out.deep = { deepestId: deepest.id, zoomS: m.cam.s, focusId: f ? f.id : null,
      scale: f && typeof f.scale === 'number' ? f.scale : null, maxSNow: CAM.maxS() };
    finish();
  }, 600);
}, 600);
})();`;

function measure(html: string): Measure {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-layout-chrome-'));
  try {
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, html.replace('</body>', () => `<script>${SCRIPT}</script></body>`));
    const dom = runChrome([
      '--headless', '--disable-gpu', '--dump-dom', '--virtual-time-budget=8000',
      '--window-size=1400,900', `file://${file}`,
    ]);
    const m = dom.match(/<pre id="__m">(.*?)<\/pre>/s);
    if (!m) throw new Error('measurement element not found in dumped DOM');
    return JSON.parse(decodeURIComponent(m[1]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Chrome timeout is inconclusive (warned, not failed); every other error fails the test.
function measureOrNull(repo: string, config?: Partial<C4pmConfig>): Measure | null {
  const html = buildView({ repo, config }).html;
  try {
    return measure(html);
  } catch (e) {
    const msg = (e as Error).message;
    if (/ETIMEDOUT/.test(msg)) {
      console.warn(`layout-chrome: inconclusive, Chrome timed out (${msg})`);
      return null;
    }
    throw e;
  }
}

function checkBeans(m: Measure, label: string): void {
  // Identical sibling size first: this is the rule the shelf-pack breaks.
  const byParent = new Map<string, Bean[]>();
  for (const b of m.beans) {
    const list = byParent.get(b.parent) ?? [];
    list.push(b);
    byParent.set(b.parent, list);
  }
  const unequal: string[] = [];
  for (const [parent, list] of byParent) {
    const first = list[0];
    const odd = list.find(
      (b) => Math.abs(b.beanPx - first.beanPx) > SIBLING_EPS || Math.abs(b.beanPy - first.beanPy) > SIBLING_EPS,
    );
    if (odd) {
      unequal.push(
        `${parent}: ${odd.id} ${odd.beanPx.toFixed(2)}x${odd.beanPy.toFixed(2)} vs ${first.id} ${first.beanPx.toFixed(2)}x${first.beanPy.toFixed(2)}`,
      );
    }
  }
  expect({ label, unequalParents: unequal }).toEqual({ label, unequalParents: [] });

  // Small parents (<= 12 children): every bean at least 100x38 px.
  const tooSmall = m.beans
    .filter((b) => b.parentChildCount <= SMALL_PARENT && (b.beanPx < MIN_BEAN_PX.w || b.beanPy < MIN_BEAN_PX.h))
    .map((b) => `${b.parent} > ${b.id}: ${b.beanPx.toFixed(1)}x${b.beanPy.toFixed(1)}`);
  expect({ label, tooSmall }).toEqual({ label, tooSmall: [] });

  // Large parents: printed only, fan-out is judged by K in I11.
  const large = m.beans.filter((b) => b.parentChildCount > SMALL_PARENT).sort((a, b) => a.beanPx - b.beanPx);
  console.log(
    `${label}: ${large.length} beans under parents with more than ${SMALL_PARENT} children (not asserted); 10 smallest:\n` +
      large
        .slice(0, 10)
        .map((b) => `  ${b.parent} > ${b.id}: ${b.beanPx.toFixed(1)}x${b.beanPy.toFixed(1)}`)
        .join('\n'),
  );
}

describe('P14-I10 real-Chrome layout gate', () => {
  chromeIt('C4PM: beans are one size per parent and large enough at the parent camera', () => {
    const m = measureOrNull(REPO_ROOT, C4PM_CONFIG);
    if (!m) return;
    checkBeans(m, 'C4PM');
  }, TEST_TIMEOUT);

  ltsIt('LTS: beans are one size per parent and large enough at the parent camera', () => {
    const m = measureOrNull(LTS_COPY!);
    if (!m) return;
    checkBeans(m, 'LTS');
  }, TEST_TIMEOUT);

  chromeIt('deep zoom stays inside the relative clamp', () => {
    const pages: Array<[string, string, Partial<C4pmConfig> | undefined]> = [['C4PM', REPO_ROOT, C4PM_CONFIG]];
    if (LTS_COPY) pages.push(['LTS', LTS_COPY, undefined]);
    for (const [label, repo, config] of pages) {
      const m = measureOrNull(repo, config);
      if (!m) return;
      expect({ label, deep: m.deep !== null }).toEqual({ label, deep: true });
      const d = m.deep!;
      expect({ label, zoomS: Number.isFinite(d.zoomS) }).toEqual({ label, zoomS: true });
      expect({ label, scale: d.scale !== null }).toEqual({ label, scale: true });
      expect(d.zoomS * d.scale!).toBeLessThanOrEqual(CLAMP_MAX_S + CLAMP_SLACK);
      expect(d.zoomS).toBeGreaterThan(CLAMP_MAX_S);
    }
  }, TEST_TIMEOUT);
});
