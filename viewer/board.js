// board.js: shared state of the board (P16-B22). Everything else (drawer, views, panel, note) is
// in the other board*.js files and talks to this one through window.C4PM_BOARD.
// Loaded after tree.js: it needs window.C4PM_MAP, and its map listener runs after the panel's (load order).
(function () {
  'use strict';
  // No board or no map: the page is exactly as before (this keeps every existing viewer test unchanged).
  if (!window.C4PM_MAP || !window.C4PM_DATA || !window.C4PM_DATA.board) return;

  const MAP = window.C4PM_MAP;
  const data = window.C4PM_DATA.board;   // ViewBoard (PHASE_16_TASKS.md section 3b)
  const KEY_VIEW = 'c4mp.boardView';
  const KEY_BOARD = 'c4mp.boardId';
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const FINISHED = ['done', 'abandoned'];   // same list as src/board/check.ts: a past due date on these is not overdue

  // ---- storage (may be blocked or throw: the page must work without it) ----
  // Phase 35 C (b945): through C4PM_STORE (store.js): the new c4mp.* key, else the old c4pm.* one; writes the new key only.
  function readStore(key) { return window.C4PM_STORE.get(key); }
  function writeStore(key, v) { window.C4PM_STORE.set(key, v); }

  // ---- index. Maps, not plain objects: item ids such as '__proto__' are legal ----
  const itemById = new Map();    // item id -> item
  const entryById = new Map();   // item id -> board entry that holds it
  const kidsOf = new Map();      // item id -> [child item]
  const dependentsOf = new Map();   // item id -> [items (any board) whose dependsOn names it]
  (data.boards || []).forEach(entry => {
    (entry.items || []).forEach(it => { itemById.set(it.id, it); entryById.set(it.id, entry); });
  });
  (data.boards || []).forEach(entry => {
    (entry.items || []).forEach(it => {
      // a parent must be in the same board (the check reports otherwise); ignore a foreign parent here
      if (it.parent && entryById.get(it.parent) === entry) {
        if (!kidsOf.has(it.parent)) kidsOf.set(it.parent, []);
        kidsOf.get(it.parent).push(it);
      }
      (it.dependsOn || []).forEach(dep => {
        if (!dependentsOf.has(dep)) dependentsOf.set(dep, []);
        dependentsOf.get(dep).push(it);
      });
    });
  });

  // ---- state ----
  const listeners = [];
  const views = Object.create(null);   // name -> function (container, entry); filled by board-<view>.js
  let open = false;
  let selB = null;
  let selecting = false;   // true while select() deselects the c-item (so our own map listener ignores it)
  let curBoard = null;     // board id, validated on read
  let curView = null;
  let todayOverride = null;
  const collapsed = new Set();

  function notify() { listeners.slice().forEach(fn => { try { fn(); } catch (e) { console.error('[C4PM_BOARD] listener failed', e); } }); }

  // ---- boards ----
  const boards = () => (data.boards || []).filter(b => !b.archived);
  function boardId() {
    const list = boards();
    if (curBoard && list.some(b => b.id === curBoard)) return curBoard;
    const stored = readStore(KEY_BOARD);
    if (stored && list.some(b => b.id === stored)) return stored;
    return list.length ? list[0].id : null;
  }
  const entry = () => boards().find(b => b.id === boardId()) || null;
  function setBoard(id) {
    if (!boards().some(b => b.id === id)) return false;
    const changed = id !== boardId();
    curBoard = id;
    writeStore(KEY_BOARD, id);
    if (changed) notify();
    return true;
  }

  // ---- views ----
  function view() {
    if (curView && views[curView]) return curView;
    const stored = readStore(KEY_VIEW);
    if (stored && views[stored]) return stored;
    if (views.timeline) return 'timeline';
    const keys = Object.keys(views);
    return keys.length ? keys[0] : null;
  }
  function setView(v) {
    if (typeof v !== 'string' || !views[v]) return false;
    const changed = v !== view();
    curView = v;
    writeStore(KEY_VIEW, v);
    if (changed) notify();
    return true;
  }

  // ---- items ----
  const item = id => itemById.get(id) || null;
  const entryOf = id => entryById.get(id) || null;
  const children = id => (kidsOf.get(id) || []).slice();
  const dependents = id => (dependentsOf.get(id) || []).slice();

  // Node ids of the item's own links plus those of every nested descendant, de-duplicated.
  function litNodeIds(id) {
    const out = [];
    const seen = new Set();
    const visited = new Set();
    (function walk(itemId) {
      if (visited.has(itemId)) return;   // a nest cycle in a broken file must not loop
      visited.add(itemId);
      const it = itemById.get(itemId);
      if (!it) return;
      (it.linked || []).forEach(l => { if (l && l.nodeId && !seen.has(l.nodeId)) { seen.add(l.nodeId); out.push(l.nodeId); } });
      (kidsOf.get(itemId) || []).forEach(k => walk(k.id));
    })(id);
    return out;
  }

  // ---- selection ----
  const selectedId = () => selB;
  function select(id) {
    if (id === null || id === undefined) {
      if (selB === null) return true;   // nothing to clear; do not touch a selected c-item
      selB = null;
      MAP.setHighlight(null);
      selecting = true;
      try { MAP.select(null); } finally { selecting = false; }   // the panel returns to its summary
      notify();
      return true;
    }
    if (!itemById.has(id)) return false;
    selecting = true;
    try { MAP.select(null); } finally { selecting = false; }   // deselect the c-item
    selB = id;
    const entryOfItem = entryById.get(id);
    if (entryOfItem && !entryOfItem.archived) { curBoard = entryOfItem.id; writeStore(KEY_BOARD, entryOfItem.id); }
    const ids = litNodeIds(id);
    MAP.setHighlight(ids.length ? ids : null);
    notify();
    return true;
  }
  // A c-item was selected: the b-item is deselected (no call back into MAP.select, so no loop).
  MAP.onSelect(node => {
    if (!node || selecting || selB === null) return;
    selB = null;
    MAP.setHighlight(null);
    notify();
  });
  // Esc clears the selected b-item, unless the key was typed into a form field.
  document.addEventListener('keydown', e => {
    if (!e || e.key !== 'Escape' || selB === null) return;
    const t = e.target || {};
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable) return;
    select(null);
  });

  // ---- open / close (the drawer shows or hides itself on onChange) ----
  const btn = document.getElementById('btn-board');
  function syncButton() { if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false'); }
  function setOpen(on) {
    if (open === on) return;
    open = on;
    syncButton();
    notify();
  }
  if (btn) {
    btn.hidden = false;
    // with the drawer loaded its handler decides: closed -> open, open -> minimize, minimized -> restore
    btn.addEventListener('click', () => {
      const d = window.C4PM_BOARD && window.C4PM_BOARD.drawer;
      if (d && d.buttonClick) d.buttonClick(); else setOpen(!open);
    });
  }

  // ---- collapsed groups, shared by Kanban and Timeline lanes ----
  const ckey = (b, g) => JSON.stringify([b, g]);
  const isCollapsed = (b, g) => collapsed.has(ckey(b, g));
  function toggleCollapsed(b, g) {
    const k = ckey(b, g);
    if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
    notify();
    return collapsed.has(k);
  }

  // ---- dates (browser clock unless a test set it; same format as src/board/dates.ts todayIso) ----
  function today() {
    if (todayOverride) return todayOverride;
    const d = new Date();
    const p = (n, w) => String(n).padStart(w, '0');
    return p(d.getFullYear(), 4) + '-' + p(d.getMonth() + 1, 2) + '-' + p(d.getDate(), 2);
  }
  function validDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const t = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
  }
  function setToday(s) {
    if (s === null || s === undefined) { todayOverride = null; return true; }
    if (!validDate(s)) return false;
    todayOverride = s;
    return true;
  }
  // whole days from date a to date b (b - a); both 'YYYY-MM-DD'
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  // due date passed and not finished (the rule of src/board/check.ts isOverdue)
  const isOverdue = it => !!it && !!it.due && it.due < today() && FINISHED.indexOf(it.status) < 0;

  window.C4PM_BOARD = {
    data, boards, boardId, entry, setBoard, view, setView, views,
    open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open,
    item, entryOf, children, dependents, select, selectedId, litNodeIds,
    onChange: fn => { if (typeof fn === 'function') listeners.push(fn); },
    isCollapsed, toggleCollapsed, today, setToday, dayDiff, isOverdue, validDate,
  };
})();
