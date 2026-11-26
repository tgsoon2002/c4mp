import path from 'path';
import vm from 'vm';
import { buildView } from '../src/page/html';

// Copy of the fake DOM / canvas harness from test/viewer-smoke.test.ts (P14-I6). Kept as a copy on
// purpose: viewer-smoke.test.ts is not edited by this task. Only the parts the camera test needs
// are kept (no drawing log assertions).

const KNOWN_IDS = [
  'root', 'header', 'title', 'subtitle', 'summary', 'drift-summary', 'main',
  'map-wrap', 'map', 'hud-tl', 'hud-level', 'hud-sub', 'hud-tr',
  'btn-up', 'btn-fit', 'btn-auto', 'btn-edit', 'btn-reset', 'btn-arrange', 'btn-undo', 'btn-redo', 'btn-export', 'btn-in', 'btn-out', 'hud-bl', 'legend',
  'left', 'panel-col', 'search', 'search-results', 'panel',
];

interface FakeEl {
  tagName: string;
  id: string;
  children: FakeEl[];
  parentNode: FakeEl | null;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  _classes: Set<string>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean; toggle(c: string, f?: boolean): void };
  _text: string;
  _html: string;
  textContent: string;
  innerHTML: string;
  className: string;
  value: string;
  href?: string;
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  dispatch(type: string, e?: unknown): void;
  click(): void;
  focus(): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number };
  setPointerCapture(): void;
  releasePointerCapture(): void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  getContext?(kind: string): unknown;
}

interface OpCall { op: 'fill' | 'stroke'; style: string; lineWidth: number; alpha: number }
interface PathCall { op: 'moveTo' | 'lineTo'; x: number; y: number }

function matchesSelector(el: FakeEl, sel: string): boolean {
  if (sel.startsWith('.')) return el._classes.has(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function queryAll(root: FakeEl, sel: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => {
    for (const c of n.children) {
      if (matchesSelector(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function makeElement(tag: string, fillTextLog: string[], strokeLog?: string[], pathLog?: PathCall[], opLog?: OpCall[]): FakeEl {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attrs: {},
    _classes: new Set<string>(),
    get classList() {
      return {
        add: (...c: string[]) => c.forEach(x => el._classes.add(x)),
        remove: (...c: string[]) => c.forEach(x => el._classes.delete(x)),
        contains: (c: string) => el._classes.has(c),
        toggle: (c: string, f?: boolean) => {
          const has = el._classes.has(c);
          const want = f === undefined ? !has : f;
          if (want) el._classes.add(c); else el._classes.delete(c);
        },
      };
    },
    _text: '',
    _html: '',
    get textContent() { return el._text; },
    set textContent(v: string) { el._text = String(v); el.children = []; el._html = ''; },
    get innerHTML() { return el._html; },
    set innerHTML(v: string) { el._html = String(v); el.children = []; },
    get className() { return [...el._classes].join(' '); },
    set className(v: string) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    value: '',
    clientWidth: 1200,
    clientHeight: 800,
    width: 1200,
    height: 800,
    appendChild(c: FakeEl) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c: FakeEl) { el.children = el.children.filter(x => x !== c); },
    setAttribute(k: string, v: string) { el.attrs[k] = v; if (k === 'id') el.id = v; },
    getAttribute(k: string) { return el.attrs[k]; },
    addEventListener(type: string, fn: (e: unknown) => void) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
    },
    dispatch(type: string, e?: unknown) { (listeners[type] || []).forEach(fn => fn(e ?? { type, target: el })); },
    click() { el.dispatch('click'); },
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight, right: el.clientWidth, bottom: el.clientHeight }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    querySelector(sel: string) { return queryAll(el, sel)[0] ?? null; },
    querySelectorAll(sel: string) { return queryAll(el, sel); },
  };
  if (tag.toLowerCase() === 'canvas') {
    el.getContext = () => {
      const state: Record<string, unknown> = {};
      return new Proxy(state, {
        get(target, prop: string) {
          if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 6 });
          if (prop === 'fillText') return (s: string) => { fillTextLog.push(String(s)); };
          if (pathLog && (prop === 'moveTo' || prop === 'lineTo')) return (x: number, y: number) => { pathLog.push({ op: prop, x, y }); };
          if (opLog && (prop === 'fill' || prop === 'stroke')) return () => { opLog.push({ op: prop, style: String(target[prop === 'fill' ? 'fillStyle' : 'strokeStyle']), lineWidth: Number(target.lineWidth), alpha: Number(target.globalAlpha) }); };
          if (prop === 'createPattern') return () => ({});
          if (prop in target) return target[prop];
          return () => undefined;
        },
        set(target, prop: string, value) {
          if (prop === 'strokeStyle' && strokeLog) strokeLog.push(String(value));
          target[prop] = value;
          return true;
        },
      });
    };
  }
  return el;
}

interface FrameQueue {
  request(cb: (t: number) => void): number;
  cancel(id: number): void;
  flush(): void;
  advance(ms: number): void;
  runToCompletion(): void;
}

function makeFrameQueue(): FrameQueue {
  let now = 0;
  let nextId = 1;
  let queue: Array<{ id: number; cb: (t: number) => void }> = [];
  return {
    request(cb) { const id = nextId++; queue.push({ id, cb }); return id; },
    cancel(id) { queue = queue.filter(f => f.id !== id); },
    flush() { const run = queue; queue = []; run.forEach(f => f.cb(now)); },
    advance(ms) { now += ms; },
    runToCompletion() {
      this.flush();
      this.advance(1000);
      this.flush();
      this.flush();
    },
  };
}

interface HarnessResult {
  sandbox: Record<string, unknown>;
  frames: FrameQueue;
}

function runViewerScripts(html: string): HarnessResult {
  const fillTextLog: string[] = [];
  const strokeLog: string[] = [];
  const pathLog: PathCall[] = [];
  const opLog: OpCall[] = [];
  const frames = makeFrameQueue();
  const elementsById: Record<string, FakeEl> = {};
  for (const id of KNOWN_IDS) {
    const el = makeElement(id === 'map' ? 'canvas' : 'div', fillTextLog, id === 'map' ? strokeLog : undefined, id === 'map' ? pathLog : undefined, id === 'map' ? opLog : undefined);
    el.id = id;
    elementsById[id] = el;
  }

  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const fakeDocument = {
    getElementById: (id: string) => elementsById[id] ?? null,
    createElement: (tag: string) => makeElement(tag, fillTextLog),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (docListeners[type] ??= []).push(fn); },
    removeEventListener: () => {},
    dispatch: (type: string, e: unknown = {}) => { (docListeners[type] ?? []).forEach(fn => fn(e)); },
    head: makeElement('head', fillTextLog),
    documentElement: makeElement('html', fillTextLog),
    body: makeElement('body', fillTextLog),
    readyState: 'complete',
  };

  const sandbox: Record<string, unknown> = {
    console,
    JSON,
    Math,
    Date,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    isNaN,
    document: fakeDocument,
    devicePixelRatio: 1,
    requestAnimationFrame: (cb: (t: number) => void) => frames.request(cb),
    cancelAnimationFrame: (id: number) => frames.cancel(id),
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    ResizeObserver: class {
      cb: (entries: Array<{ target: unknown }>) => void;
      constructor(cb: (entries: Array<{ target: unknown }>) => void) { this.cb = cb; }
      observe(target: unknown) { this.cb([{ target }]); }
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({
      getPropertyValue: (k: string) => ({ '--accent': '#ACC0FF', '--findings': '#FE0001', '--bp': '#B10001', '--muted': '#B30003', '--edge': '#E10004', '--c2': '#C20002' } as Record<string, string>)[k] ?? '#888888',
    }),
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);

  const dataMatch = html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/);
  if (!dataMatch) throw new Error('could not find C4PM_DATA script in rendered HTML');
  vm.runInContext(`window.C4PM_DATA = ${dataMatch[1]};`, sandbox, { filename: 'data.js' });

  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const scriptsBlock = scriptMatches[scriptMatches.length - 1];
  if (!scriptsBlock) throw new Error('could not find map/panel script block in rendered HTML');
  vm.runInContext(scriptsBlock[1], sandbox, { filename: 'viewer-scripts.js' });

  return { sandbox, frames };
}

