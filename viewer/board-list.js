// board-list.js: the List view of the board drawer (P16-B24). A table of the items of one board:
// kind, id, title, status, owner, start, due, linked c-items; nested items sit under their parent, indented.
// The drawer calls the registered function again on every C4PM_BOARD change (selection included), so this file
// does not subscribe itself. All board text goes in through textContent (a title is never markup).
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  if (!B) return;   // no board: the page is unchanged

  const KIND_LETTER = { task: 'T', feature: 'F', issue: 'I', bug: 'B', decision: 'D', question: 'Q' };
  const STATUS_CLASS = { planned: 1, 'in-progress': 1, done: 1, abandoned: 1 };   // known words only get a colour class
  const COLS = ['Kind', 'ID', 'Title', 'Status', 'Owner', 'Start', 'Due', 'C-items'];

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // Rows in display order: roots in file order, each followed by its descendants (depth-first).
  // A root = no parent, or a parent that is not an item of this board. Items trapped in a nest cycle of a
  // broken file are never reached from a root; they are appended as roots so no item disappears.
  function ordered(entry) {
    const items = entry.items || [];
    const ids = new Set(items.map(i => i.id));
    const kids = new Map();
    items.forEach(i => {
      if (i.parent && ids.has(i.parent) && i.parent !== i.id) {
        if (!kids.has(i.parent)) kids.set(i.parent, []);
        kids.get(i.parent).push(i);
      }
    });
    const out = [];
    const seen = new Set();
    const add = (it, depth) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push({ item: it, depth });
      (kids.get(it.id) || []).forEach(c => add(c, depth + 1));
    };
    items.filter(i => !i.parent || !ids.has(i.parent) || i.parent === i.id).forEach(i => add(i, 0));
    items.forEach(i => add(i, 0));
    return out;
  }

  function row(it, depth) {
    const sel = B.selectedId() === it.id;
    const tr = el('tr', 'r' + (sel ? ' sel' : ''));
    tr.tabIndex = 0;
    tr.setAttribute('aria-selected', sel ? 'true' : 'false');
    tr.setAttribute('aria-label', it.id + ' ' + it.title);   // textContent-like: attributes are not parsed as markup

    const k = el('td');
    k.appendChild(el('span', 'bd-kind bk-' + (KIND_LETTER[it.kind] ? it.kind : 'task'), KIND_LETTER[it.kind] || '?'));
    k.title = it.kind;
    tr.appendChild(k);
    tr.appendChild(el('td', 'bd-id', it.id));
    const t = el('td', 'bd-ttl', it.title);
    t.style.paddingLeft = (10 + depth * 18) + 'px';
    t.title = it.title;   // the cell is cut with an ellipsis when long
    if (it.size) t.appendChild(el('span', 'bd-size', it.size));
    tr.appendChild(t);
    const st = el('td');
    st.appendChild(el('span', 'bd-dot' + (STATUS_CLASS[it.status] ? ' st-' + it.status : '')));
    st.appendChild(document.createTextNode(it.status));
    tr.appendChild(st);
    const ownTd = el('td', null, it.owner || '');
    if (!it.owner) ownTd.appendChild(el('span', 'bd-unassigned', 'unassigned'));
    tr.appendChild(ownTd);
    tr.appendChild(el('td', null, it.start || ''));
    const due = el('td');
    if (it.due) due.appendChild(el('span', 'bd-due' + (B.isOverdue(it) ? ' over' : ''), it.due));
    tr.appendChild(due);
    tr.appendChild(el('td', 'bd-n', '⛓ ' + (it.linked || []).length));

    const pick = () => B.select(it.id);
    tr.addEventListener('click', ev => { pick(); if (window.C4PM_SIDE) window.C4PM_SIDE.reveal(ev); });
    tr.addEventListener('dblclick', () => { B.select(it.id); if (typeof B.zoomToLinked === 'function') B.zoomToLinked(); });
    tr.addEventListener('keydown', e => {
      if (e && (e.key === 'Enter' || e.key === ' ')) { if (e.preventDefault) e.preventDefault(); pick(); }
    });
    return tr;
  }

  B.views.list = function (container, entry) {
    container.textContent = '';
    if (!entry) return;
    const box = el('div', 'bd-tbl');
    const tbl = el('table');
    tbl.setAttribute('aria-label', entry.name + ' items');
    const head = el('thead');
    const hr = el('tr');
    COLS.forEach(h => { const th = el('th', null, h); th.setAttribute('scope', 'col'); hr.appendChild(th); });
    head.appendChild(hr);
    tbl.appendChild(head);
    const bodyEl = el('tbody');
    const rows = ordered(entry);
    rows.forEach(r => bodyEl.appendChild(row(r.item, r.depth)));
    tbl.appendChild(bodyEl);
    box.appendChild(tbl);
    if (!rows.length) box.appendChild(el('div', 'bd-empty', 'This board has no items.'));
    container.appendChild(box);
  };
})();
