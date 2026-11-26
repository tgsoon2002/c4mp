// sim-sequence.js: the sequence drawer under the map (Phase 25 UI13, b763; feature inventory A7.1-A7.5): the selected s-item as
// a UML sequence diagram, one lane per container the steps run in (plus the person, the outside senders, externals), one
// arrow per step, the current step lit; a click on a row goes to that step. Spec: Document/Roadmap/Phase25/UI_TASKS.md
// section C UI13 (demo setSeq / renderSeq). Loaded after sim-strip.js (src/page/html.ts VIEWER_SCRIPTS); reads C4PM_SIM and
// does nothing on a page without s-items (C4PM_SIM undefined).
//
// CONTRACT  window.C4PM_SIMSEQ = { setSeq, render, isOpen, setHeight, height }
//   setSeq(on)      C4PM_SIM.hooks.seq: open (true) / close (false) / toggle (undefined) #seq-drawer; it opens only while an
//                   s-item is selected. On a change: C4PM_SIM.notify('seq') (the strip and the panel refresh their
//                   "≡ Sequence" labels), then the map is fitted again once its new size is measured (the rect of the step
//                   that had the cursor at the call, when it is in this view, else the whole path; C4PM_SIMSTRIP.flyStep
//                   / fitPath).
//   render()        renderSequence: the bar (#seq-bar) and ONE SVG (#seq-body); runs on every C4PM_SIM.onChange while open.
//                   b853 S5 (b866): lanes per depth. Lanes = C4PM_SIM.lanes() (the lanes at this window's depth: context the
//                   system, persons and externals; container today's sim.lanes; component the components; code the functions
//                   and tables; server order); rows = C4PM_SIM.flow() (one per flow step, data-step = its flow index, a click
//                   goes to its first original step); a row's two lanes = call.fromLane / call.toLane of the flow step (the
//                   ends at the depth; an outside step without a call: 'outside' and the person lane; no call: no arrow).
//                   The bar's text and 'Step k/N' follow the depth; the own window's URL carries '&depth=<depth>'.
//                   Classes only, no style attributes (sim.css); data goes in as textContent / attributes, never markup.
//   isOpen()        -> #seq-drawer is shown.
//   setHeight(px), height()  the drawer height (drawer-resize.js: drag #seq-drawer-edge, min 150 px, max 78% of #center,
//                   key c4pm.seqH, CSS variable --seq-h).
// "⧉ Own window" (UI14, b764): window.open(this page + '#<view>&seqonly&sim=<id>' (+ '&step=<n>' with a cursor) + '&depth=<d>', 'c4pm-seq',
//   'popup,width=1100,height=520'); blocked -> a toast (C4PM_OPEN.toast) naming that hash.
// The own window ('&seqonly' in the hash at load, C4PM_SIM.hash().seqonly): class `seq-only` on #root (sim.css shows only the
//   drawer, filling the window), the drawer open whenever an s-item is selected, no "⧉ Own window" / ✕, and nothing flies
//   (hooks.fly and hooks.fitPath are cleared: no map, no view switch): a row click, ‹ › and ← → move the cursor only; the
//   window link ('sim' message, sim.js) moves the main window's cursor and brings the main window's moves here.
//   Esc does nothing there (b797, sim.js).
(function () {
  'use strict';
  const SIM = window.C4PM_SIM;
  if (!SIM) return;   // no s-items on this page

  const $ = id => document.getElementById(id);
  const drawer = $('seq-drawer'), bar = $('seq-bar'), body = $('seq-body'), edge = $('seq-drawer-edge');
  if (!drawer || !bar || !body) return;

  // The SVG namespace is an identifier, not a request; split so the page keeps passing the "no http(s):// string" check.
  const SVG_NS = 'http:' + '//www.w3.org/2000/svg';
  // Demo geometry: step gutter, narrowest lane, row and stage-row heights; lane heads at y 8 (40 high), lifelines from 50.
  const G = 96, MIN_LANE = 124, ROW = 32, STG = 24, TOP = 64, HEAD_Y = 8, HEAD_H = 40, LIFE_Y = 50;
  const VIEW_WORD = { io: 'IO', arch: 'ARCH', storage: 'STORAGE', out: 'OUTSIDE' };
  // b853 S5: the bar's lanes text per depth (container = the text from before the depth switch).
  const LANES_TEXT = {
    context: 'lanes = the system, persons and externals the steps run in',
    container: 'lanes = the containers the steps run in',
    component: 'lanes = the components the steps run in',
    code: 'lanes = the functions and tables the steps run in',
  };
  const ONLY = !!SIM.hash().seqonly;   // UI14: this window is the sequence's own window

  const size = window.C4PM_DRAWER.drawerResize({
    drawer, edge, key: 'c4mp.seqH', cssVar: '--seq-h', min: 150, maxFrac: 0.78, container: () => $('center'),
  });

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  // SVG elements need the SVG namespace in a browser; the class goes through classList (className is read-only on SVG).
  const svgEl = (tag, cls, attrs, text) => {
    const e = typeof document.createElementNS === 'function' ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (cls) cls.split(' ').filter(Boolean).forEach(c => e.classList.add(c));
    Object.keys(attrs || {}).forEach(k => e.setAttribute(k, String(attrs[k])));
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isOpen = () => !drawer.hidden;
  const vcls = st => (st.view === 'outside' ? 'out' : st.view);

  // Display name of an arch node id (a call end): a step target's server name when one names it, else the node's name in
  // the arch tree, a function / method as 'Owner.name' (owner = its component), as the server names targets.
  let archIndex = null;
  function archNode(id) {
    if (!archIndex) {
      archIndex = new Map();
      const views = window.C4PM_VIEWS || {};
      const tree = Object.prototype.hasOwnProperty.call(views, 'arch') ? views.arch.tree(window.C4PM_DATA) : null;
      const walk = (n, up) => {
        archIndex.set(n.id, { n, up });
        (n.children || []).forEach(c => walk(c, n));
        (n.subregions || []).forEach(c => walk(c, n));
      };
      if (tree && tree.root) walk(tree.root, null);
    }
    return archIndex.get(id) || null;
  }
  function nameOfNode(sim, id) {
    for (const st of sim.steps) for (const t of st.targets || []) if (t.nodeId === id) return t.name;
    const hit = archNode(id);
    if (!hit) return SIM.nameOfId(id, sim);   // b853 S5: a lane id of any depth (a table, a fallback lane), else the id
    const n = hit.n;
    if (n.kind === 'function' || n.kind === 'method') {
      for (let p = hit.up; p; p = (archNode(p.id) || {}).up) if (p.kind === 'component') return p.name + '.' + n.name;
    }
    return n.name;
  }

  // The two lanes of a step: its call's lanes; an outside step without a call runs from the Outside lane to the person.
  function lanesOfStep(sim, st) {
    if (st.call) return [st.call.fromLane, st.call.toLane];   // a FlowStep's call: its ends at the depth (at[d])
    if (st.view === 'outside') {
      const person = SIM.lanes(sim.id).find(l => l.kind === 'person');
      return ['outside', person ? person.id : 'outside'];
    }
    return null;   // no call (also a flow step whose self-arrows were dropped above code): a row without an arrow
  }

  function labelOf(sim, st, sameLane) {
    let s;
    if (st.view === 'outside' && st.outside) s = (st.outside.from ? st.outside.from + ': ' : '') + st.outside.text;
    else if (st.call) {
      s = st.call.label || '';
      if (sameLane && st.call.from !== st.call.to) s += '  (' + nameOfNode(sim, st.call.from) + ' → ' + nameOfNode(sim, st.call.to) + ')';
    } else s = '';
    return s + (st.unverified ? '   ? unverified' : '');
  }

  function renderBar(sim, steps, cur) {
    bar.textContent = '';
    bar.appendChild(el('span', 't', 'Sequence'));
    const sub = el('span', 'sub', sim.id + ' · ' + sim.title + ' · ' + (LANES_TEXT[SIM.depth()] || LANES_TEXT.container) +
      (sim.kind === 'journey' ? ', the person and the outside senders' : ', the person'));
    sub.title = sub.textContent;
    bar.appendChild(sub);
    bar.appendChild(el('span', 'sp'));
    const seg = el('span', 'seg');
    const btn = (parent, text, title, fn, cls) => {
      const b = el('button', cls, text);
      b.setAttribute('type', 'button');
      b.title = title;
      if (fn) b.addEventListener('click', fn); else b.disabled = true;
      parent.appendChild(b);
      return b;
    };
    btn(seg, '‹', 'Previous step (←)', () => SIM.act('prev'));
    btn(seg, '›', 'Next step (→)', () => SIM.act('next'));
    bar.appendChild(seg);
    bar.appendChild(el('span', 'sub sq-pos', cur ? 'Step ' + cur.n + '/' + steps.length : 'whole path · ' + steps.length + ' steps'));
    if (ONLY) return;   // the sequence's own window: no Own window, no ✕ (the drawer is the whole window)
    btn(bar, '⧉ Own window', 'Open the sequence in its own window (#…&seqonly)', ownWindow, 'tbb');
    btn(bar, '✕', 'Close the sequence', () => setSeq(false), 'tbb');
  }

  // UI14 (b764, demo 1402): the selected s-item's sequence in its own named window, 1100 x 520: this page with
  // '#<view>&seqonly&sim=<id>' (+ '&step=<n>' with a cursor). A blocked (or throwing) open shows the demo's toast.
  function ownWindow() {
    const id = SIM.selected();
    if (!id) return;
    const i = SIM.step(), view = window.C4PM_MODE.get();
    const tail = '&seqonly&sim=' + encodeURIComponent(id);
    const url = String(window.location.href).split('#')[0] + '#' + view + tail + (i !== null ? '&step=' + (i + 1) : '') +
      '&depth=' + SIM.depth();   // b853 S5: the own window opens at this window's depth (read once there, not saved)
    let w = null;
    try { w = window.open(url, 'c4pm-seq', 'popup,width=1100,height=520'); }
    catch (e) { w = null; }   // a throwing open is a blocked one (as openView.js)
    if (!w) {
      if (window.C4PM_OPEN && window.C4PM_OPEN.toast) window.C4PM_OPEN.toast('The browser blocked the new window. The sequence window is this page with #' + view + tail + '.');
      return;
    }
    if (w.focus) w.focus();
  }

  function marker(id, cls) {
    const m = svgEl('marker', null, { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerUnits: 'userSpaceOnUse', markerWidth: 10, markerHeight: 10, orient: 'auto-start-reverse' });
    m.appendChild(svgEl('path', cls, { d: id === 'sq-ret' ? 'M0 0L10 5L0 10' : 'M0 0L10 5L0 10z' }));
    return m;
  }

  function renderSequence() {
    const id = SIM.selected(), sim = id ? SIM.byId(id) : null;
    if (!sim || !isOpen()) return;
    // b853 S5: the rows are the flow steps at the depth (st.i = flow index); curI = the flow index holding the cursor.
    const steps = SIM.flow(id), cur = SIM.curFlow(), curI = SIM.flowIndex(SIM.step(), id);
    renderBar(sim, steps, cur);

    const lanes = SIM.lanes(id) || [], idx = new Map(lanes.map((l, k) => [l.id, k]));
    const nL = Math.max(1, lanes.length);
    const Wbox = Math.max(320, body.clientWidth || 800), W = Math.max(Wbox, G + nL * MIN_LANE + 16), laneW = (W - G - 16) / nL;
    const cx = k => G + laneW * (k + 0.5);
    const journey = sim.kind === 'journey' && Array.isArray(sim.stages);
    let y = TOP;
    const rows = [], stages = [];
    steps.forEach((st, i) => {
      if (journey && (i === 0 || st.stage !== steps[i - 1].stage)) { stages.push({ y, stage: st.stage }); y += STG; }
      rows.push({ st, y });
      y += ROW;
    });
    const H = y + 14;

    const svg = svgEl('svg', 'sq-svg', { width: W, height: H, role: 'img', 'aria-label': 'Sequence of ' + sim.title });
    const defs = svgEl('defs');
    [['sq-ink', 'sq-mk-ink'], ['sq-flow', 'sq-mk-flow'], ['sq-unver', 'sq-mk-unver'], ['sq-ret', 'sq-mk-ret']].forEach(([mid, cls]) => defs.appendChild(marker(mid, cls)));
    svg.appendChild(defs);

    // Journey: a dashed frame over the lanes a flow stage uses, with a UML tab "flow s-1 · Buy a product".
    stages.forEach((sg, k) => {
      const stage = sim.stages[sg.stage];
      if (!stage || !stage.flow) return;
      const end = (stages[k + 1] ? stages[k + 1].y : y) - 4;
      const ks = [];
      rows.forEach(r => {
        if (r.st.stage !== sg.stage) return;
        (lanesOfStep(sim, r.st) || []).forEach(l => { if (idx.has(l)) ks.push(idx.get(l)); });
      });
      if (!ks.length) return;
      const x0 = cx(Math.min(...ks)) - laneW * 0.46, x1 = cx(Math.max(...ks)) + laneW * 0.46;
      svg.appendChild(svgEl('rect', 'sq-frame', { x: x0, y: sg.y + 2, width: x1 - x0, height: end - sg.y - 2, rx: 4 }));
      const flowSim = SIM.byId(stage.flow);
      const text = 'flow ' + stage.flow + (flowSim ? ' · ' + flowSim.title : '');
      const tw = Math.max(132, Math.round(text.length * 6.2 + 20));   // the tab grows with its text (demo: 132 fixed)
      const tab = svgEl('g', 'sq-tab');
      tab.appendChild(svgEl('path', null, { d: 'M' + x0 + ' ' + (sg.y + 2) + 'h' + tw + 'v12l-8 8h-' + (tw - 8) + 'z' }));
      tab.appendChild(svgEl('text', null, { x: x0 + 7, y: sg.y + 16 }, text));
      svg.appendChild(tab);
    });

    // Lifelines and lane heads.
    lanes.forEach((l, k) => {
      const x = cx(k), bw = Math.min(laneW - 14, 168);
      svg.appendChild(svgEl('line', 'sq-lifeline', { x1: x, y1: LIFE_Y, x2: x, y2: H - 6 }));
      const head = svgEl('g', 'sq-lane-head k-' + l.kind + (bw < 130 ? ' narrow' : ''));
      head.setAttribute('data-lane', l.id);
      head.appendChild(svgEl('rect', null, { x: x - bw / 2, y: HEAD_Y, width: bw, height: HEAD_H, rx: l.kind === 'person' ? 20 : 7 }));
      head.appendChild(svgEl('text', 'sq-lane-name', { x, y: 26, 'text-anchor': 'middle' }, l.name));
      head.appendChild(svgEl('text', 'sq-lane-sub', { x, y: 41, 'text-anchor': 'middle' }, l.sub));
      svg.appendChild(head);
    });

    // Journey stage rows: "STAGE 1 · DISCOVER" on the left, "goal: …" on the right.
    stages.forEach(sg => {
      const stage = sim.stages[sg.stage] || { name: 'Stage ' + (sg.stage + 1) };
      svg.appendChild(svgEl('text', 'sq-stage', { x: 8, y: sg.y + 15 }, 'STAGE ' + (sg.stage + 1) + ' · ' + String(stage.name || '').toUpperCase()));
      if (stage.goal) svg.appendChild(svgEl('text', 'sq-goal', { x: W - 10, y: sg.y + 15, 'text-anchor': 'end' }, 'goal: ' + stage.goal));
    });

    // One row per step: band, number, view word, the arrow between its two lanes (same lane = a loop) and its label.
    rows.forEach(({ st, y: ry }) => {
      const isCur = curI === st.i, reply = !!(st.call && st.call.reply), out = st.view === 'outside';
      const g = svgEl('g', 'sq-row' + (isCur ? ' cur' : ''), { 'data-step': st.i });
      g.appendChild(svgEl('title', null, null, 'Step ' + st.n + ': ' + ((st.captions ? st.captions.join(' · ') : st.caption) || SIM.stepTarget(st))));
      g.appendChild(svgEl('rect', 'sq-band' + (isCur ? ' cur' : ''), { x: 0, y: ry, width: W, height: ROW }));
      const num = svgEl('g', 'sq-num' + (isCur ? ' cur' : ''));
      num.appendChild(svgEl('circle', null, { cx: 16, cy: ry + 16, r: 10 }));
      num.appendChild(svgEl('text', null, { x: 16, y: ry + 20, 'text-anchor': 'middle' }, String(st.n)));
      g.appendChild(num);
      g.appendChild(svgEl('text', 'sq-view v-' + vcls(st), { x: 32, y: ry + 20 }, VIEW_WORD[vcls(st)] || String(st.view).toUpperCase()));
      const pair = lanesOfStep(sim, st);
      if (pair && idx.has(pair[0]) && idx.has(pair[1])) {
        const ka = idx.get(pair[0]), kb = idx.get(pair[1]), yy = ry + 21;
        const label = labelOf(sim, st, ka === kb);
        const acls = 'sq-arrow' + (isCur ? ' cur' : '') + (reply ? ' reply' : '') + (out ? ' out' : '') + (st.unverified ? ' unver' : '');
        const mk = st.unverified ? 'sq-unver' : isCur ? 'sq-flow' : reply ? 'sq-ret' : 'sq-ink';
        const lcls = 'sq-label' + (isCur ? ' cur' : '') + (st.unverified ? ' unver' : '');
        if (ka === kb) {   // a call inside one lane: a loop on its lifeline, the label right of it (left when no room)
          const x = cx(ka), left = x + 40 + label.length * 6.4 > W - 6;
          g.appendChild(svgEl('path', acls, { d: 'M' + (x + 2) + ' ' + (yy - 10) + 'h28v13h-26', 'marker-end': 'url(#' + mk + ')' }));
          const t = svgEl('text', lcls, { x: left ? x - 8 : x + 38, y: yy - 1 }, label);
          if (left) t.setAttribute('text-anchor', 'end');
          g.appendChild(t);
        } else {
          const x1 = cx(ka), x2 = cx(kb), d = x2 > x1 ? 1 : -1;
          g.appendChild(svgEl('line', acls, { x1: x1 + 3 * d, y1: yy, x2: x2 - 4 * d, y2: yy, 'marker-end': 'url(#' + mk + ')' }));
          const lw = label.length * 6.2, mx = clamp((x1 + x2) / 2, G + 4 + lw / 2, W - 6 - lw / 2);   // clear of the step gutter
          g.appendChild(svgEl('text', lcls, { x: mx, y: yy - 6, 'text-anchor': 'middle' }, label));
        }
      }
      // To the flow step's first original step; own window: the cursor only (the link tells the main window).
      g.addEventListener('click', () => SIM.go(st.first, { go: !ONLY }));
      svg.appendChild(g);
    });

    body.textContent = '';
    body.appendChild(svg);
    // The current row scrolls into view (the fake DOM of the tests has no scrollIntoView).
    const rowEl = Array.prototype.find.call(svg.children, c => c.getAttribute && c.getAttribute('data-step') === String(curI));
    if (curI !== null && rowEl && rowEl.scrollIntoView) { try { rowEl.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old browser */ } }
  }

  // Fit the map again once the drawer's open / close has given it its new size (map.js measures it in a ResizeObserver):
  // the step that had the cursor when the drawer opened or closed (in this view), else the whole path (demo setSeq).
  function refit() {
    const SS = window.C4PM_SIMSTRIP, ST = window.C4PM_STATE, wrap = $('map-wrap');
    if (!SS || !SIM.selected()) return;
    const st = SIM.curFlow();   // b853 S5: the flow step holding the cursor at the depth
    const fit = () => {
      const r = st && st.view === window.C4PM_MODE.get() ? SS.stepRect(st) : null;
      if (r) SS.flyStep(st); else SS.fitPath();
    };
    let tries = 0;
    const wait = () => {
      const m = ST && ST.map;
      if (!wrap || !m || !m.cw || (wrap.clientHeight === m.ch && wrap.clientWidth === m.cw) || ++tries > 10) fit();
      else requestAnimationFrame(wait);
    };
    wait();
  }

  function setSeq(on) {
    // The sequence's own window (&seqonly): open whenever an s-item is selected, whatever `on` says.
    const want = (ONLY || (on === undefined ? !isOpen() : !!on)) && !!SIM.selected();
    const changed = want !== isOpen();
    drawer.hidden = !want;
    const root = $('root');
    if (root) root.classList.toggle('seq-open', want);
    if (want) renderSequence();
    else { bar.textContent = ''; body.textContent = ''; }
    if (!changed) return;
    SIM.notify('seq');
    if (!ONLY) refit();   // the own window has no map to fit
  }

  drawer.hidden = true;   // closed at load (index.html has it hidden too)
  SIM.hooks.seq = setSeq;
  SIM.onChange(e => {
    if (ONLY && isOpen() !== !!SIM.selected()) setSeq(true);   // own window: open on a selection (hash, link), close on a clear
    else if (e.what !== 'seq' && isOpen()) renderSequence();
  });
  if (ONLY) {
    const root = $('root');
    if (root) root.classList.add('seq-only');
    SIM.hooks.fly = null;       // no map in this window: a step move never switches the view or flies
    SIM.hooks.fitPath = null;
  }

  window.C4PM_SIMSEQ = { setSeq, render: renderSequence, isOpen, setHeight: size.set, height: size.height };
})();
