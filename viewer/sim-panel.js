// sim-panel.js: the right panel (#panel) of a selected s-item, its step cards, and the "In simulations" section of a c-item
// (Phase 25 UI10, b760). Spec: Document/Roadmap/Phase25/UI_TASKS.md section C UI10 and A5.1-A5.6 (demo simPanelHtml,
// stepCard, inSimsHtml). Loaded after sim-list.js (src/page/html.ts VIEWER_SCRIPTS). A page without s-items
// (window.C4PM_SIM undefined) or without a map: nothing happens. panel.js is not edited: this file writes into #panel after
// panel.js has drawn (its listeners were registered first), as board-panel.js does.
//
// CONTRACT (nothing exported; the functions below are this file's own)
//   renderSimPanel(panel, sim)  clear `panel` and fill it with the s-item: crumbs [s-item] Simulations › "s-1 · <file>";
//                   header title + kind word (Flow / Journey, upper case by .pn-kind) + description; buttons ▶ Present,
//                   ≡ Sequence / ≡ Close sequence (open = #seq-drawer shown, UI13), ✕ Clear (C4PM_SIM.act); pills "N steps",
//                   ("N stages"), "views: IO · Architecture · Storage", ("person: <name>"); the unverified note (dashed,
//                   .pn-note.info) when a step is unverified; the cursor note when there is a step cursor; section
//                   "Steps (click one to go there)" (journeys: a stage header before each stage's first step); section
//                   "Stored as" (file, kind, id).
//   stepCard(step, sim)  -> div.st-card (+ cur: a step of the cursor's flow step at the depth of the selected s-item (b853: every
//                   card of a merged step; at code the cursor's step), unver: an unverified step, inflow: a
//                   step played inside a journey's flow stage): number, view chip, target, "? unverified" chip; the call line
//                   "A → B · label" (or the outside text); caption; "state: <b>"; the step's unconnected / missing notes
//                   (small, muted, .st-note); the rows tables of the step's records (C4PM_SIM.rowsTableHtml, escaped there).
//                   Click: selects that s-item when it is not the selected one, then C4PM_SIM.go(step.i, { go: true }).
//   inSimsSection(node)  -> the section "In simulations (N steps)" with one chip "s-1 · step 3" (tooltip "title: caption")
//                   per step of any s-item that touches `node` in the current view, or null when none does. Touches = a
//                   target drawn in this view, (arch) an end of the step's call, (storage) a record of the step's rows, that
//                   is the node or lies inside it (C4PM_RENDER.edges.within). Chip click = as a card click.
// Take-over: on every C4PM_SIM change, with an s-item selected and no c-item selected (C4PM_MAP.selectedId() null) the panel
// is the s-item; clearing the s-item with no c-item selected runs C4PM_MAP.select(null) (panel.js shows the summary). On
// C4PM_MAP.onSelect: null with an s-item selected -> the s-item again (a cleared c-item, a view change); a node -> the
// "In simulations" section is appended to the c-item's panel.
// Text: every name, caption, state, message and value goes in through textContent (the rows tables are built escaped by sim.js).
(function () {
  'use strict';
  const SIM = window.C4PM_SIM;
  const MAP = window.C4PM_MAP;
  if (!SIM || !MAP) return;   // no s-items (or no map): the panel is untouched

  const UNVER_TAIL = 'The step stays; it is drawn dashed until the code has the call.';
  const CURSOR_TAIL = 'Every view, the path strip and the sequence show this step; ← → move it, "All" in the strip shows the whole path.';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Same markup as panelKit.js section(): the label line; the caller appends the content.
  function section(labelText) {
    const sec = el('div', 'pn-section');
    const label = el('div', 'pn-label');
    label.appendChild(el('span', null, labelText));
    sec.appendChild(label);
    return sec;
  }

  const viewCls = st => (st.view === 'outside' ? 'out' : st.view);
  const noDot = s => String(s).replace(/\.\s*$/, '');
  const noPlace = SIM.noPlace;     // the check message without its own place (sim.js, shared with present mode)
  const nameOfId = SIM.nameOfId;   // arch node / lane id -> display name (sim.js)

  // Click on a card or a chip: that s-item (selected when it is not), then its step with the fly.
  function goTo(simId, i) {
    if (SIM.selected() !== simId) SIM.select(simId);
    SIM.go(i, { go: true });
  }

  function stepCard(st, sim) {
    // b853 (K Q9): the original cards stay; every card of the cursor's flow step (at the depth) is cur
    const cur = SIM.selected() === sim.id && SIM.step() !== null && SIM.flowIndex(SIM.step()) === SIM.flowIndex(st.i);
    const card = el('div', 'st-card' + (cur ? ' cur' : '') + (st.unverified ? ' unver' : '') + (st.flow ? ' inflow' : ''));
    card.dataset.sim = sim.id;
    card.dataset.step = String(st.i);
    card.title = 'Go to step ' + st.n;
    const top = el('div', 'st-top');
    top.appendChild(el('span', 'st-n', String(st.n)));
    const out = st.view === 'outside' ? st.outside || { text: '', from: null, channel: null } : null;
    top.appendChild(el('span', 'vchip ' + viewCls(st), out ? 'outside' + (out.channel ? ' · ' + out.channel : '') : SIM.viewWord(st.view)));
    const tgt = out ? out.from : SIM.stepTarget(st);
    if (tgt) top.appendChild(el('span', 'st-tgt', tgt));
    if (st.unverified) {
      const u = el('span', 'vchip unver', '? unverified');
      u.title = noPlace(st.unverified);
      top.appendChild(u);
    }
    card.appendChild(top);
    if (out) {
      if (out.text) card.appendChild(el('div', 'st-state', out.text));
    } else if (st.call) {
      card.appendChild(el('div', 'st-state', nameOfId(st.call.from, sim) + ' → ' + nameOfId(st.call.to, sim) + (st.call.label ? ' · ' + st.call.label : '')));
    }
    if (st.caption) card.appendChild(el('div', 'st-cap', st.caption));
    if (st.state) {
      const s = el('div', 'st-state', 'state: ');
      s.appendChild(el('b', null, st.state));
      card.appendChild(s);
    }
    if (st.unconnected) card.appendChild(el('div', 'st-note', 'sim-step-unconnected: ' + noPlace(st.unconnected)));
    if (st.missing && st.missing.length) card.appendChild(el('div', 'st-note', 'sim-target-missing: ' + st.missing.map(noPlace).join(', ')));
    if (st.rows && st.rows.length) {
      const html = SIM.rowsTableHtml(SIM.tableStateAt(sim.id, st.i), st.rows.map(r => r.recordId).filter(Boolean));
      if (html) {
        const box = el('div', 'st-rows');
        box.innerHTML = html;   // built by sim.js rowsTableHtml: every value escaped
        card.appendChild(box);
      }
    }
    card.addEventListener('click', () => goTo(sim.id, st.i));
    return card;
  }

  function stageHead(sim, k) {
    const sg = (sim.stages || [])[k] || { kind: 'step', name: '' };
    let text = 'Stage ' + (k + 1);
    if (sg.name && sg.name !== text) text += ' · ' + sg.name;
    if (sg.kind === 'flow' && sg.flow) text += ' · flow ' + sg.flow;
    else if (sg.kind === 'outside') text += ' · outside';
    const head = el('div', 'st-stage', text);
    if (sg.goal) head.appendChild(el('span', 'goal', 'goal: ' + sg.goal));
    return head;
  }

  function seqOpen() {
    const d = document.getElementById('seq-drawer');   // UI13 (sim-sequence.js); absent before it
    return !!(d && !d.hidden);
  }

  function renderSimPanel(panel, sim) {
    panel.innerHTML = '';
    const steps = sim.steps || [];

    const crumbs = el('div', 'pn-breadcrumb');
    crumbs.appendChild(el('span', 'pn-crumb-chip', 's-item'));
    crumbs.appendChild(el('span', null, 'Simulations'));
    crumbs.appendChild(el('span', 'pn-sep', '›'));
    crumbs.appendChild(el('span', null, sim.id + ' · ' + sim.file));
    panel.appendChild(crumbs);

    const header = el('div', 'pn-header');
    const h2 = el('h2', null, sim.title);
    h2.appendChild(el('span', 'pn-kind', sim.kind === 'journey' ? 'Journey' : 'Flow'));
    header.appendChild(h2);
    if (sim.description) header.appendChild(el('div', 'pn-detail', sim.description));
    panel.appendChild(header);

    const btns = el('div', 'pbtns');
    [['▶ Present', 'present', 'pbtn main'], [seqOpen() ? '≡ Close sequence' : '≡ Sequence', 'seq', 'pbtn'], ['✕ Clear', 'clear', 'pbtn']].forEach(([t, act, cls]) => {
      const b = el('button', cls, t);
      b.type = 'button';
      b.dataset.act = act;
      b.addEventListener('click', () => {
        SIM.act(act);
        if (act === 'seq') refresh();   // the label follows the drawer
      });
      btns.appendChild(b);
    });
    panel.appendChild(btns);

    const pills = el('div', 'pn-meta-pills');
    const pill = t => pills.appendChild(el('span', 'pn-badge', t));
    pill(steps.length + ' steps');
    if (sim.kind === 'journey') pill((sim.stages || []).length + ' stages');
    if ((sim.views || []).length) pill('views: ' + sim.views.map(v => SIM.viewWord(v)).join(' · '));
    const person = SIM.personName(sim);
    if (person) pill('person: ' + person);
    panel.appendChild(pills);

    const unv = steps.filter(x => x.unverified);
    if (unv.length) {
      panel.appendChild(el('div', 'pn-note info', 'sim-step-unverified (info): ' + unv.map(x => 'step ' + x.n + ': ' + noDot(noPlace(x.unverified))).join('; ') + '. ' + UNVER_TAIL));
    }
    const cur = SIM.selected() === sim.id ? SIM.curStep() : null;
    if (cur) panel.appendChild(el('div', 'pn-note', 'Step cursor: step ' + cur.n + ' of ' + steps.length + '. ' + CURSOR_TAIL));

    const stepsSec = section('Steps (click one to go there)');
    const list = el('div', 'st-list');
    let lastStage = -1;
    steps.forEach(st => {
      if (sim.kind === 'journey' && st.stage !== lastStage) {
        lastStage = st.stage;
        list.appendChild(stageHead(sim, st.stage));
      }
      list.appendChild(stepCard(st, sim));
    });
    stepsSec.appendChild(list);
    panel.appendChild(stepsSec);

    const stored = section('Stored as');
    const rows = el('div', 'pn-rows');
    [['file', sim.file], ['kind', sim.kind], ['id', sim.id]].forEach(([k, v]) => {
      const r = el('div', 'pn-row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', v));
      rows.appendChild(r);
    });
    stored.appendChild(rows);
    panel.appendChild(stored);
  }

  // Ids a step touches in view `mode` (the same ids litFor lights for the selected s-item).
  function idsIn(st, mode) {
    if (st.view === 'outside') return [];
    const ids = st.targets.filter(t => t.view === mode).map(t => t.nodeId);
    if (mode === 'arch' && st.call) ids.push(st.call.from, st.call.to);
    if (mode === 'storage' && st.rows) st.rows.forEach(r => ids.push(r.recordId));
    return ids.filter(Boolean);
  }

  function inSimsSection(node) {
    const RD = window.C4PM_RENDER, mode = window.C4PM_MODE ? window.C4PM_MODE.get() : 'arch';
    if (!node || !RD) return null;
    const hits = [];
    SIM.items().forEach(sim => (sim.steps || []).forEach(st => {
      if (idsIn(st, mode).some(id => RD.edges.within(id, node.id))) hits.push({ sim, st });
    }));
    if (!hits.length) return null;
    const sec = section('In simulations (' + hits.length + ' steps)');
    const row = el('div', 'pn-deps');
    hits.forEach(({ sim, st }) => {
      const b = el('button', 'pn-dep-chip', sim.id + ' · step ' + st.n);
      b.type = 'button';
      b.title = sim.title + ': ' + (st.caption || '');
      b.addEventListener('click', () => goTo(sim.id, st.i));
      row.appendChild(b);
    });
    sec.appendChild(row);
    return sec;
  }

  // The s-item fills the panel when one is selected and no c-item is.
  function refresh() {
    const panel = document.getElementById('panel'), id = SIM.selected();
    if (!panel || !id || MAP.selectedId()) return;
    renderSimPanel(panel, SIM.byId(id));
  }

  SIM.onChange(e => {
    if (MAP.selectedId()) return;   // a c-item's panel stays
    if (e.sim) refresh();
    else if (e.what === 'select') MAP.select(null);   // cleared: panel.js shows the summary
  });

  MAP.onSelect(node => {
    if (!node) { refresh(); return; }
    const panel = document.getElementById('panel');
    const sec = panel && inSimsSection(node);
    if (sec) panel.appendChild(sec);
  });
})();
