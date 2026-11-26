// sim.js: the simulation core of the viewer (Phase 25 UI3, b753): the selected s-item and its step cursor, shared by every
// view and every window; what each view lights; the sample-row state per step; the keys and the hash extras.
// Spec: Document/Roadmap/Phase25/UI_TASKS.md section C UI3; data = C4PM_DATA.sims (B1, built by src/view/simModel.ts).
// Loaded after board-search.js (src/page/html.ts VIEWER_SCRIPTS); the later sim-*.js files load after it and read C4PM_SIM.
//
// A page without s-items (no C4PM_DATA.sims, or an empty list): this file returns at once, window.C4PM_SIM stays undefined
// and nothing else changes (every sim-*.js checks C4PM_SIM first).
//
// CONTRACT  window.C4PM_SIM = { items, byId, selected, step, steps, curStep, select, go, act, onChange, notify, tableStateAt,
//                               rowsTableHtml, nameOf, stepTarget, viewWord, goView, litFor, icon, noPlace, nameOfId,
//                               personName, hash, hooks, depth, setDepth, DEPTHS, flow, flowIndex, curFlow, lanes }
//   items()         -> ViewSim[] of the page (the data itself, read only).   byId(id) -> ViewSim | null.
//   selected()      -> the selected s-id or null.   step() -> the 0-based cursor or null (no step: the whole s-item).
//   steps(id?)      -> the steps of s-item `id` (default: the selected one); [] when none.   curStep() -> the cursor's step or null.
//   select(id|null, opts { remote?, fit?, fromPres? })  select an s-item (an unknown id = null); the cursor becomes null.
//                   Ends present mode unless opts.fromPres; clearing closes the sequence (hooks.seq(false)); fits the map to the
//                   path unless opts.fit === false (hooks.fitPath); posts the link message unless opts.remote. Before the
//                   fit, C4PM_STORAGEVIEW.setSample(sampleSizes) (UI11: recordId -> the most rows any step gives it; null on clear).
//   go(i|null, opts { go?, remote?, fromPres? })  move the cursor (clamped; null or a non-integer = no step). While presenting
//                   (and not opts.fromPres) only hands the (original) index to hooks.presentGo. opts.go: hooks.fly(curFlow())
//                   (UI7: switch to the step's view, fly, or a toast for an outside step; b853 S3b: the cursor's flow step, at
//                   code a copy of the step). Posts the link message unless opts.remote.
//   act(name)       'prev' | 'next' (b853 S3b: by flow step at the depth, to its first original step, with fly; from no cursor
//                   next = the first, prev = the last flow step; clamped; at code cursor -/+ 1) | 'whole' (cursor null,
//                   hooks.fitPath) | 'clear' (select(null)) | 'present' (hooks.present(id, cursor or 0)) | 'seq' (hooks.seq()).
//                   Another name throws.
//   onChange(fn)    fn({ sim, step, what }) after every change; what = 'select' | 'step' | 'view' (a mode change while selected)
//                   | 'seq' (the sequence drawer opened or closed: UI13 calls notify('seq'), so the strip and the panel refresh
//                   their "≡ Sequence" labels).
//   notify(what)    a part of the page outside this file changed something the listeners show: recompute the lit state,
//                   redraw and call every onChange listener with `what` (UI13: 'seq').
//   litFor(mode)    -> null (no s-item) | { ids: Map<nodeId, { ns: step numbers, cur }>, calls: [{ n, from, to, label, unverified,
//                   cur, reply }] (arch only), list: [{ n, i, ids, cur }] (steps with a target in this view), cur: the cursor }.
//                   b853 S3b: over flow(), so n / i / ns are flow numbers at the depth; cur = the flow step holds the cursor.
//                   Lit, nodes of `mode`'s tree only: arch = the flow step's archIds (code: its arch targets; above: its boxes)
//                   and both ends of each of its arrows (an arrow is listed in calls when both ends are arch nodes); io /
//                   storage = its targets of that view; storage also the records of its rows. Outside steps light nothing.
//                   At code this equals the per-step result.
//   tableStateAt(id, i)  -> { <recordId>: { name, cols, at, touched, rows: [{ vals, ins, old }] } }: every record with rows at
//                   or before step i (null = the last step): its rows from the last step <= i that gave rows for it (`at`),
//                   diffed by its pk columns (rows[].pk; none = the first column) with the rows of the step before that one.
//                   ins = a new row, old = { col: value before } of changed cells; touched = something changed at step i itself.
//   rowsTableHtml(state, only?)  -> HTML of the tables (only = recordIds to keep): div.sim-rows > table, caption = the record
//                   name (+ ' · unchanged' when not touched), tr.ins, td.chg (<s>old</s> → new). Every value is escaped.
//   nameOf(target)  -> target.name (resolved on the server).   stepTarget(step) -> above code, for a flow step with boxes: the
//                   names of its boxes (lanes()) joined ' + ' (b853 S3b); else the outside text, or the names joined ' + '.
//   viewWord(view)  -> 'Architecture' | 'IO' | 'Storage' (the registered view label without ' view') | 'Outside'.
//   goView(mode, then)  run then() in view `mode`: at once when it is the current view; else after the switch (the hash is
//                   set as ioPanel.js does, keeping '&bare'; mode.js follows it and loads the tree; then() runs in the
//                   C4PM_MODE.onChange listener). No window.location: C4PM_MODE.set(mode). A view the plan lacks: nothing.
//   icon(kind)      -> the kind icon ('flow' | 'journey') as an inline SVG string (a constant; '' for another kind).
//   noPlace(msg)    -> a check message without its leading place ('s-1 step 8: ', 's-1 steps 7-8: ', 's-2 stage 1: ').
//   nameOfId(id, sim?)  -> display name of an arch node id ('Owner.fn' for a function / method) or of a lane of `sim` (any
//                   depth's: C4PM_SIMFLOW.allLanes, b853 S3b); else id.
//   personName(sim) -> the s-item's person (the plan person's name, or the text) or null.
//   hash()          -> the hash extras read once at load: { sim, step, seq, present, sims, stay, depth, seqonly } (strings,
//                   or undefined; seqonly true/false). Public (QU3): sim, step, seqonly, depth (b853); test helpers: present,
//                   seq, sims, stay.
// Flow depth (b853 S3a): a per-window view of the same steps (C4PM_SIMFLOW, sim-flow.js); the original step index stays
// the cursor everywhere (step(), go, presentGo, the link message, &step=). S3b: litFor, openEarly, act, the fly, stepTarget
// and map.sim read the flow steps; at 'code' nothing changes.
//   DEPTHS          ['context', 'container', 'component', 'code'] (C4PM_SIMFLOW.DEPTHS).   depth() -> the current depth.
//                   Start: a known &depth= (this window, not saved), else a known localStorage 'c4mp.simDepth' (old 'c4pm.simDepth' read too; C4PM_STORE;
//                   not in C4PM_SETTINGS.DEF), else 'code'.
//   setDepth(d)     an unknown d throws (like act); the same d does nothing; else save (try/catch), drop the flow cache,
//                   update('depth') (listeners get what 'depth'); then with an s-item, no cursor and not presenting:
//                   hooks.fitPath().
//   flow(id?, d?)   -> FlowStep[] of s-item `id` (default: the selected one) at depth d (default: this window's depth;
//                   b853 S6b: a present helper passes its leader's) (C4PM_SIMFLOW.flowSteps, an unknown d throws; cached per
//                   s-id and depth: the same array until setDepth). Without C4PM_SIMFLOW: one flow step per step (a copy
//                   with first = last = i, members [i], views [view], boxes [], archIds = its arch target nodeIds, arrows =
//                   its call or []).
//   flowIndex(i, id?)  -> the index in flow(id) of the flow step holding original index i, or null.
//   curFlow()       -> the flow step holding the cursor, or null.   lanes(id?) -> C4PM_SIMFLOW.lanesAt(sim, depth).
//   hooks           filled by the later sim-*.js files, each optional: fly(step) and fitPath() (UI7), openList() (UI5),
//                   present(id, i), presentGo(i, opts), presentEnd(), presenting() -> bool, presentKey(e) -> bool used
//                   (UI12; UI17: presentGo also gets go's opts), seq(on?) (UI13: on true / false, undefined = toggle),
//                   presentState() -> { pres } | null and presentRemote(message) (UI17, sim-present.js).
// State for the renderers: after every change C4PM_STATE.map.sim = null (none) | { id, step, view, depth, flowStep:
// flowIndex(step) (null without a cursor), tablesAt: curFlow().last (null without a cursor), ...litFor(view), tables:
// tableStateAt(id, tablesAt) } (b853 S3b; at code flowStep = tablesAt = step) and C4PM_STATE.map.openEarly = openEarly()
// (UI8: the arch nodes that open at 20%, camera.js openness: the cursor's flow step's archIds and arrow ends with their
// ancestors; openEarly: null without an s-item; no cursor: every flow step (b786)), with no s-item C4PM_STATE.map.openBand =
// null (b786: no stale band from the last fly), then C4PM_STATE.requestDraw(); recomputed on every C4PM_MODE.onChange.
// Keys (document keydown, capture phase, never while typing): hooks.presentKey first (used = stopPropagation). Esc (QU1):
// a selected c-item or b-item goes first (this file does nothing, the others act); else a selected s-item is cleared
// (stopPropagation). In the sequence-only window (&seqonly) Esc does nothing (b797): stopped, nothing cleared, nothing
// posted. ← / → with an s-item selected and no Alt / Meta / Ctrl / Shift held: act('prev' | 'next'),
// preventDefault; with a modifier held the arrows are left alone (browser Back, text selection).
// Window link: message type 'sim' { sim, step } (C4PM_LINK.post, replayed to a window that joins later); a received one
// selects the s-item (opts.remote, fit: false) and moves the cursor with opts.remote: no fit, no fly, no view change, no echo.
// The payload may carry `pres` (UI17, sim-present.js: hooks.presentState(); never a `map` key); presentRemote gets every
// received message.
(function () {
  'use strict';
  const data = window.C4PM_DATA;
  const sims = data && data.sims;
  if (!Array.isArray(sims) || !sims.length) return;   // no s-items: C4PM_SIM stays undefined, the page is unchanged

  const MODE = window.C4PM_MODE;
  const byId = new Map(sims.map(s => [s.id, s]));
  const listeners = [];
  const hooks = {};
  let sel = null;       // the selected s-id
  let cur = null;       // the 0-based step cursor, null = no step
  let pending = null;   // goView: { mode, then } waiting for the mode change

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const stepsOf = id => { const s = byId.get(id === undefined ? sel : id); return s ? s.steps : []; };
  const curStep = () => (sel && cur !== null ? stepsOf()[cur] || null : null);
  const presenting = () => !!(hooks.presenting && hooks.presenting());

  // Node ids of each view's tree (children and subregions) and each node's parent id, built on first use from the
  // registered view's tree().
  const treeIds = {}, treeUp = {};
  function has(mode, id) {
    if (!treeIds[mode]) {
      const ids = new Set(), up = new Map();
      const views = window.C4PM_VIEWS || {};
      const tree = Object.prototype.hasOwnProperty.call(views, mode) ? views[mode].tree(data) : null;
      const walk = (n, p) => {
        ids.add(n.id);
        if (p) up.set(n.id, p.id);
        (n.children || []).forEach(c => walk(c, n));
        (n.subregions || []).forEach(c => walk(c, n));
      };
      if (tree && tree.root) walk(tree.root, null);
      treeIds[mode] = ids;
      treeUp[mode] = up;
    }
    return treeIds[mode].has(id);
  }

  // Flow depth (b853 S3a): the depth this window shows the steps at, and the flow steps of an s-item at that depth
  // (C4PM_SIMFLOW, sim-flow.js). Without C4PM_SIMFLOW (a bare page) every step is its own flow step, so nothing throws.
  const FLOW = window.C4PM_SIMFLOW;
  const DEPTHS = FLOW ? FLOW.DEPTHS : Object.freeze(['context', 'container', 'component', 'code']);
  const DEPTH_KEY = 'c4mp.simDepth';   // own localStorage key (not in C4PM_SETTINGS.DEF: the gear popup is built from that)
  let depth = 'code';                  // set from the hash extra / the stored value after the hash extras are read
  const flowCache = new Map();         // s-id + '|' + depth (flowOf's d) -> FlowStep[]; cleared by setDepth
  function flowOf(id, d) {   // b853 S6b: d = a depth (default this window's), e.g. a present leader's
    const sid = id === undefined ? sel : id, dp = d === undefined ? depth : d;
    const k = sid + '|' + dp;
    if (flowCache.has(k)) return flowCache.get(k);
    // The fallback keeps the FlowStep keys litFor / openEarly read (as sim-flow.js gives them at code for one member).
    const f = FLOW
      ? FLOW.flowSteps(byId.get(sid), dp, x => has('arch', x))
      : stepsOf(sid).map((st, i) => Object.assign({}, st, {
        i, n: i + 1, first: i, last: i, members: [i], views: [st.view], boxes: [],
        archIds: st.targets.filter(t => t.view === 'arch' && t.nodeId).map(t => t.nodeId),
        arrows: st.call ? [{ from: st.call.from, to: st.call.to, label: st.call.label, reply: !!st.call.reply, unverified: !!st.unverified }] : [],
      }));
    flowCache.set(k, f);
    return f;
  }
  function flowIndex(i, id) {
    const f = flowOf(id === undefined ? sel : id);
    if (FLOW) return FLOW.flowIndex(f, i);
    if (i === null || i === undefined) return null;
    const k = f.findIndex(fs => fs.members.indexOf(i) >= 0);
    return k < 0 ? null : k;
  }
  function curFlow() {
    if (!sel || cur === null) return null;
    const k = flowIndex(cur);
    return k === null ? null : flowOf()[k];
  }
  function lanes(id) {
    const s = byId.get(id === undefined ? sel : id);
    if (FLOW) return FLOW.lanesAt(s, depth);
    return (s && s.lanes) || [];
  }
  function setDepth(d) {
    if (DEPTHS.indexOf(d) < 0) throw new Error('C4PM_SIM.setDepth: unknown depth ' + JSON.stringify(d));
    if (d === depth) return;
    depth = d;
    window.C4PM_STORE.set(DEPTH_KEY, d);   // no storage: this window only
    flowCache.clear();
    update('depth');
    if (sel && cur === null && !presenting() && hooks.fitPath) hooks.fitPath();   // Q11: no cursor -> fit the path
  }

  function litFor(mode) {
    if (!sel) return null;
    const ids = new Map(), calls = [], list = [];
    flowOf().forEach(st => {   // b853 S3b: the flow steps at the depth (at code one per step, so the same as the steps)
      if (st.view === 'outside') return;
      const isCur = cur !== null && st.members.indexOf(cur) >= 0;
      const add = id => {
        if (!id || !has(mode, id)) return false;
        const e = ids.get(id) || { ns: [], cur: false };
        if (e.ns.indexOf(st.n) < 0) e.ns.push(st.n);
        if (isCur) e.cur = true;
        ids.set(id, e);
        return true;
      };
      const here = [];
      const lit = id => { if (add(id) && here.indexOf(id) < 0) here.push(id); };
      if (mode === 'arch') {
        st.archIds.forEach(lit);
        st.arrows.forEach(a => {
          const f = add(a.from), t = add(a.to);
          if (f && t) calls.push({ n: st.n, from: a.from, to: a.to, label: a.label, unverified: !!a.unverified, cur: isCur, reply: !!a.reply });
        });
      } else st.targets.forEach(t => { if (t.view === mode) lit(t.nodeId); });
      if (mode === 'storage' && st.rows) st.rows.forEach(r => add(r.recordId));
      if (here.length) list.push({ n: st.n, i: st.i, ids: here, cur: isCur });
    });
    return { ids, calls, list, cur };
  }

  function tableStateAt(id, i) {
    const steps = stepsOf(id);
    const out = {};
    if (!steps.length) return out;
    if (i === null || i === undefined) i = steps.length - 1;
    const hist = {};   // recordId -> [{ at, rec }] in step order, up to step i
    steps.forEach((st, k) => {
      if (k > i || !st.rows) return;
      st.rows.forEach(rec => { if (rec.recordId) (hist[rec.recordId] = hist[rec.recordId] || []).push({ at: k, rec }); });
    });
    Object.keys(hist).forEach(rid => {
      const h = hist[rid], last = h[h.length - 1], rows = last.rec.rows;
      const touched = last.at === i;
      const prev = touched ? (h.length > 1 ? h[h.length - 2].rec.rows : []) : null;
      const cols = [];
      rows.forEach(r => Object.keys(r).forEach(c => { if (cols.indexOf(c) < 0) cols.push(c); }));
      const pk = (last.rec.pk || []).filter(c => cols.indexOf(c) >= 0);
      const keyCols = pk.length ? pk : cols.slice(0, 1);
      const keyOf = r => JSON.stringify(keyCols.map(c => r[c]));
      const before = prev ? new Map(prev.map(r => [keyOf(r), r])) : null;
      const list = rows.map(r => {
        const b = before && before.get(keyOf(r)), old = {};
        if (b) cols.forEach(c => { if (b[c] !== r[c]) old[c] = b[c]; });
        return { vals: r, ins: !!before && !b, old };
      });
      const changed = touched && (list.some(r => r.ins || Object.keys(r.old).length) || prev.length !== rows.length);
      out[rid] = { name: last.rec.name, cols, at: last.at, touched: changed, rows: list };
    });
    return out;
  }

  // UI11 (b761, demo sampleSizes): recordId -> the most sample rows any step of s-item `id` gives it (the size of the rows area
  // its storage card holds while the s-item is selected; C4PM_STORAGEVIEW.setSample).
  function sampleSizes(id) {
    const m = {};
    stepsOf(id).forEach(st => (st.rows || []).forEach(r => {
      if (r.recordId) m[r.recordId] = Math.max(m[r.recordId] || 0, (r.rows || []).length);
    }));
    return m;
  }

  const esc = v => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  function rowsTableHtml(state, only) {
    const keys = Object.keys(state || {}).filter(k => !only || only.indexOf(k) >= 0);
    if (!keys.length) return '';
    return '<div class="sim-rows">' + keys.map(k => {
      const s = state[k];
      return '<table><caption>' + esc(s.name) + (s.touched ? '' : ' · unchanged') + '</caption><tr>' +
        s.cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>' +
        s.rows.map(r => '<tr' + (r.ins ? ' class="ins"' : '') + '>' + s.cols.map(c => (Object.prototype.hasOwnProperty.call(r.old, c)
          ? '<td class="chg"><s>' + esc(r.old[c]) + '</s> → ' + esc(r.vals[c]) + '</td>'
          : '<td>' + esc(r.vals[c]) + '</td>')).join('') + '</tr>').join('') + '</table>';
    }).join('') + '</div>';
  }

  const nameOf = target => target.name;
  // b853 S3b: above code a flow step with boxes is named by them (the lanes at the depth); else (code, an original step, an
  // outside step) the outside text or the target names.
  function stepTarget(st) {
    if (depth !== 'code' && st.boxes && st.boxes.length) {
      const ls = lanes();
      return st.boxes.map(b => { const l = ls.find(x => x.id === b); return l ? l.name : nameOfId(b); }).join(' + ');
    }
    return st.outside ? st.outside.text : st.targets.map(nameOf).join(' + ');
  }
  function viewWord(view) {
    if (view === 'outside') return 'Outside';
    const views = window.C4PM_VIEWS || {};
    return Object.prototype.hasOwnProperty.call(views, view) ? views[view].label.replace(/ view$/, '') : String(view);
  }

  // s-item kind icons (inline SVG, currentColor; demo ICON): flow = two dots and an arrow, journey = a person, a dashed road
  // and a flag. One copy for the list, the strip and present mode; constants of this file, never data.
  const ICON = {
    flow: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="2.8" cy="8" r="2.1" fill="currentColor"/><circle cx="13.2" cy="8" r="2.1" fill="currentColor"/><path d="M5 8h5.2" stroke="currentColor" stroke-width="1.7"/><path d="M8.6 5.4 11.1 8 8.6 10.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    journey: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="3.6" cy="3.4" r="2" fill="currentColor"/><path d="M.9 10.6c0-2.4 1.2-3.8 2.7-3.8s2.7 1.4 2.7 3.8z" fill="currentColor"/><path d="M6.8 14c3.3 0 3.1-6.2 7-6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 1.6"/><path d="M14 1.4v6.4" stroke="currentColor" stroke-width="1.3"/><path d="M14 1.4 11 2.8 14 4.2z" fill="currentColor"/></svg>',
  };
  const icon = kind => (Object.prototype.hasOwnProperty.call(ICON, kind) ? ICON[kind] : '');

  // A check message starts with its own place (T7: '<sim> step N: ', '<sim> steps N-M: ', '<sim> stage N: '); a view that
  // shows the step itself cuts that place. A message without it is returned unchanged.
  const PLACE = /^s-\d+ (steps? \d+(-\d+)?|stage \d+): /;
  const noPlace = s => String(s).replace(PLACE, '');

  // Arch tree index (id -> { node, parent }), built on first use: names of call ends and of the person.
  let archIdx = null;
  function archNode(id) {
    if (!archIdx) {
      archIdx = new Map();
      const views = window.C4PM_VIEWS || {};
      const tree = Object.prototype.hasOwnProperty.call(views, 'arch') ? views.arch.tree(data) : null;
      const walk = (n, p) => {
        if (!archIdx.has(n.id)) archIdx.set(n.id, { node: n, parent: p });
        (n.children || []).forEach(c => walk(c, n));
        (n.subregions || []).forEach(c => walk(c, n));
      };
      if (tree && tree.root) walk(tree.root, null);
    }
    return archIdx.get(id) || null;
  }
  // Display name of an arch node id or lane id: a function / method 'Owner.name' (owner = its component, as the server names
  // step targets, B1), another node its name, a lane of `sim` its name, else the id itself.
  function nameOfId(id, sim) {
    const hit = id ? archNode(id) : null;
    if (hit) {
      const n = hit.node;
      if (n.kind === 'function' || n.kind === 'method') {
        for (let p = hit.parent; p; p = archNode(p.id).parent) if (p.kind === 'component') return p.name + '.' + n.name;
      }
      return n.name;
    }
    const all = sim ? (FLOW ? FLOW.allLanes(sim) : sim.lanes || []) : [];   // b853 S3b: every depth's lanes too
    const lane = all.find(l => l.id === id);
    return lane ? lane.name : String(id);
  }
  // The s-item's person: the plan person's name when it names one, else the text as written; null without a person.
  function personName(sim) {
    if (!sim || !sim.person) return null;
    return sim.person.nodeId ? nameOfId(sim.person.nodeId, sim) : sim.person.text;
  }

  // UI8 (demo openLit): the arch nodes that open early (camera.js openness at 20% instead of 45%): the current step's arch
  // targets and both ends of its call, each with all its ancestors, so a target shows inside its component without a deeper
  // zoom. null without an s-item; the current step's (an empty Set for a step with nothing in the arch tree, an outside
  // step); with no cursor every step's (whole path, b786).
  function openEarly() {
    if (!sel) return null;
    const out = new Set();
    const addStep = st => {   // b853 S3b: a flow step (its arch boxes at the depth and its arrow ends)
      if (!st || st.view === 'outside') return;
      const ends = st.archIds.concat(...st.arrows.map(a => [a.from, a.to]));
      ends.forEach(id => {
        if (!id || !has('arch', id)) return;
        for (let n = id; n; n = treeUp.arch.get(n)) out.add(n);
      });
    };
    if (cur !== null) addStep(curFlow());
    else flowOf().forEach(addStep);
    return out;
  }

  // The lit state the renderers read, the redraw and the listeners: after every change.
  function update(what) {
    const ST = window.C4PM_STATE;
    if (ST) {
      const mode = MODE.get();
      // b853 S3b: flowStep = the cursor's flow index, tablesAt = its flow step's last original index (null without a cursor)
      const cf = curFlow(), tablesAt = cf ? cf.last : null;
      ST.map.sim = sel ? Object.assign({ id: sel, step: cur, view: mode, depth, flowStep: flowIndex(cur), tablesAt }, litFor(mode),
        { tables: tableStateAt(sel, tablesAt) }) : null;
      ST.map.openEarly = openEarly();
      if (!sel) ST.map.openBand = null;   // b786: no stale band from the last fly (the fly sets it)
      if (ST.requestDraw) ST.requestDraw();
    }
    listeners.forEach(fn => fn({ sim: sel, step: cur, what }));
  }

  function post() {
    // UI17: hooks.presentState() adds { pres } (sim-present.js); null leaves the key out. Never a `map` key (link.js).
    const payload = Object.assign({ sim: sel, step: cur }, hooks.presentState ? hooks.presentState() : null);
    if (window.C4PM_LINK) window.C4PM_LINK.post('sim', payload, { replay: true });
  }

  function select(id, opts) {
    opts = opts || {};
    if (presenting() && !opts.fromPres && hooks.presentEnd) hooks.presentEnd();
    sel = id && byId.has(id) ? id : null;
    cur = null;
    if (!sel && hooks.seq) hooks.seq(false);
    const SV = window.C4PM_STORAGEVIEW;   // UI11: the storage cards make room for the s-item's sample rows (before the fit)
    if (SV && SV.setSample) SV.setSample(sel ? sampleSizes(sel) : null);
    update('select');
    if (sel && opts.fit !== false && hooks.fitPath) hooks.fitPath();
    if (!opts.remote) post();
  }

  function go(i, opts) {
    opts = opts || {};
    if (!sel) return;
    cur = Number.isInteger(i) ? clamp(i, 0, stepsOf().length - 1) : null;
    if (presenting() && !opts.fromPres) { if (hooks.presentGo) hooks.presentGo(cur, opts); return; }   // UI17: opts too; the original index
    const fs = curFlow();   // b853 S3b: the fly gets the cursor's flow step
    if (fs && opts.go && hooks.fly) hooks.fly(fs);
    update('step');
    if (!opts.remote) post();
  }

  function act(name) {
    if (name === 'clear') { select(null); return; }
    if (['prev', 'next', 'whole', 'present', 'seq'].indexOf(name) < 0) throw new Error('C4PM_SIM.act: unknown action ' + JSON.stringify(name));
    if (!sel) return;
    if (name === 'present') { if (hooks.present) hooks.present(sel, cur || 0); }
    else if (name === 'seq') { if (hooks.seq) hooks.seq(); }
    else if (name === 'whole') { go(null); if (hooks.fitPath) hooks.fitPath(); }
    else {   // b853 S3b: by flow step, to its first original step
      const f = flowOf(), n = f.length, next = name === 'next', k = flowIndex(cur);
      const from = k === null ? (next ? -1 : n) : k;
      const fs = f[clamp(from + (next ? 1 : -1), 0, n - 1)];
      go(fs ? fs.first : 0, { go: true });
    }
  }

  function goView(mode, then) {
    const fn = typeof then === 'function' ? then : () => {};
    if (mode === MODE.get()) { fn(); return; }
    if (!MODE.has(mode)) return;
    pending = { mode, then: fn };
    if (window.location) window.location.hash = '#' + mode + (MODE.bare() ? '&bare' : '');
    else MODE.set(mode);
  }
  MODE.onChange(mode => {
    if (sel) update('view');
    const p = pending;
    pending = null;
    if (p && p.mode === mode) p.then();
  });

  // Hash extras (demo hook): read once at load; mode.js reads only the first part (the view) and 'bare'.
  const extras = { seqonly: false };
  ((window.location && window.location.hash) || '').replace(/^#/, '').split('&').slice(1).forEach(x => {
    const k = x.indexOf('=');
    if (k < 0) { if (x === 'seqonly') extras.seqonly = true; return; }
    const key = x.slice(0, k);
    if (['sim', 'step', 'seq', 'present', 'sims', 'stay', 'depth'].indexOf(key) < 0) return;
    try { extras[key] = decodeURIComponent(x.slice(k + 1)); } catch (err) { /* a bad escape: the part is ignored */ }
  });
  // b853 S3a: the start depth = a known &depth= (this window only, not saved), else a known stored value, else 'code'.
  depth = (function () {
    if (DEPTHS.indexOf(extras.depth) >= 0) return extras.depth;
    const v = window.C4PM_STORE.get(DEPTH_KEY);   // storage blocked or nothing saved: null, the default
    return DEPTHS.indexOf(v) >= 0 ? v : 'code';
  })();

  // Keys: capture phase, so this runs before the bubble-phase handlers of controls.js and board.js (QU1 order).
  document.addEventListener('keydown', e => {
    const t = (e && e.target) || {};
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(String(t.tagName || '').toUpperCase()) || t.isContentEditable) return;
    const stop = () => { if (e.stopPropagation) e.stopPropagation(); };
    if (hooks.presentKey && hooks.presentKey(e)) { stop(); return; }
    if (e.key === 'Escape') {
      if (extras.seqonly) { stop(); return; }   // b797: in the sequence-only window Esc does nothing (no clear, no post)
      const MAP = window.C4PM_MAP, BOARD = window.C4PM_BOARD;
      if ((MAP && MAP.selectedId()) || (BOARD && BOARD.selectedId() !== null)) return;   // the c-item / b-item goes first
      if (!sel) return;
      select(null);
      stop();
      return;
    }
    // A held Alt / Meta / Ctrl / Shift leaves the arrows to the browser (Cmd+← = Back, Shift+arrows select text).
    if (sel && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !(e.altKey || e.metaKey || e.ctrlKey || e.shiftKey)) {
      act(e.key === 'ArrowRight' ? 'next' : 'prev');
      if (e.preventDefault) e.preventDefault();
    }
  }, true);

  // Window link: the other windows follow the s-item and the cursor (no fly, no echo). A9.1 wins over UI7's fit on select:
  // a remote select never fits the map (fit: false), a remote go never flies (no opts.go); the camera and view stay.
  if (window.C4PM_LINK) {
    window.C4PM_LINK.on('sim', d => {
      const id = d.sim || null;
      if (id !== sel) select(id, { remote: true, fit: false });
      if (sel && d.step !== cur) go(d.step, { remote: true });
      if (hooks.presentRemote) hooks.presentRemote(d);   // UI17: every message (the leader's may carry a new owner)
    });
  }

  function applyHash() {
    if (extras.sims === 'open' && hooks.openList) hooks.openList();   // not saved
    if (!extras.sim || !byId.has(extras.sim)) return;
    select(extras.sim);
    if (extras.seq && hooks.seq) hooks.seq(true);
    const n = parseInt(extras.step, 10);
    if (n >= 1) go(n - 1, { go: !extras.stay });   // &stay=1: keep this view (the step's own view is not opened)
    const p = parseInt(extras.present, 10);
    if (p >= 1 && hooks.present) hooks.present(extras.sim, p - 1);
  }
  if (extras.sim || extras.sims) {
    const later = () => setTimeout(applyHash, 120);   // after the first fit
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later);
    else later();
  }

  window.C4PM_SIM = {
    items: () => sims,
    byId: id => byId.get(id) || null,
    selected: () => sel,
    step: () => cur,
    steps: stepsOf,
    curStep,
    select, go, act,
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
    notify: what => update(String(what)),
    tableStateAt, rowsTableHtml, nameOf, stepTarget, viewWord, goView, litFor,
    icon, noPlace, nameOfId, personName,
    hash: () => Object.assign({}, extras),
    hooks,
    depth: () => depth,
    setDepth, DEPTHS,
    flow: flowOf, flowIndex, curFlow, lanes,
  };
})();
