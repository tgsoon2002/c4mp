import vm from 'vm';

// ---------- fake DOM / canvas harness ----------
// map.js and panel.js are plain browser scripts. There is no browser available in this
// environment, so this harness runs them for real inside a Node `vm` context against a
// minimal fake DOM, and records what they actually draw/build. This is the only thing in
// Phase 5 that executes the browser code at all — everything else only checks the HTML string.
//
// P16-B30a: moved here (cut, not copied) from viewer-smoke.test.ts so the board tests can share it.
// `viewer-camera-rel.test.ts` still has its own private copy (K's cleanup later).

export const KNOWN_IDS = [
  'root', 'header', 'title', 'subtitle', 'summary', 'drift-summary', 'main',
  'map-wrap', 'map', 'hud-tl', 'hud-level', 'hud-sub', 'hud-tr',
  'btn-up', 'btn-fit', 'btn-auto', 'btn-edit', 'btn-reset', 'btn-arrange', 'btn-undo', 'btn-redo', 'btn-export', 'btn-in', 'btn-out', 'hud-bl', 'legend',
  'left', 'panel-col', 'search', 'search-results', 'panel',
  'view-switch', 'view-toast', 'bar-chips', 'search-box',   // P20-T5-0 (b254); VIEW-0 (b337): view-switch replaced btn-view
  'grip-left', 'grip-right',   // b269
];

export interface FakeEl {
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
  title?: string;                              // set by the viewer scripts as a plain property (b618)
  onclick?: ((e?: unknown) => void) | null;   // set by the viewer scripts as a plain property (b618)
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  removeAttribute(k: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  dispatch(type: string, e?: unknown): void;
  click(): void;
  focus(): void;
  blur(): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number };
  setPointerCapture(): void;
  releasePointerCapture(): void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  getContext?(kind: string): unknown;
}

// moveTo/lineTo calls the canvas received, in order (P9-T3b: edge endpoints are read from these).
// fill()/stroke() calls in order, with the fill/stroke style active at the time (P9-T4b: draw-pass order).
export interface OpCall { op: 'fill' | 'stroke'; style: string; lineWidth: number; alpha: number }
export interface PathCall { op: 'moveTo' | 'lineTo'; x: number; y: number }

