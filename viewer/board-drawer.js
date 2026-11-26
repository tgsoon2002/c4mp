// board-drawer.js: the board drawer under the map (P16-B28b). Opens, closes, minimizes, resizes; board
// select and one tab per registered view; calls C4PM_BOARD.views[view](#board-drawer-body, entry) on every change.
// Also fills the chip in the top bar (#board-chips). The map redraws by itself (ResizeObserver on #map-wrap).
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  if (!B || !window.C4PM_MAP) return;   // no board: nothing to do

  const $ = id => document.getElementById(id);
  const drawer = $('board-drawer');
  const bar = $('board-drawer-bar');
  const edge = $('board-drawer-edge');
  const body = $('board-drawer-body');
  const chips = $('board-chips');
  if (!drawer || !bar || !body) return;

  const KEY_H = 'c4mp.boardH';
  const MIN_H = 120;
  const MAX_FRAC = 0.78;
  const VIEW_ORDER = ['timeline', 'kanban', 'list', 'dashboard'];
  const VIEW_LABEL = { timeline: 'Timeline', kanban: 'Kanban', list: 'List', dashboard: 'Dashboard' };
  const VIEW_HINT = {
    timeline: 'bar = start → due · diamond = one day · dashed = planned · red edge = overdue · arrow = depends on · click a phase name to collapse it',
    kanban: 'click a column head to collapse it · drag a card to another group · drag a head to reorder',
    list: 'click a row to light up its c-items · double-click to zoom the map to them',
    dashboard: 'counts per status, kind and owner',
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---- the bar (built once; the tabs are rebuilt on every render because views register after this file loads) ----
  const title = el('strong', null, 'Board');
  const select = el('select');
  select.setAttribute('aria-label', 'Board');
  B.boards().forEach(b => {
    const o = el('option', null, b.name);   // textContent: a board name is never markup
    o.value = b.id;
    select.appendChild(o);
  });
  const tabs = el('span', 'bd-seg');
  tabs.setAttribute('role', 'tablist');
  const slotKanban = el('span', 'bd-slot');    // the Kanban view puts "+ Group" here
  slotKanban.id = 'board-slot-kanban';
  const slotTimeline = el('span', 'bd-slot');  // the Timeline view puts "- +" (zoom) here
  slotTimeline.id = 'board-slot-timeline';
  const hint = el('span', 'bd-hint');
  const btnMin = el('button', null, '▾');
  btnMin.type = 'button';
  btnMin.title = 'Minimize / restore the board';
  const btnClose = el('button', null, '×');
  btnClose.type = 'button';
  btnClose.title = 'Close the board';
  const end = el('span', 'bd-end');
  end.appendChild(btnMin);
  end.appendChild(btnClose);
  [title, select, tabs, slotKanban, slotTimeline, hint, end].forEach(n => bar.appendChild(n));

  let minimized = false;

  select.addEventListener('change', () => {
    B.setBoard(select.value);
    // a selected b-item of another board is deselected (as in the demo)
    const sel = B.selectedId();
    const e = sel && B.entryOf(sel);
    if (e && e.id !== B.boardId()) B.select(null);
  });
  btnMin.addEventListener('click', () => setMinimized(!minimized));
  btnClose.addEventListener('click', () => B.close());

  // ---- height (drag the top edge). --board-h on #board-drawer; default 46% (style.css) until set. The drag, the clamp
  // (min 120 px, max 78% of #center) and the stored key are drawer-resize.js (shared with the sequence drawer, UI13) ----
  const size = window.C4PM_DRAWER.drawerResize({
    drawer, edge, key: KEY_H, cssVar: '--board-h', min: MIN_H, maxFrac: MAX_FRAC,
    container: () => $('center'), enabled: () => !minimized,
  });

  function setMinimized(on) {
    minimized = !!on;
    render();
  }

  // ---- top bar chip: <board name> · done/total done · N overdue ----
  function updateChips() {
    if (!chips) return;
    const e = B.entry();
    if (!e) { chips.hidden = true; return; }
    const items = e.items || [];
    const done = items.filter(i => i.status === 'done').length;
    const over = items.filter(i => B.isOverdue(i)).length;
    chips.textContent = e.name + ' · ' + done + '/' + items.length + ' done' + (over ? ' · ' + over + ' overdue' : '');
    chips.hidden = false;
  }

  function viewNames() {
    const reg = Object.keys(B.views);
    return VIEW_ORDER.filter(v => reg.indexOf(v) >= 0).concat(reg.filter(v => VIEW_ORDER.indexOf(v) < 0));
  }

  // ---- scroll memory (P16-B28c): a view is redrawn on every change (select, edit), which replaces its scrollable
  // elements. Before a redraw every scrolled element (the body and any descendant) is noted under its position in
  // the tree (child-index path from the body); after the redraw the same paths get their offsets back. Generic: no
  // view needs to know about it (List table wrapper, each Kanban column list, the Timeline scrollers). ----
  let lastView = null;
  // walks the tree by child index (no selectors); path = indexes joined by '/', '' = the body itself
  function walkTree(fn) {
    const go = (node, path) => {
      fn(node, path);
      Array.prototype.forEach.call(node.children || [], (c, i) => go(c, path === '' ? String(i) : path + '/' + i));
    };
    go(body, '');
  }
  function saveScroll() {
    const out = [];
    walkTree((n, path) => { if (n.scrollTop || n.scrollLeft) out.push({ path, top: n.scrollTop, left: n.scrollLeft }); });
    return out;
  }
  function restoreScroll(saved) {
    if (!saved.length) return;
    const want = {};
    saved.forEach(s => { want[s.path] = s; });
    walkTree((n, path) => {
      const s = want[path];
      if (s) { n.scrollTop = s.top; n.scrollLeft = s.left; }
    });
  }

  // ---- the Board edge tab (#btn-board: bottom centre of the map area, so it rides the drawer's top edge) ----
  // arrow = what a click does: up opens / restores the drawer, down minimizes it
  const tabBtn = $('btn-board');
  function syncTab() {
    if (!tabBtn) return;
    const shown = B.isOpen() && !minimized;
    const label = shown ? 'Minimize the board (it stays as a bar)' : B.isOpen() ? 'Restore the board' : 'Open the board under the map (Timeline, Kanban, List)';
    tabBtn.textContent = shown ? '▼' : '▲';
    tabBtn.title = label;
    tabBtn.setAttribute('aria-label', label);
    tabBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
  }
  function buttonClick() {
    if (!B.isOpen()) { minimized = false; B.open(); return; }
    setMinimized(!minimized);
  }

  function render() {
    updateChips();
    drawer.hidden = !B.isOpen();
    syncTab();
    if (!B.isOpen()) return;
    drawer.classList.toggle('bd-min', minimized);
    btnMin.textContent = minimized ? '▴' : '▾';
    select.value = B.boardId() || '';
    const cur = B.view();
    tabs.textContent = '';
    viewNames().forEach(name => {
      const b = el('button', null, VIEW_LABEL[name] || name);
      b.type = 'button';
      b.setAttribute('aria-pressed', name === cur ? 'true' : 'false');
      b.addEventListener('click', () => {
        // a tab click restores a minimized drawer; setView renders (onChange) only when the view really changes
        const changed = name !== B.view();
        minimized = false;
        B.setView(name);
        if (!changed) render();
      });
      tabs.appendChild(b);
    });
    slotKanban.hidden = cur !== 'kanban';
    slotTimeline.hidden = cur !== 'timeline';
    hint.textContent = (cur && VIEW_HINT[cur]) || '';
    hint.title = hint.textContent;
    if (minimized) return;   // only the bar stays; the view is drawn again on restore
    slotKanban.textContent = '';
    slotTimeline.textContent = '';
    const saved = cur === lastView ? saveScroll() : [];   // a redraw of the same view keeps its scroll offsets (P16-B28c)
    lastView = cur;
    body.textContent = '';
    if (!cur) { body.appendChild(el('div', 'bd-empty', 'No board view is available.')); return; }
    try {
      B.views[cur](body, B.entry());
    } catch (err) {
      console.error('[C4PM_BOARD] view failed', cur, err);
      body.textContent = '';
      body.appendChild(el('div', 'bd-empty', 'The ' + cur + ' view failed: ' + (err && err.message ? err.message : String(err))));
    }
    restoreScroll(saved);
  }

  B.onChange(render);
  B.drawer = { buttonClick, setHeight: size.set, height: size.height, minimize: setMinimized, isMinimized: () => minimized, render };
  updateChips();
  syncTab();

  // Phase 30 SV9b (b642): the view-state part 'board' = { open, min }: the drawer open or closed, and minimized. The board, the
  // view and the height are kept already (localStorage c4mp.boardId, c4mp.boardView: board.js; c4mp.boardH: drawer-resize.js).
  // viewState.js loads after this file, so the part is added at DOMContentLoaded (or on the next timer in a loaded page).
  const drawerPart = {
    get: () => ({ open: B.isOpen(), min: minimized }),
    set: v => {
      if (!v || typeof v !== 'object' || typeof v.open !== 'boolean') return;
      if (!v.open) { if (B.isOpen()) B.close(); return; }
      minimized = v.min === true;
      if (B.isOpen()) render(); else B.open();   // open() renders (onChange)
    },
  };
  // C4PM_STATE.whenReady (state.js): a page without state.js has no viewState.js either.
  if (window.C4PM_STATE) window.C4PM_STATE.whenReady(() => { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.part('board', drawerPart); });
})();
