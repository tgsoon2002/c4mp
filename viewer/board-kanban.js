// board-kanban.js: the Kanban view of the board drawer (P16-B25, drag in P16-B32a). One column per group of the
// board; a click on a column head collapses it to a 42px strip (state shared with the Timeline lanes through
// C4PM_BOARD.toggleCollapsed). Cards drag to another column; the page cannot write files, so a drag only changes
// the PENDING list in memory, shown as `c4mp board set` commands to copy (Copy / Discard). Groups can be added
// ("+ Group"), deleted (custom and empty only) and reordered (drag a column head, or Alt+Left / Alt+Right on it),
// shown as `c4mp board group add|remove|order` commands in the same bar. The board data itself is never changed. The drawer calls the registered function again on every board change, so this file does not
// subscribe itself. All board text goes in through textContent.
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  if (!B) return;   // no board: the page is unchanged

  const KIND_LETTER = { task: 'T', feature: 'F', issue: 'I', bug: 'B', decision: 'D', question: 'Q' };
  const EXTRA = 'status:';   // collapse key prefix of an extra column (a status that no group shows)

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // The column (group id) an item sits in: its own `group` if the board has it, else the first group whose
  // status equals the item's status, else null (an extra column, see columns()). One function for every
  // view that groups by Kanban column (the Timeline "By group" lanes reuse it). It reads the item as saved:
  // a pending drag of this view is not applied here.
  function groupOf(entry, it) {
    const groups = entry.groups || [];
    if (it.group && groups.some(g => g.id === it.group)) return it.group;
    const g = groups.find(x => x.status && x.status === it.status);
    return g ? g.id : null;
  }
  B.groupOf = groupOf;

  // ---- pending moves (B32a). item id -> { status, group } the item would have after the commands ran.
  // A Map: ids such as '__proto__' are legal. The saved item stays untouched; Discard just empties the Map.
  const moved = new Map();
  let drag = null;   // { id, entryId } while a card is dragged
  let shown = null;  // { container, entry } of the last draw, for redraws after a move

  // ---- pending group edits (B32b). board id -> the groups the board would have after the commands ran
  // (a working copy; entry.groups, which may be shared, is never changed). Added / removed / order are found by
  // comparing the copy with the saved groups. A Map: board ids are free text.
  const gw = new Map();
  let adding = null;   // board id whose "+ Group" input is open
  // SV8 (b795): pending moves / group edits not saved yet keep the live page from reloading.
  // b645 (SV11b): in a served page the bar has Save; `report` = { lines, stopped, notRun } of the last Save, shown until Close.
  const LIVE = window.C4PM_LIVE && typeof window.C4PM_LIVE.request === 'function' ? window.C4PM_LIVE : null;
  let report = null;
  if (window.C4PM_LIVE && typeof window.C4PM_LIVE.dirty === 'function') window.C4PM_LIVE.dirty(() => moved.size > 0 || gw.size > 0 || !!(report && report.stopped));

  const BOARD_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  // same slug as groupSlug() in src/board/ops.ts: the id the CLI will give the group
  function slug(name) {
    const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
    return BOARD_ID_RE.test(s) ? s : 'g-' + s;
  }
  const groupsOf = entry => gw.get(entry.id) || entry.groups || [];
  // the entry with its pending groups, for drawing (a copy; groupOf() and columns() read .groups)
  const withGroups = entry => (gw.has(entry.id) ? Object.assign({}, entry, { groups: gw.get(entry.id) }) : entry);
  const sameOrder = (a, b) => a.length === b.length && a.every((g, i) => g.id === b[i].id);
  function setGroups(entry, list) {
    if (sameOrder(list, entry.groups || [])) gw.delete(entry.id); else gw.set(entry.id, list);
  }

  // Item as it would be after the pending commands (a shallow copy), or the item itself.
  function effective(it) {
    const m = moved.get(it.id);
    return m ? Object.assign({}, it, { status: m.status, group: m.group }) : it;
  }

  // Columns of a board: its groups, then one extra column per status that fits no group (only when it has items).
  // An extra column is not a drop target: no group id, nothing to set.
  function columns(entry) {
    const cols = (entry.groups || []).map(g => ({ id: g.id, name: g.name, status: g.status, items: [], extra: false }));
    const byId = new Map(cols.map(c => [c.id, c]));
    const extras = new Map();
    (entry.items || []).forEach(raw => {
      const it = effective(raw);
      const gid = groupOf(entry, it);
      if (gid !== null) { byId.get(gid).items.push(it); return; }
      const key = String(it.status);
      if (!extras.has(key)) extras.set(key, { id: EXTRA + key, name: key, status: undefined, items: [], extra: true });
      extras.get(key).items.push(it);
    });
    return cols.concat([...extras.values()]);
  }

  // Items (any board) this one waits for that are not done (a pending move to done counts). A dependency that
  // is not an item is the check's business, not a blocker here.
  function blockers(it) {
    return (it.dependsOn || []).map(id => B.item(id)).filter(Boolean).map(effective).filter(d => d.status !== 'done');
  }

  // ---- commands ----
  // Local copy of shellQuote in viewer/panel.js (private there; keep the two in step).
  const SHELL_PLAIN = /^[A-Za-z0-9_@%+=:,.\/-]+$/;
  function shellQuote(s) {
    s = String(s);
    if (SHELL_PLAIN.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  // One `board set` per moved item: --status when the status changes, --group <gid> / --group none when the group
  // field changes. --repo is required by the CLI; --yes makes it write (without it the command only shows the change).
  function pendingOps() {
    const repo = (window.C4PM_DATA && window.C4PM_DATA.repoPath) || '.';
    const tail = ' --repo ' + shellQuote(repo) + ' --yes';
    // run order: add groups, move cards, remove groups (now empty), then the final order
    const adds = [], removes = [], orders = [];
    gw.forEach((cur, boardId) => {
      const entry = B.boards().find(b => b.id === boardId);
      if (!entry) return;
      const orig = entry.groups || [];
      const origIds = new Set(orig.map(g => g.id));
      const curIds = new Set(cur.map(g => g.id));
      const base = ' --board ' + shellQuote(boardId);
      const added = cur.filter(g => !origIds.has(g.id));
      added.forEach(g => adds.push({ cmd: 'c4mp board group add ' + shellQuote(g.name) + base + tail, op: { op: 'group-add', board: boardId, name: g.name } }));
      orig.filter(g => !curIds.has(g.id)).forEach(g => removes.push({ cmd: 'c4mp board group remove ' + shellQuote(g.name) + base + tail, op: { op: 'group-remove', board: boardId, name: g.name } }));
      const natural = orig.filter(g => curIds.has(g.id)).concat(added);
      if (!sameOrder(cur, natural)) orders.push({ cmd: 'c4mp board group order ' + shellQuote(cur.map(g => g.name).join(',')) + base + tail, op: { op: 'group-order', board: boardId, names: cur.map(g => g.name) } });
    });
    const list = adds.slice();
    moved.forEach((m, id) => {
      const it = B.item(id);
      if (!it) return;
      let line = 'c4mp board set ' + shellQuote(id) + ' --repo ' + shellQuote(repo);
      const fields = {};
      if (m.status !== it.status) { line += ' --status ' + shellQuote(m.status); fields.status = m.status; }
      if (m.group !== it.group) { line += ' --group ' + (m.group === undefined ? 'none' : shellQuote(m.group)); fields.group = m.group === undefined ? 'none' : m.group; }
      list.push({ cmd: line + ' --yes', op: { op: 'set', id, fields } });
    });
    return list.concat(removes, orders);
  }

  function pendingCommands() { return pendingOps().map(p => p.cmd); }

  // ---- group edits. Each returns an error text (shown next to the input) or '' when it worked.
  // A name goes to the CLI as one argument, and `group order` is a comma list: so no comma or line break.
  function addGroup(entry, name) {
    const clean = String(name).trim();
    if (clean === '') return 'Type a name';
    if (/[,\r\n]/.test(clean)) return 'No comma or line break in a group name';
    const list = groupsOf(entry);
    const id = slug(clean);
    if (list.some(g => g.id === id || g.name.toLowerCase() === clean.toLowerCase())) return 'The board already has a group like this';
    setGroups(entry, list.concat([{ id, name: clean }]));
    return '';
  }

  // Only a custom group (no status) that shows no item can go; the CLI refuses the others.
  function removeGroup(entry, id) {
    const col = columns(withGroups(entry)).find(c => c.id === id);
    if (!col || col.extra || col.status || col.items.length) return false;
    setGroups(entry, groupsOf(entry).filter(g => g.id !== id));
    return true;
  }

  // Put group `id` before (after = false) or after the group `targetId`.
  function moveGroup(entry, id, targetId, after) {
    if (id === targetId) return false;
    const list = groupsOf(entry).slice();
    const from = list.findIndex(g => g.id === id);
    if (from < 0 || !list.some(g => g.id === targetId)) return false;
    const g = list.splice(from, 1)[0];
    list.splice(list.findIndex(x => x.id === targetId) + (after ? 1 : 0), 0, g);
    setGroups(entry, list);
    return true;
  }

  // Put the card into a column: a status group sets the status and clears `group`; a custom group keeps the status
  // and sets `group`. Dropping on its own column, or back on where it started, leaves nothing pending.
  function moveCard(entry, id, colId) {
    const raw = B.item(id);
    const target = (entry.groups || []).find(g => g.id === colId);
    const own = B.entryOf(id);
    if (!raw || !target || !own || own.id !== entry.id) return false;   // `entry` may be a copy with pending groups
    const cur = effective(raw);
    if (groupOf(entry, cur) === target.id) return false;
    const next = target.status ? { status: target.status, group: undefined } : { status: cur.status, group: target.id };
    if (groupOf(entry, Object.assign({}, raw, next)) === groupOf(entry, raw)) moved.delete(id); else moved.set(id, next);
    return true;
  }

  function discard() {
    moved.clear();
    gw.clear();
    adding = null;
    redraw();
  }

  // b645 (SV11b): Save of a served page. Sends the pending edits in run order (POST api/board, one request); the server
  // writes them one by one and stops at the first refusal. onBoardSaved shows which were written / refused / not run.
  function saveBoardEdits(btn) {
    const list = pendingOps();
    if (!list.length || !LIVE) return;
    btn.disabled = true;
    btn.textContent = 'Saving ...';
    const failed = () => {
      report = { lines: ['Save failed: c4mp serve is not running. Nothing was written; your changes are kept.'], stopped: false, notRun: [] };
      redraw();
    };
    let sent;
    try {
      sent = LIVE.request('POST', 'api/board', { expect: (LIVE.stamps && LIVE.stamps.board) || '', ops: list.map(p => p.op) });
    } catch (e) { failed(); return; }
    sent.then(ans => onBoardSaved(list, ans), failed);
  }

  function onBoardSaved(list, ans) {
    const json = (ans && ans.json) || {};
    const status = ans && ans.status;
    if (!Array.isArray(json.results)) {   // nothing written: the pending edits stay
      let text;
      if (status === 409) text = 'The board changed since this page loaded. Nothing was written; your changes are kept. Copy the commands, or Discard and reload.';
      else if (status === 401) text = 'Save failed: the key is from an earlier c4mp serve run. Nothing was written.';
      else text = 'Save failed: ' + (json.message || (json.error && json.error.message) || 'c4mp serve answered ' + status) + '. Nothing was written.';
      report = { lines: [text], stopped: false, notRun: [] };
      redraw();
      return;
    }
    moved.clear();
    gw.clear();
    adding = null;
    const lines = [];
    const notRun = [];
    let written = 0;
    json.results.forEach((r, i) => {
      if (!list[i]) return;
      if (r && r.ok) { written++; lines.push('written: ' + list[i].cmd); return; }
      lines.push('refused: ' + list[i].cmd);
      lines.push('  ' + ((r && r.error && r.error.message) || (json.error && json.error.message) || 'refused'));
    });
    for (let i = json.results.length; i < list.length; i++) { lines.push('not run: ' + list[i].cmd); notRun.push(list[i].cmd); }
    const stopped = json.stoppedAt !== null && json.stoppedAt !== undefined;
    lines.unshift(stopped ? 'Saved ' + written + ' of ' + list.length + ' change(s); stopped at a refusal.' : 'Saved ' + written + ' change(s).');
    report = { lines, stopped, notRun };
    if (LIVE && LIVE.stamps && typeof json.stamp === 'string') LIVE.stamps.board = json.stamp;
    redraw();
  }

  function copyCommands(btn, pre, text) {
    const fallback = () => {
      let ok = false;
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && document.createRange) { const r = document.createRange(); r.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(r); ok = true; }
      } catch (e) { /* no selection API */ }
      btn.textContent = ok ? 'Press Ctrl+C to copy (text selected)' : 'Copy failed';
    };
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
      navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; }, fallback);
    } catch (e) { fallback(); }
  }

  function pendingBar() {
    const list = pendingOps();
    const cmds = list.map(p => p.cmd);
    const bar = el('div', 'kb-pending');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Pending changes');
    bar.hidden = !cmds.length && !report;
    if (bar.hidden) return bar;
    if (cmds.length) {
      const row = el('div', 'row');
      row.appendChild(el('strong', null, cmds.length + ' pending change' + (cmds.length === 1 ? '' : 's')));
      row.appendChild(el('span', null, LIVE ? '- not saved yet.' : '- this page cannot write files. Copy the commands and run them in a terminal.'));
      const pre = el('pre', null, cmds.join('\n'));
      if (LIVE) {
        const save = el('button', 'kb-save', 'Save');
        save.type = 'button';
        save.addEventListener('click', () => saveBoardEdits(save));
        row.appendChild(save);
      }
      const copy = el('button', 'kb-copy', 'Copy commands');
      copy.type = 'button';
      copy.addEventListener('click', () => copyCommands(copy, pre, cmds.join('\n')));
      const drop = el('button', 'kb-discard', 'Discard');
      drop.type = 'button';
      drop.addEventListener('click', discard);
      row.appendChild(copy);
      row.appendChild(drop);
      bar.appendChild(row);
      bar.appendChild(pre);
    }
    if (report) {
      const row = el('div', 'row');
      const pre = el('pre', null, report.lines.join('\n'));
      if (report.stopped && report.notRun.length) {   // the commands that did not run, to run by hand
        const copy = el('button', 'kb-copy', cmds.length ? 'Copy not-run commands' : 'Copy commands');
        copy.type = 'button';
        copy.addEventListener('click', () => copyCommands(copy, pre, report.notRun.join('\n')));
        row.appendChild(copy);
      }
      const close = el('button', 'kb-close', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => { report = null; redraw(); });
      row.appendChild(close);
      bar.appendChild(row);
      bar.appendChild(pre);
    }
    return bar;
  }

  // ---- drawing ----
  function clearMarks() {
    if (!shown || !shown.container.querySelectorAll) return;
    // 'drop-over', not 'over': `.over` is also the red overdue chip and must survive a drag
    shown.container.querySelectorAll('.drop-over').forEach(n => n.classList.remove('drop-over'));
    shown.container.querySelectorAll('.dragging').forEach(n => n.classList.remove('dragging'));
    ['mark-l', 'mark-r'].forEach(m => shown.container.querySelectorAll('.' + m).forEach(n => n.classList.remove(m)));
  }

  function card(entry, it, cols) {
    const sel = B.selectedId() === it.id;
    const isMoved = moved.has(it.id);
    const c = el('div', 'kb-card' + (sel ? ' selected' : '') + (isMoved ? ' moved' : ''));
    c.dataset.id = it.id;
    c.tabIndex = 0;
    c.draggable = true;
    c.setAttribute('aria-label', it.id + ' ' + it.title + (isMoved ? ', moved (pending)' : ''));
    c.title = 'Drag to another column, or press Alt+Left / Alt+Right';
    const l1 = el('div', 'bd-line');
    l1.appendChild(el('span', 'bd-kind bk-' + (KIND_LETTER[it.kind] ? it.kind : 'task'), KIND_LETTER[it.kind] || '?'));
    l1.appendChild(el('span', 'kb-id', it.id));
    l1.appendChild(el('span', 'bd-title', ''));
    const known = it.status === 'planned' || it.status === 'in-progress' || it.status === 'done' || it.status === 'abandoned';
    const stChip = el('span', 'kb-status' + (known ? ' st-' + it.status : ''), it.status || '');
    stChip.title = 'status: ' + (it.status || 'unknown');
    l1.appendChild(stChip);
    const n = (it.linked || []).length;
    const lk = el('span', 'bd-link', '⛓ ' + n);
    lk.title = n + ' linked c-item' + (n === 1 ? '' : 's');
    l1.appendChild(lk);
    c.appendChild(l1);
    c.appendChild(el('div', 'kb-ct', it.title));
    const l2 = el('div', 'bd-sub kb-sub');
    l2.appendChild(it.owner ? el('span', null, it.owner) : el('span', 'bd-unassigned', 'unassigned'));
    if (it.size) l2.appendChild(el('span', 'bd-size', it.size));
    if (it.due) l2.appendChild(el('span', 'bd-due' + (B.isOverdue(it) ? ' over' : ''), 'due ' + it.due.slice(5)));
    if (it.parent) l2.appendChild(el('span', null, '↑ ' + it.parent));
    const bl = blockers(it);
    if (bl.length) {
      const m = el('span', 'kb-blocked', 'blocked');
      m.title = 'waits for ' + bl.map(d => d.id).join(', ');
      l2.appendChild(m);
    }
    c.appendChild(l2);
    c.addEventListener('click', ev => { B.select(it.id); if (window.C4PM_SIDE) window.C4PM_SIDE.reveal(ev); });
    c.addEventListener('dblclick', () => { B.select(it.id); if (typeof B.zoomToLinked === 'function') B.zoomToLinked(); });
    c.addEventListener('keydown', e => {
      if (!e || e.target !== c) return;
      if (e.key === 'Enter' || e.key === ' ') { if (e.preventDefault) e.preventDefault(); B.select(it.id); return; }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // keyboard alternative to the drag: the next / previous column that accepts drops
        if (e.preventDefault) e.preventDefault();
        const drops = cols.filter(x => !x.extra);
        const at = drops.findIndex(x => x.id === groupOf(entry, it));
        const to = e.key === 'ArrowLeft' ? drops[at < 0 ? drops.length - 1 : at - 1] : drops[at < 0 ? 0 : at + 1];
        if (to && moveCard(entry, it.id, to.id)) { redraw(it.id); }
      }
    });
    c.addEventListener('dragstart', e => {
      drag = { id: it.id, entryId: entry.id };
      if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'card:' + it.id); } catch (x) { /* ignore */ } }
      c.classList.add('dragging');
    });
    c.addEventListener('dragend', () => { drag = null; clearMarks(); });
    return c;
  }

  function column(entry, col, cols) {
    const closed = B.isCollapsed(entry.id, col.id);
    const box = el('div', 'kb-col' + (closed ? ' closed' : '') + (col.extra ? ' extra' : ''));
    box.dataset.gid = col.id;
    const head = el('div', 'kb-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', closed ? 'false' : 'true');
    head.setAttribute('aria-label', col.name + ', ' + col.items.length + (col.items.length === 1 ? ' item, ' : ' items, ') + (closed ? 'collapsed' : 'expanded'));
    head.title = closed ? 'Click to expand' : 'Click to collapse';
    head.appendChild(el('span', 'kb-twist', closed ? '▸' : '▾'));
    head.appendChild(el('span', 'kb-name', col.name));
    head.appendChild(el('span', 'kb-count', String(col.items.length)));
    const toggle = () => B.toggleCollapsed(entry.id, col.id);
    head.addEventListener('click', toggle);
    if (!col.extra && !col.status && !col.items.length) {   // an empty custom group can be deleted
      const x = el('button', 'kb-x', '×');
      x.type = 'button';
      x.title = 'Delete this empty group';
      x.setAttribute('aria-label', 'Delete empty group ' + col.name);
      x.addEventListener('click', e => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (removeGroup(entry, col.id)) redraw();
      });
      head.appendChild(x);
    }
    head.addEventListener('keydown', e => {
      if (!e || (e.target && e.target !== head)) return;   // a key on the delete button is its own
      if (e.key === 'Enter' || e.key === ' ') { if (e.preventDefault) e.preventDefault(); toggle(); return; }
      if (e.altKey && !col.extra && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // keyboard alternative to dragging the head: swap with the next / previous group
        if (e.preventDefault) e.preventDefault();
        const drops = cols.filter(x => !x.extra);
        const to = drops[drops.findIndex(x => x.id === col.id) + (e.key === 'ArrowLeft' ? -1 : 1)];
        if (to && moveGroup(entry, col.id, to.id, e.key === 'ArrowRight')) {
          redraw();
          const box2 = shown && shown.container.querySelectorAll ? Array.from(shown.container.querySelectorAll('.kb-col')).find(n => n.dataset.gid === col.id) : null;
          const again = box2 && box2.children ? box2.children[0] : null;
          if (again && again.focus) again.focus();
        }
      }
    });
    if (!col.extra) {   // drag the head to reorder the groups
      head.draggable = true;
      head.addEventListener('dragstart', e => {
        drag = { kind: 'col', id: col.id, entryId: entry.id };
        if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'col:' + col.id); } catch (x) { /* ignore */ } }
        box.classList.add('dragging');
      });
      head.addEventListener('dragend', () => { drag = null; clearMarks(); });
    }
    box.appendChild(head);
    const list = el('div', 'kb-list');
    col.items.forEach(it => list.appendChild(card(entry, it, cols)));
    box.appendChild(list);
    if (!col.extra) {   // every group takes drops, a collapsed strip too; an extra (status-only) column does not
      const accepts = () => !!drag && drag.entryId === entry.id;
      const isCol = () => drag.kind === 'col';
      // a head dropped on the left half goes before this group, on the right half after it
      const afterMid = e => {
        const r = box.getBoundingClientRect ? box.getBoundingClientRect() : null;
        return !!r && !!e && typeof e.clientX === 'number' && e.clientX >= r.left + r.width / 2;
      };
      box.addEventListener('dragover', e => {
        if (!accepts()) return;
        if (isCol() && drag.id === col.id) return;
        if (e && e.preventDefault) e.preventDefault();   // preventDefault is what allows the drop
        if (e && e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (isCol()) {
          box.classList.remove('mark-l', 'mark-r');
          box.classList.add(afterMid(e) ? 'mark-r' : 'mark-l');
        } else box.classList.add('drop-over');
      });
      box.addEventListener('dragleave', () => box.classList.remove('drop-over', 'mark-l', 'mark-r'));
      box.addEventListener('drop', e => {
        if (!accepts()) return;
        if (e && e.preventDefault) e.preventDefault();
        const d = drag;
        drag = null;
        if (d.kind === 'col') { if (moveGroup(entry, d.id, col.id, afterMid(e))) redraw(); else clearMarks(); return; }
        if (moveCard(entry, d.id, col.id)) redraw(d.id); else { clearMarks(); }
      });
    }
    return box;
  }

  function draw(container, entry, focusId) {
    container.textContent = '';
    if (!entry) return;
    shown = { container, entry };
    const wrap = el('div', 'kb');
    const ge = withGroups(entry);   // the board with its pending group edits
    const cols = columns(ge);
    const area = el('div', 'kb-cols');
    cols.forEach(col => area.appendChild(column(ge, col, cols)));
    let input = null;
    if (adding === entry.id) {
      const box = el('div', 'kb-col kb-new');
      input = el('input');
      input.type = 'text';
      input.placeholder = 'Group name, then Enter';
      input.setAttribute('aria-label', 'New group name');
      const msg = el('div', 'kb-err');
      msg.setAttribute('role', 'alert');
      input.addEventListener('keydown', e => {
        if (!e) return;
        if (e.key === 'Escape') { adding = null; redraw(); return; }
        if (e.key !== 'Enter') return;
        if (e.preventDefault) e.preventDefault();
        const err = addGroup(entry, input.value);
        if (err) { msg.textContent = err; input.setAttribute('aria-invalid', 'true'); return; }
        adding = null;
        redraw();
      });
      box.appendChild(input);
      box.appendChild(msg);
      area.appendChild(box);
    } else {
      const add = el('button', 'kb-add', '+ Group');
      add.type = 'button';
      add.title = 'Add a group (column)';
      add.addEventListener('click', () => { adding = entry.id; redraw(); });
      area.appendChild(add);
    }
    wrap.appendChild(area);
    wrap.appendChild(pendingBar());
    container.appendChild(wrap);
    if (input && input.focus) input.focus();
    if (focusId !== undefined && container.querySelectorAll) {   // after a keyboard move keep the focus on the card
      const again = Array.from(container.querySelectorAll('.kb-card')).find(n => n.dataset.id === focusId);
      if (again && again.focus) again.focus();
    }
  }
  function redraw(focusId) { if (shown) draw(shown.container, shown.entry, focusId); }

  B.views.kanban = function (container, entry) { draw(container, entry); };
})();
