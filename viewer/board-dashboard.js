// board-dashboard.js: the Dashboard view of the board drawer (P16-B27). Counts of the items of one board as
// horizontal bars: per status, kind, owner, tag (top 12) and, when the board has custom groups, per Kanban group;
// plus an overdue and a blocked count. Read-only: no row filters or selects anything.
// The drawer calls the registered function again on every C4PM_BOARD change, so this file does not subscribe itself.
// All board text goes in through textContent (an owner or tag is never markup).
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  if (!B) return;   // no board: the page is unchanged

  const STATUS_CLASS = { planned: 1, 'in-progress': 1, done: 1, abandoned: 1 };   // known words only get a colour class
  const FINISHED = ['done', 'abandoned'];   // same list as board.js: a finished item is neither overdue nor blocked
  const TOP_TAGS = 12;
  const NO_OWNER = 'no owner';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // [{ label, n, cls }] counting `keyOf(item)` over the items; a Map, not an object: owners and tags are free text.
  // An item whose key is null/undefined is not counted. `order` (optional) lists keys that come first, even at 0.
  function tally(items, keyOf, order) {
    const m = new Map();
    (order || []).forEach(k => m.set(k, 0));
    items.forEach(it => {
      const ks = [].concat(keyOf(it));
      ks.forEach(k => { if (k != null) m.set(k, (m.get(k) || 0) + 1); });
    });
    return [...m.entries()].map(([label, n]) => ({ label, n }));
  }
  const byCountDesc = rows => rows.slice().sort((a, b) => b.n - a.n || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // Unfinished and waiting for an item (any board) that exists and is not done. A dependency that is not an item
  // is the check's business, not a blocker here (same rule as the Kanban view).
  function isBlocked(it) {
    if (FINISHED.indexOf(it.status) >= 0) return false;
    return (it.dependsOn || []).some(id => { const d = B.item(id); return d && d.status !== 'done'; });
  }

  // One titled block of bars. `total` is the number of items, so a bar's width is its share of the board.
  function section(title, rows, total, opts) {
    const sec = el('section', 'bdb-sec');
    sec.tabIndex = 0;   // a keyboard user can reach the block (and scroll the view with the arrow keys)
    sec.setAttribute('aria-label', title);
    sec.appendChild(el('h3', 'bdb-h', title));
    const ul = el('ul', 'bdb-rows');
    rows.forEach(r => {
      const li = el('li', 'bdb-row');
      li.setAttribute('aria-label', r.label + ': ' + r.n + ' of ' + total);
      li.appendChild(el('span', 'bdb-lbl', r.label));
      const track = el('span', 'bdb-track');
      const bar = el('span', 'bdb-bar' + (opts && opts.status && STATUS_CLASS[r.label] ? ' st-' + r.label : ''));
      bar.style.width = (total ? Math.round(r.n * 100 / total) : 0) + '%';
      track.appendChild(bar);
      li.appendChild(track);
      li.appendChild(el('span', 'bdb-n', String(r.n)));
      ul.appendChild(li);
    });
    if (!rows.length) ul.appendChild(el('li', 'bdb-none', 'none'));
    sec.appendChild(ul);
    return sec;
  }

  function stat(label, n, warn) {
    const d = el('div', 'bdb-stat' + (warn && n > 0 ? ' warn' : ''));
    d.appendChild(el('span', 'bdb-big', String(n)));
    d.appendChild(el('span', 'bdb-slbl', label));
    return d;
  }

  B.views.dashboard = function (container, entry) {
    container.textContent = '';
    if (!entry) return;
    const items = entry.items || [];
    const box = el('div', 'bdb');
    box.setAttribute('aria-label', entry.name + ' dashboard');
    if (!items.length) {
      box.appendChild(el('div', 'bd-empty', 'This board has no items.'));
      container.appendChild(box);
      return;
    }
    const total = items.length;

    const stats = el('div', 'bdb-stats');
    stats.appendChild(stat('items', total, false));
    stats.appendChild(stat('overdue', items.filter(B.isOverdue).length, true));
    stats.appendChild(stat('blocked', items.filter(isBlocked).length, true));
    box.appendChild(stats);

    const grid = el('div', 'bdb-grid');
    const statuses = (B.data.statuses || []).slice();
    grid.appendChild(section('Status', tally(items, i => i.status, statuses), total, { status: true }));
    const kinds = (B.data.kinds || []).slice();
    grid.appendChild(section('Kind', tally(items, i => i.kind, kinds), total));
    grid.appendChild(section('Owner', byCountDesc(tally(items, i => i.owner || NO_OWNER)), total));
    const tags = byCountDesc(tally(items, i => i.tags || []));
    grid.appendChild(section(tags.length > TOP_TAGS ? 'Tag (top ' + TOP_TAGS + ')' : 'Tag', tags.slice(0, TOP_TAGS), total));
    // a custom group = a group with no status of its own (the default columns just repeat the status block)
    const groups = entry.groups || [];
    if (groups.some(g => !g.status) && typeof B.groupOf === 'function') {
      const name = new Map(groups.map(g => [g.id, g.name]));
      const rows = tally(items, i => B.groupOf(entry, i), groups.map(g => g.id))
        .map(r => ({ label: name.get(r.label) || r.label, n: r.n }));
      const other = items.filter(i => B.groupOf(entry, i) === null).length;   // a status that fits no group
      if (other) rows.push({ label: 'other', n: other });
      grid.appendChild(section('Group', rows, total));
    }
    box.appendChild(grid);
    container.appendChild(box);
  };
})();
