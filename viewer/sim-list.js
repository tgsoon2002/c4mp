// sim-list.js: the Simulations section at the bottom of the left column (Phase 25 UI5, b755), and the tree rows the selected
// s-item lights in the current view. Spec: Document/Roadmap/Phase25/UI_TASKS.md section C UI5 and A1.1-A1.9.
// Loaded after sim.js (src/page/html.ts VIEWER_SCRIPTS).
// A page without s-items: the section shows 'Simulations (0)' and how to add one; nothing else.
// (window.C4PM_SIM undefined: the same section with div.sims-empty "No simulations yet. ..." then the foot; the head toggles and
// saves as below; no search provider, no hooks, no tree flags, no hint tail.)
//
// DOM (built by JS, the last child of #left; #left gets class has-sims so only the tab body and the section body scroll):
//   section#sims > button#sims-head (span.lt-twist, span#sims-title "Simulations (N)", span#sims-sel "· s-1 Title" when closed
//   with an s-item selected) + div#sims-body (one div.lt-row.lt-sim per s-item: span.sim-ico, span.lt-name, span.lt-flag
//   "N steps", span.lt-flag.unver "? N" when N steps are unverified, button.lt-play ▶; then div.sims-foot).
// Open state: localStorage 'c4mp.simsOpen' = 'open' | 'closed' (default closed; read and written through C4PM_STORE, which also reads the old 'c4pm.simsOpen'). Selecting an
// s-item opens the section without saving it, and scrolls its row into view; C4PM_SIM.hooks.openList opens it the same way.
// Row click selects / unselects; ▶ calls C4PM_SIM.hooks.present(id, 0) (UI12).
// Tree rows (C4PM_TREE.decorate): a row whose data-id is in C4PM_STATE.map.sim.ids gets class sim-lit and a flag
// span.lt-flag.sim-steps "step 1 · 2"; redecorated on every s-item change and every view change.
// Hint: C4PM_CONTROLS.setHintTail(HINT_TAIL) on load.
(function () {
  'use strict';
  const SIM = window.C4PM_SIM;   // undefined on a page without s-items: the section only (see the end of this file)

  const KEY = 'c4mp.simsOpen';
  const EMPTY = 'No simulations yet. Add one with c4mp sim add (or ask an AI agent through the MCP sim tools).';
  const HINT_TAIL = 'Esc: clear the selection, then the simulation\nSimulations (bottom left): select = path · ▶ = present';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function readOpen() {
    return window.C4PM_STORE.get(KEY) === 'open';   // storage blocked or nothing saved: closed
  }
  function saveOpen(v) {
    window.C4PM_STORE.set(KEY, v ? 'open' : 'closed');   // storage blocked: the state lasts for this page only
  }

  let open = readOpen();
  let els = null;   // { section, head, twist, title, sel, body } once built

  // Fill the head and (open) the rows from C4PM_SIM; reveal = scroll the selected row into view.
  function renderSimList(reveal) {
    if (!els) return;
    const sims = SIM ? SIM.items() : [], sel = SIM ? SIM.selected() : null, selSim = sel ? SIM.byId(sel) : null;
    els.title.textContent = 'Simulations (' + sims.length + ')';
    els.sel.textContent = !open && selSim ? '· ' + selSim.id + ' ' + selSim.title : '';
    els.head.setAttribute('aria-expanded', String(open));
    els.twist.textContent = open ? '▾' : '▸';
    els.head.title = open ? 'Close the Simulations section' : 'Open the Simulations section: flows and journeys across the IO, Architecture and Storage views';
    els.body.hidden = !open;
    els.body.textContent = '';
    if (!open) return;
    if (!sims.length) els.body.appendChild(el('div', 'sims-empty', EMPTY));
    let selRow = null;
    sims.forEach(s => {
      const steps = s.steps || [], unv = steps.filter(x => x.unverified).length;
      const row = el('div', 'lt-row lt-sim' + (sel === s.id ? ' selected' : ''));
      row.dataset.sim = s.id;
      row.title = s.id + ' · ' + s.kind + (s.description ? ' · ' + s.description : '');
      const ic = el('span', 'sim-ico');
      ic.innerHTML = SIM.icon(s.kind);   // a constant of sim.js, never data
      ic.title = s.kind;
      row.appendChild(ic);
      row.appendChild(el('span', 'lt-name', s.title));
      const fl = el('span', 'lt-flag', steps.length + ' steps');
      fl.title = s.kind === 'journey'
        ? 'journey: ' + (s.stages || []).length + ' stages, ' + steps.length + ' steps (the flow stage plays inline)'
        : 'flow: ' + steps.length + ' steps';
      row.appendChild(fl);
      if (unv) {
        const f = el('span', 'lt-flag unver', '? ' + unv);
        f.title = unv + ' step' + (unv > 1 ? 's' : '') + ' unverified (sim-step-unverified, info): no resolved call in the code';
        row.appendChild(f);
      }
      const pb = el('button', 'lt-play', '▶');
      pb.type = 'button';
      pb.title = 'Present ' + s.title + ' (flies through its steps)';
      pb.setAttribute('aria-label', pb.title);
      pb.onclick = ev => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (SIM.hooks.present) SIM.hooks.present(s.id, 0);
      };
      row.appendChild(pb);
      row.onclick = () => SIM.select(SIM.selected() === s.id ? null : s.id);
      if (sel === s.id) selRow = row;
      els.body.appendChild(row);
    });
    // The folder: from the first s-item's file; no s-item (the page has no file to read it from): the generic project path.
    const dir = sims[0] && typeof sims[0].file === 'string' ? sims[0].file.replace(/[^/]*$/, '') : '';
    const where = dir || (sims.length ? 'the sim/ folder of the project' : '.c4pm/projects/<project>/sim/');
    els.body.appendChild(el('div', 'sims-foot', 's-items live in ' + where + ' · written on demand (AI or by hand), never by a scan'));
    if (reveal && selRow && selRow.scrollIntoView) selRow.scrollIntoView({ block: 'nearest' });
  }

  // Open the section for this page only (a selection, the hash's sims=open): not saved.
  function openList(reveal) {
    open = true;
    renderSimList(reveal);
  }

  // Tree row decorator: idempotent (removes its class and flag, then adds them when the row's node is lit in this view).
  function litRow(row, node) {
    row.classList.remove('sim-lit');
    row.querySelectorAll('.sim-steps').forEach(f => row.removeChild(f));
    const ST = window.C4PM_STATE, lit = ST && ST.map.sim && ST.map.sim.ids;
    const e = lit && node && lit.get(node.id);
    if (!e) return;
    row.classList.add('sim-lit');
    row.appendChild(el('span', 'lt-flag sim-steps', 'step ' + e.ns.join(' · ')));
  }
  const redecorate = () => { if (window.C4PM_TREE && window.C4PM_TREE.redecorate) window.C4PM_TREE.redecorate(); };

  // The section itself, the same DOM with or without s-items: head (toggles and saves the open state) + body. False without #left.
  function buildSection() {
    const left = document.getElementById('left');
    if (!left) return false;
    const section = el('section');
    section.id = 'sims';
    section.setAttribute('aria-label', 'Simulations');
    const head = el('button');
    head.id = 'sims-head';
    head.type = 'button';
    head.setAttribute('aria-controls', 'sims-body');
    const twist = el('span', 'lt-twist');
    const title = el('span');
    title.id = 'sims-title';
    const sel = el('span');
    sel.id = 'sims-sel';
    head.appendChild(twist);
    head.appendChild(title);
    head.appendChild(sel);
    const body = el('div');
    body.id = 'sims-body';
    section.appendChild(head);
    section.appendChild(body);
    left.appendChild(section);
    left.classList.add('has-sims');
    els = { section, head, twist, title, sel, body };
    head.onclick = () => {
      open = !open;
      saveOpen(open);
      renderSimList(true);
    };
    renderSimList(false);
    return true;
  }

  // A page with s-items: the section, then the tree row flags and the hint tail.
  function build() {
    if (!buildSection()) return;
    if (window.C4PM_TREE && window.C4PM_TREE.decorate) window.C4PM_TREE.decorate(litRow);
    if (window.C4PM_MODE) window.C4PM_MODE.onChange(redecorate);
    const CT = window.C4PM_CONTROLS;
    if (CT && CT.setHintTail) CT.setHintTail(HINT_TAIL);
  }

  // After tree.js has built #left (its DOMContentLoaded listener was added first, so it runs first).
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // No s-items: the section only ("Simulations (0)" and how to add one); no search provider, hooks, flags or hint tail.
  if (!SIM) {
    whenReady(buildSection);
    return;
  }

  // UI6 (b756): the search box finds s-items by id, title and kind. A `first` provider of search.js: its rows come BEFORE the map
  // rows, so Enter takes the s-item. Row "Buy a product" / "s-item · flow · s-1" (classes only); a pick selects the s-item.
  // Content: none (an s-item holds no source text).
  function searchRow(s) {
    const b = el('button', 'pn-search-result sim-search-result');
    b.type = 'button';
    b.appendChild(el('div', 'pn-search-name', s.title));
    b.appendChild(el('div', 'pn-search-detail', 's-item · ' + s.kind + ' · ' + s.id));
    return { el: b, pick: () => SIM.select(s.id) };
  }
  const SEARCH = window.C4PM_SEARCH;   // set up by panel.js (search.js) before this file runs; absent in a page without a search box
  if (SEARCH && SEARCH.registerSearchProvider) SEARCH.registerSearchProvider({
    id: 'sims',
    first: true,
    names: q => SIM.items().filter(s => (s.id + ' ' + s.title + ' ' + s.kind).toLowerCase().includes(q)).map(searchRow),
    content: () => [],
  });

  SIM.hooks.openList = () => openList(true);
  SIM.onChange(e => {
    if (e.what === 'select' && e.sim && !open) openList(true);   // the section opens so the selected row shows (not saved)
    else renderSimList(e.what === 'select');
    redecorate();
  });

  whenReady(build);
})();