// ---------- camera relative zoom tests ----------

interface TreeNode { scale?: number; children?: TreeNode[] }
interface CamApi {
  MAX_S: number;
  maxS: () => number;
  focusNode: () => unknown;
  zoomAt: (px: number, py: number, k: number, animate: boolean) => void;
}
interface StateApi { map: { cam: { s: number; tx: number; ty: number } } }

function loadPage(): { cam: CamApi; state: StateApi; root: TreeNode } {
  const { html } = buildView({ repo: path.join(__dirname, 'fixtures/sample') });
  const { sandbox } = runViewerScripts(html);
  const cam = sandbox.C4PM_CAM as CamApi;
  const state = sandbox.C4PM_STATE as StateApi;
  const data = sandbox.C4PM_DATA as { root: TreeNode };
  return { cam, state, root: data.root };
}

function setScaleOnAll(n: TreeNode, scale: number): void {
  n.scale = scale;
  for (const c of n.children ?? []) setScaleOnAll(c, scale);
}

function deleteScaleOnAll(n: TreeNode): void {
  delete n.scale;
  for (const c of n.children ?? []) deleteScaleOnAll(c);
}

describe('viewer-camera-rel: relative zoom clamp (P14-I6)', () => {
  test('tree without scale: maxS is MAX_S and zoom-in clamps to 14', () => {
    // layoutView now sets node.scale on every node, so remove it to test the no-scale path.
    const { cam, state, root } = loadPage();
    deleteScaleOnAll(root);
    expect(cam.focusNode()).not.toBeNull();
    expect(cam.maxS()).toBe(14);
    cam.zoomAt(600, 400, 1000, false);
    expect(state.map.cam.s).toBe(14);
  });

  test('deep focus with scale 0.001: maxS is 14000 and zoom-in passes 14', () => {
    const { cam, state, root } = loadPage();
    setScaleOnAll(root, 0.001);
    expect(cam.focusNode()).not.toBeNull();
    expect(cam.maxS()).toBeCloseTo(14000, 6);
    cam.zoomAt(600, 400, 1000, false);
    expect(state.map.cam.s).toBeGreaterThan(14);
  });

  test('no node in focus: maxS is 14 even when scale is set', () => {
    const { cam, state, root } = loadPage();
    setScaleOnAll(root, 0.001);
    state.map.cam = { s: 1, tx: -1e9, ty: 0 };
    expect(cam.focusNode()).toBeNull();
    expect(cam.maxS()).toBe(14);
  });
});
