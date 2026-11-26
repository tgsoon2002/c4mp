// mode.js: which view the page shows, ONE module (P20-T5-0, b254; T5-B b256 fills in the tree swap).
// Loaded right after settings.js (src/view/html.ts VIEWER_SCRIPTS), before every script that shows a tree.
//
// CONTRACT  window.C4PM_MODE = { get, has, set, registerView, renderer, word, tag, region, color, legend, counts, isHolder, needsCode, onChange, callKinds, start, bare, setTreeLoader }
//           window.C4PM_VIEWS = { <name>: spec }   VIEW-0 (b337): the ONE registry of views, filled by registerView only; others read it.
//   registerView(name, spec)  spec = { label, short, tree(data) -> { root, edges } | null, renderer() -> object | null,
//                  chips?(data) -> string, color? }. label = full name ('IO view'), short = narrow-width text ('IO'), tree = the tree
//                  of the view from C4PM_DATA (null: the plan has nothing for it), renderer = the view's own renderer (null: the
//                  architecture engine draws it), chips = the header chips text, color = HUD chip colour (CSS variable name without '--').
//                  Registration order = switch order (openView.js). A second registration of the same name or a bad spec throws.
//                  mode.js registers 'arch'; ioView.js registers 'io' at its end; later views register the same way.
//   get()          -> a registered view name. Starts as 'arch'.
//   has(mode)      -> boolean: the view is registered and its tree(C4PM_DATA) is not null ('arch' always; 'io' only with navView).
//   set(mode)      order, kept verbatim: (1) if mode == current, return; (2) current = mode;
//                  (3) the registered tree loader (setTreeLoader, map.js) gets C4PM_VIEWS[mode].tree(C4PM_DATA); (4) document.documentElement data-mode = mode;
//                  (5) fire onChange listeners in subscription order, AFTER the tree is loaded;
//                  (6) no redraw in mode.js. Listener exceptions are not caught.
//                  A mode this plan does not have (has(mode) false) throws: no silent fallback. (P20-T5-B, b256)
//   setTreeLoader(fn)  fn(tree) with tree = { root, edges }: map.js registers its loadTree before start() (LAY-12b, b382).
//                  set() throws when none is registered: no silent fallback.
//   renderer()     -> the current view's renderer() (an object with draw, hit, rect, hud, focus), or null for the architecture engine.
//   onChange(fn)   fn(mode) runs after a real change. Every subscriber subscribes at its own load AND builds its first
//                  state from get(); fillHeader, tree build and search index read get() at call time. D/E/F must not
//                  depend on each other's onChange.
//   start()        called ONCE by map.js right after window.C4PM_MAP is defined: reads the hash
//                  ((window.location && window.location.hash || '').split('&')[0] === '#<name>') and, when has(name),
//                  calls set(name). A hash of a view without data (e.g. #io on a plan without screens) is ignored: arch.
//                  The same rule runs on every hashchange.
//                  P20-T5-Q (b264): when the hash parts (split on '&') contain 'bare' it also sets class 'bare' on #root, once;
//                  the flag does not change on hashchange. Nothing is stored (CSS only, style.css '#root.bare').
//   counts(kinds[, mode]) -> 'N words' text of the kinds in the array, in the table order of the mode, joined ' · ':
//                  ['screen','command','command'] -> '1 screen · 2 commands'. Word = hud word lower-cased, plural by 's' unless N is 1.
//   callKinds      -> string[]: the plan kinds a screen's "Calls" row and the "Light implemented components" ring accept (b130).
//   bare()         -> boolean: this window was opened with '&bare' (C4PM_OPEN does it); false before start().
(function () {
  // b142: kind words, ONE table, built on the server from KIND_TABLE + a word table (src/view/kindWords.ts) and injected as
  // C4PM_DATA.kindWords = { arch|io|storage: { kind: { tag, region?, hud, legend?, color, holder?, needsCode? } } }. Nothing else in the viewer lists kinds.
  // tag = short chip (tree, panel crumbs), region = region header (render.js), hud = HUD level label (controls.js), legend = legend
  // label (panel.js), color = CSS variable name without '--' (render.js, controls.js, panel.js). A kind with no row in the current
  // view is looked up in the other views (a screen on the arch map); no row anywhere: undefined, the caller falls back.
  // A page without kindWords (a bare test sandbox) has an empty table: every accessor returns undefined.
  const VIEWS = ['arch', 'io', 'storage'];
  const tableOf = (view) => ((window.C4PM_DATA && window.C4PM_DATA.kindWords) || {})[view] || {};
  const rowOf = (kind, mode) => {
    const own = tableOf(mode || current)[kind];
    if (own) return own;
    for (const v of VIEWS) { const r = tableOf(v)[kind]; if (r) return r; }
    return undefined;
  };
  const wordOf = (field) => (kind, mode) => {
    const row = rowOf(kind, mode);
    return row ? row[field] : undefined;
  };
  // Legend rows of a view: the arch rows that have a legend label, then the rows of the view itself that arch does not have.
  const legendOf = (mode) => {
    const arch = tableOf('arch'), m = mode || current, out = [];
    Object.keys(arch).forEach(k => { if (arch[k].legend) out.push({ kind: k, label: arch[k].legend, color: arch[k].color }); });
    if (m !== 'arch') {
      const own = tableOf(m);
      Object.keys(own).forEach(k => { if (!arch[k] && own[k].legend) out.push({ kind: k, label: own[k].legend, color: own[k].color }); });
    }
    return out;
  };

  const countsOf = (kinds, mode) => {
    const n = {}, order = Object.keys(tableOf(mode || current));
    kinds.forEach(k => { n[k] = (n[k] || 0) + 1; });
    const rank = k => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
    return Object.keys(n).sort((a, b) => rank(a) - rank(b)).map(k => {
      const w = rowOf(k, mode);
      return n[k] + ' ' + ((w && w.hud) || k).toLowerCase() + (n[k] === 1 ? '' : 's');
    }).join(' · ');
  };

  let current = 'arch';
  let bare = false;
  const listeners = [];
  let treeLoader = null;   // LAY-12b: registered by map.js (setTreeLoader); set() step 3
  // VIEW-0 (b337): the view registry. own() guards against Object.prototype names ('toString' is no view).
  const views = {};
  const own = (name) => Object.prototype.hasOwnProperty.call(views, name);
  // The view a hash names ('#io&bare' -> 'io') when the plan has it, else 'arch'.
  const viewOfHash = () => {
    const name = (window.location && window.location.hash || '').split('&')[0].slice(1);
    return name && api.has(name) ? name : 'arch';
  };

  const api = {
    get() { return current; },
    has(mode) {
      return own(mode) && !!views[mode].tree(window.C4PM_DATA);
    },
    set(mode) {
      if (mode === current) return;
      if (!api.has(mode)) throw new Error('C4PM_MODE.set: this plan has no mode ' + JSON.stringify(mode));
      if (!treeLoader) throw new Error('C4PM_MODE.set: no tree loader registered');   // checked first: a failed set() leaves the mode as it was
      current = mode;
      treeLoader(views[mode].tree(window.C4PM_DATA));
      document.documentElement.setAttribute('data-mode', mode);
      listeners.forEach(fn => fn(mode));
    },
    // word(kind[, mode]) / tag / region / color -> the string of the current (or given) mode, undefined when no row has it: fall back.
    // legend([mode]) -> [{ kind, label, color }] in table order.
    word: wordOf('hud'),
    tag: wordOf('tag'),
    region: wordOf('region'),
    color: wordOf('color'),
    legend: legendOf,
    counts: countsOf,
    // C1 A1 (b828): isHolder(kind) -> true for a holder kind (the kind row says holder: the C1 'context'): never drawn, never
    // hit, no tree or breadcrumb row, always open, depth -1. A kind with no row (a bare sandbox) is no holder.
    isHolder(kind) { const r = rowOf(kind); return !!(r && r.holder); },
    // C1 A2 (b829): needsCode(kind) -> false for a kind whose row says needsCode: false (KIND_TABLE's needsCode on the arch rows:
    // subregion, person, external), so a plan-only node of it shows no "planned (no code yet)" (tree.js, panel.js). Default true:
    // a kind with no row, or a row without the field (code kinds, io and storage rows, a bare sandbox).
    needsCode(kind) { const r = rowOf(kind); return !(r && r.needsCode === false); },
    onChange(fn) { listeners.push(fn); },
    setTreeLoader(fn) {
      if (typeof fn !== 'function') throw new Error('C4PM_MODE.setTreeLoader: fn must be a function');
      treeLoader = fn;
    },
    registerView(name, spec) {
      const bad = (why) => { throw new Error('C4PM_MODE.registerView(' + JSON.stringify(name) + '): ' + why); };
      if (typeof name !== 'string' || !name) bad('the name must be a non-empty string');
      if (own(name)) bad('a view of this name is already registered');
      if (!spec || typeof spec.label !== 'string' || typeof spec.short !== 'string') bad('spec needs label and short strings');
      if (typeof spec.tree !== 'function' || typeof spec.renderer !== 'function') bad('spec needs tree() and renderer() functions');
      if (spec.chips !== undefined && typeof spec.chips !== 'function') bad('spec.chips must be a function');
      if (spec.color !== undefined && typeof spec.color !== 'string') bad('spec.color must be a string');
      views[name] = spec;
    },
    renderer() {
      const r = views[current].renderer();
      if (r === undefined) throw new Error('C4PM_MODE.renderer: view ' + JSON.stringify(current) + ' returned undefined (null = the architecture engine)');
      return r;
    },
    // b130: NavCall.toKind values a screen call is shown for; ONE list (the server records every non-frontend kind). A function-like
    // target lights its nearest component (NavCall.toComponent).
    callKinds: ['component', 'function', 'class', 'method', 'type'],
    bare() { return bare; },
    start() {
      // P20-T5-Q (b264): '#io&bare' / '#arch&bare': the map-only window. Read once; the class is on #root before the first fit.
      bare = (window.location && window.location.hash || '').split('&').slice(1).indexOf('bare') >= 0;
      if (bare) document.getElementById('root').classList.add('bare');
      api.set(viewOfHash());   // no-op for arch (already current)
      // P20-T5-B (b256): the hash drives the mode afterwards too. No window.addEventListener (a bare sandbox): no hashchange.
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('hashchange', () => api.set(viewOfHash()));
      }
    },
  };
  window.C4PM_MODE = api;
  window.C4PM_VIEWS = views;
  api.registerView('arch', { label: 'Architecture view', short: 'Arch', tree: d => ({ root: d.root, edges: d.edges }), renderer: () => null });
})();