function matchesSelector(el: FakeEl, sel: string): boolean {
  if (!el._classes) return false;   // a text node (createTextNode) has no classes, id or tag
  if (sel.startsWith('.')) return el._classes.has(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function queryAll(root: FakeEl, sel: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => {
    for (const c of n.children ?? []) {   // a text node has no children
      if (matchesSelector(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

// b269: style with CSS-variable methods (non-enumerable, so style objects still compare/enumerate as plain maps).
function fakeStyle(): Record<string, string> {
  const st: Record<string, string> = {};
  Object.defineProperty(st, 'setProperty', { value: (k: string, v: string) => { st[k] = String(v); } });
  Object.defineProperty(st, 'removeProperty', { value: (k: string) => { delete st[k]; } });
  Object.defineProperty(st, 'getPropertyValue', { value: (k: string) => st[k] ?? '' });
  return st;
}

export function makeElement(tag: string, fillTextLog: string[], strokeLog?: string[], pathLog?: PathCall[], opLog?: OpCall[]): FakeEl {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    style: fakeStyle(),
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
    removeAttribute(k: string) { delete el.attrs[k]; },
    addEventListener(type: string, fn: (e: unknown) => void) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
    },
    dispatch(type: string, e?: unknown) { (listeners[type] || []).forEach(fn => fn(e ?? { type, target: el })); },
    click() { el.dispatch('click'); },
    focus() {},
    blur() {},
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
          // a test may set its own ctx.fillText (C1 D2: to see where each text goes); else the text is logged
          if (prop === 'fillText') return typeof target.fillText === 'function' ? target.fillText : (s: string) => { fillTextLog.push(String(s)); };
          if (pathLog && (prop === 'moveTo' || prop === 'lineTo')) return (x: number, y: number) => { pathLog.push({ op: prop, x, y }); };
          if (opLog && (prop === 'fill' || prop === 'stroke')) return () => { opLog.push({ op: prop, style: String(target[prop === 'fill' ? 'fillStyle' : 'strokeStyle']), lineWidth: Number(target.lineWidth), alpha: Number(target.globalAlpha) }); };
          if (prop === 'createPattern') return () => ({});
          if (prop in target) return target[prop];
          return () => undefined;
        },
        set(target, prop: string, value) {
          // record every strokeStyle assignment map.js makes while drawing, in order -- this is
          // the only way this fake canvas can tell what color a given stroke() call used, since
          // it otherwise just records shapes with no color/paint concept (see FakeEl.getContext
          // above). Used to assert edge-glow colors (cyan/magenta) and the shared/unassigned/
          // split-file dashed-border colors actually got set during a draw, not just that drawing
          // ran without throwing.
          if (prop === 'strokeStyle' && strokeLog) strokeLog.push(String(value));
          target[prop] = value;
          return true;
        },
      });
    };
  }
  return el;
}

export interface FrameQueue {
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

export interface HarnessResult {
  sandbox: Record<string, unknown>;
  fillTextLog: string[];
  strokeLog: string[];
  pathLog: PathCall[];
  opLog: OpCall[];
  frames: FrameQueue;
  resizeObservers: Array<{ target?: unknown; cb: (entries: Array<{ target: unknown }>) => void }>;
  panel: FakeEl;
  search: FakeEl;
  searchResults: FakeEl;
  canvas: FakeEl;
  /** Run (and drop) every pending setTimeout callback the page queued. */
  flushTimers(): void;
  /** P20-T5-0 (b254): listeners the page added with window.addEventListener, by event type (removeEventListener drops them). */
  windowListeners: Record<string, Array<(e: unknown) => void>>;
  /** P20-T5-0 (b254): call every window listener of `type` with `e` (default { type }), e.g. 'hashchange' after a test set location.hash. */
  fireWindowEvent(type: string, e?: unknown): void;
}

export interface HarnessOpts {
  /** Extra element ids to create besides KNOWN_IDS (board tests: 'board-drawer', 'center', 'btn-board', ...). */
  extraIds?: string[];
  /** Extra globals for the page's sandbox (e.g. a fake `localStorage`).
   *  P20-T5-0 (b254): the sandbox has NO `location` unless a test passes one here, e.g. { location: { href: 'file:///x.html', hash: '#io' } };
   *  change location.hash on that object, then result.fireWindowEvent('hashchange'). */
  globals?: Record<string, unknown>;
}

export function runViewerScripts(html: string, opts: HarnessOpts = {}): HarnessResult {
  const fillTextLog: string[] = [];
  const strokeLog: string[] = [];
  const pathLog: PathCall[] = [];
  const opLog: OpCall[] = [];
  const frames = makeFrameQueue();
  const elementsById: Record<string, FakeEl> = {};
  for (const id of [...KNOWN_IDS, ...(opts.extraIds ?? [])]) {
    const el = makeElement(id === 'map' ? 'canvas' : 'div', fillTextLog, id === 'map' ? strokeLog : undefined, id === 'map' ? pathLog : undefined, id === 'map' ? opLog : undefined);
    el.id = id;
    elementsById[id] = el;
  }

  const timers: Array<{ id: number; fn: () => void }> = [];
  let timerSeq = 0;
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const docCapture: Record<string, Array<(e: unknown) => void>> = {};   // Phase 25 UI3: listeners added with capture (true or { capture: true })
  const windowListeners: Record<string, Array<(e: unknown) => void>> = {};
  const fakeDocument = {
    getElementById: (id: string) => elementsById[id] ?? null,
    createElement: (tag: string) => makeElement(tag, fillTextLog),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    addEventListener: (type: string, fn: (e: unknown) => void, opts?: boolean | { capture?: boolean }) => {
      const capture = opts === true || (typeof opts === 'object' && !!opts && !!opts.capture);
      ((capture ? docCapture : docListeners)[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
    // As a real document: capture listeners first; one that calls stopPropagation() keeps the event from the bubble listeners.
    dispatch: (type: string, e: unknown = {}) => {
      const capture = docCapture[type] ?? [];
      let stopped = false;
      if (capture.length && typeof e === 'object' && e !== null) {
        const ev = e as { stopPropagation?: () => void };
        const given = ev.stopPropagation;
        ev.stopPropagation = () => { stopped = true; if (typeof given === 'function') given.call(ev); };
      }
      capture.forEach(fn => fn(e));
      if (!stopped) (docListeners[type] ?? []).forEach(fn => fn(e));
    },
    head: makeElement('head', fillTextLog),
    documentElement: makeElement('html', fillTextLog),
    body: makeElement('body', fillTextLog),
    readyState: 'complete',
  };

  // Every ResizeObserver map.js creates, so a test can fire its callback again after a size change.
  const resizeObservers: Array<{ target?: unknown; cb: (entries: Array<{ target: unknown }>) => void }> = [];
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
    // Fake timers: the page's setTimeout calls queue here; a test runs them with `flushTimers()`.
    setTimeout: (fn: () => void) => { timers.push({ id: ++timerSeq, fn }); return timerSeq; },
    clearTimeout: (id: number) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    encodeURI,
    decodeURI,
    encodeURIComponent,
    isNaN,
    document: fakeDocument,
    addEventListener: (type: string, fn: (e: unknown) => void) => { (windowListeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { if (windowListeners[type]) windowListeners[type] = windowListeners[type].filter(f => f !== fn); },
    dispatchEvent: (e: { type: string }) => { (windowListeners[e.type] ?? []).forEach(fn => fn(e)); return true; },
    devicePixelRatio: 1,
    requestAnimationFrame: (cb: (t: number) => void) => frames.request(cb),
    cancelAnimationFrame: (id: number) => frames.cancel(id),
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    ResizeObserver: class {
      cb: (entries: Array<{ target: unknown }>) => void;
      constructor(cb: (entries: Array<{ target: unknown }>) => void) { this.cb = cb; resizeObservers.push(this); }
      target?: unknown;
      observe(target: unknown) { this.target = target; this.cb([{ target }]); }
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({
      // distinct accent/findings/blueprint/muted(edge)/container colors so overlay and draw-order tests can tell those apart; all else grey
      getPropertyValue: (k: string) => ({ '--accent': '#ACC0FF', '--findings': '#FE0001', '--bp': '#B10001', '--muted': '#B30003', '--edge': '#E10004', '--c2': '#C20002', '--screen': '#5B4FC9' } as Record<string, string>)[k] ?? '#888888',
    }),
  };
  Object.assign(sandbox, opts.globals ?? {});
  sandbox.window = sandbox;

  vm.createContext(sandbox);

  const dataMatch = html.match(/window\.C4PM_DATA = ([\s\S]+?);\s*<\/script>/);
  if (!dataMatch) throw new Error('could not find C4PM_DATA script in rendered HTML');
  vm.runInContext(`window.C4PM_DATA = ${dataMatch[1]};`, sandbox, { filename: 'data.js' });

  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const scriptsBlock = scriptMatches[scriptMatches.length - 1];
  if (!scriptsBlock) throw new Error('could not find map/panel script block in rendered HTML');
  vm.runInContext(scriptsBlock[1], sandbox, { filename: 'viewer-scripts.js' });

  return {
    sandbox,
    fillTextLog,
    strokeLog,
    pathLog,
    opLog,
    frames,
    resizeObservers,
    panel: elementsById['panel'],
    search: elementsById['search'],
    searchResults: elementsById['search-results'],
    canvas: elementsById['map'],
    flushTimers: () => { const due = timers.splice(0); due.forEach(t => t.fn()); },
    windowListeners,
    fireWindowEvent: (type: string, e: unknown = { type }) => { (windowListeners[type] ?? []).slice().forEach(fn => fn(e)); },
  };
}

export function serializeText(el: FakeEl | { nodeType: number; textContent: string }): string {
  if ('nodeType' in el) return el.textContent;
  const parts: string[] = [];
  if (el._text) parts.push(el._text);
  if (el._html) parts.push(el._html);
  for (const c of el.children) parts.push(serializeText(c));
  if (el.href) parts.push(el.href);
  return parts.join(' ');
}
