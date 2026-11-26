// board-panel.js: board items in the right panel (#panel).
// P16-B23: the detail of the selected b-item; P16-B31: a c-item's panel lists its b-items. panel.js is not edited (its functions are private): this file writes
// into #panel after panel.js has drawn, because its listeners run later (load order). Text only: titles, tags and
// owners are put in with textContent / text nodes, never as markup.
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  const M = window.C4PM_MAP;
  if (!B || !M) return;   // no board: the panel is untouched

  // b645 (SV12): in a served page (C4PM_LIVE.request) the b-item panel has an Edit section; a static page has none.
  const LIVE = window.C4PM_LIVE && typeof window.C4PM_LIVE.request === 'function' ? window.C4PM_LIVE : null;
  let editing = null;   // { id, changed } while the form is open
  if (LIVE && typeof LIVE.dirty === 'function') LIVE.dirty(() => !!editing && Object.keys(editing.changed()).length > 0);

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  // Same markup as panel.js section(): label line, then the content is appended by the caller.
  function section(labelText) {
    const sec = el('div', 'pn-section');
    const label = el('div', 'pn-label');
    label.appendChild(el('span', null, labelText));
    sec.appendChild(label);
    return sec;
  }

  // b645 (SV12): the Edit section of a served page. Fields in the CLI's words ('none' clears). Text only (textContent / value).
  function editSection(it) {
    editing = null;   // a fresh draw of the panel closes the form
    const sec = section('Edit');
    const status = el('div', 'set-status');
    const open = el('button', 'bd-edit-open', 'Edit fields');
    open.type = 'button';
    const form = el('div', 'bd-edit');
    form.hidden = true;
    const data = B.data || {};
    const FIELDS = [
      ['title', 'Title', 'text', null, false],
      ['status', 'Status', 'select', data.statuses || [], false],
      ['priority', 'Priority', 'select', data.priorities || null, true],
      ['owner', 'Owner', 'text', null, true],
      ['start', 'Start', 'text', null, true, 'YYYY-MM-DD'],
      ['due', 'Due', 'text', null, true, 'YYYY-MM-DD'],
      ['size', 'Size', 'select', data.sizes || null, true],
      ['sprint', 'Sprint', 'text', null, true, 'S15'],
      ['tags', 'Tags', 'text', null, true, 'comma list'],
    ];
    const current = f => (f === 'tags' ? (it.tags || []).join(', ') : (it[f] == null ? '' : String(it[f])));
    const ctl = {};
    FIELDS.forEach(([f, label, type, options, clearable, hint]) => {
      form.appendChild(el('label', 'bd-edit-label', label));
      let c;
      if (type === 'select' && options) {
        c = el('select', 'bd-edit-input');
        (clearable ? [''].concat(options) : options).forEach(o => c.appendChild(Object.assign(el('option', null, o), { value: o })));
      } else {
        c = el('input', 'bd-edit-input');
        c.type = 'text';
        if (hint) c.placeholder = hint;
      }
      c.value = current(f);
      c.dataset.field = f;
      ctl[f] = c;
      form.appendChild(c);
    });
    // The changed fields only; an emptied clearable field is 'none'.
    const changed = () => {
      const fields = {};
      FIELDS.forEach(([f, , , , clearable]) => {
        const v = String(ctl[f].value).trim();
        if (v === current(f).trim()) return;
        fields[f] = !v && clearable ? 'none' : v;
      });
      return fields;
    };
    const state = { id: it.id, changed };
    const close = () => { editing = null; form.hidden = true; open.hidden = false; };
    const fail = text => { status.textContent = 'Not saved: ' + text; };
    const done = ans => {
      const json = (ans && ans.json) || {};
      const code = ans && ans.status;
      if (code === 409) { status.textContent = 'The board changed since this page loaded. Nothing was written; reload, then edit again.'; return; }
      const results = Array.isArray(json.results) ? json.results : null;
      if (code === 200 && results && results[0] && results[0].ok) {
        const lines = (results[0].changes || []).slice(1).map(s => String(s).trim()).filter(Boolean);
        status.textContent = lines.length ? 'Saved: ' + lines.join('; ') : 'Saved.';
        if (LIVE.stamps && typeof json.stamp === 'string') LIVE.stamps.board = json.stamp;
        close();
        return;
      }
      if (results) {
        const r = results[json.stoppedAt == null ? 0 : json.stoppedAt] || results[0];
        fail((r && r.error && r.error.message) || (json.error && json.error.message) || 'refused');
        return;
      }
      fail(json.message || 'c4mp serve answered ' + code);
    };
    const save = () => {
      const fields = changed();
      if (!Object.keys(fields).length) { status.textContent = 'Nothing to change.'; return; }
      let sent;
      try {
        sent = LIVE.request('POST', 'api/board', { expect: (LIVE.stamps && LIVE.stamps.board) || '', ops: [{ op: 'set', id: it.id, fields }] });
      } catch (e) { fail('c4mp serve is not running.'); return; }
      sent.then(done, () => fail('c4mp serve is not running.'));
    };
    const button = (label, fn) => {
      const b = el('button', 'bd-edit-btn', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };
    form.appendChild(el('span'));
    const row = el('div', 'bd-edit-buttons');
    row.appendChild(button('Save', save));
    row.appendChild(button('Cancel', () => { status.textContent = ''; close(); }));
    form.appendChild(row);
    open.addEventListener('click', () => { status.textContent = ''; editing = state; form.hidden = false; open.hidden = true; });
    sec.appendChild(open);
    sec.appendChild(form);
    sec.appendChild(status);
    return sec;
  }

  // Real dead links, from the same check `c4mp check` runs (rule board-dead-link, id = the item, message
  // "<id>: link '<uid>' matches no plan element"). Keys are item id + NUL + uid in a Set (ids may be any word).
  const unknownUids = new Set();
  const boardData = (window.C4PM_DATA && window.C4PM_DATA.board) || {};
  (boardData.findings || []).forEach(f => {
    if (!f || f.rule !== 'board-dead-link' || typeof f.message !== 'string') return;
    const m = /: link '(.*)' matches no plan element$/.exec(f.message);
    if (m) unknownUids.add(f.id + '\u0000' + m[1]);
  });

  // ---- B23: detail of the selected b-item ----

  // "Due" line: the date, then how far away it is (not for a finished item).
  function dueText(it) {
    if (!it.due) return null;
    if (it.status === 'done' || it.status === 'abandoned') return it.due;
    const d = B.dayDiff(B.today(), it.due);
    return it.due + (d < 0 ? '  (' + (-d) + ' day' + (d === -1 ? '' : 's') + ' overdue)' : d === 0 ? '  (due today)' : '  (in ' + d + ' day' + (d === 1 ? '' : 's') + ')');
  }

  // Chips that select another b-item. An id with no item (a broken dependsOn) is shown dead, not hidden.
  function itemChips(ids) {
    const row = el('div', 'pn-deps');
    ids.forEach(id => {
      const other = B.item(id);
      if (!other) {
        const dead = el('span', 'pn-dep-chip bd-dead', id + ' (missing)');
        dead.title = 'No board item has this id';
        row.appendChild(dead);
        return;
      }
      const e = B.entryOf(id);
      const btn = el('button', 'pn-dep-chip');
      btn.type = 'button';
      btn.title = (e ? e.name + ' · ' : '') + other.status;
      btn.appendChild(el('span', null, other.id + ' ' + other.title));
      btn.addEventListener('click', () => B.select(other.id));
      row.appendChild(btn);
    });
    return row;
  }

  // Copy text to the clipboard; the page cannot open a repo file, so a doc path is shown with a Copy path button.
  function copyPath(text, btn) {
    const done = () => { btn.textContent = 'Copied'; };
    const failed = () => { btn.textContent = 'Copy failed'; };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok === false) throw new Error('copy refused');
        done();
      } catch (err) { failed(); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch (err) { fallback(); }
  }

  // One doc: a url becomes a link only when it is http(s) (anything else, e.g. javascript:, stays plain text); a path is text + Copy path.
  function docRow(d) {
    const li = el('li', 'bd-doc');
    if (d.label) li.appendChild(el('span', 'bd-doc-label', d.label));
    if (d.url) {
      if (/^https?:\/\//i.test(d.url)) {
        const a = el('a', 'bd-doc-link', d.url);
        a.href = d.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
      } else {
        li.appendChild(el('span', 'bd-doc-path', d.url));
      }
    } else if (d.path) {
      li.appendChild(el('span', 'bd-doc-path', d.path));
      const b = el('button', 'bd-copy', 'Copy path');
      b.type = 'button';
      b.title = 'The page cannot open repo files: copy the path';
      b.addEventListener('click', () => copyPath(d.path, b));
      li.appendChild(b);
    }
    return li;
  }

  function breadcrumb(it, e) {
    const bc = el('div', 'pn-breadcrumb');
    bc.appendChild(el('span', 'pn-crumb-chip', 'board'));
    bc.appendChild(el('span', null, e ? e.name : ''));
    const chain = [];
    const seen = new Set();
    for (let x = it; x && !seen.has(x.id); x = x.parent ? B.item(x.parent) : null) { seen.add(x.id); chain.unshift(x); }
    chain.forEach(x => {
      bc.appendChild(el('span', 'pn-sep', '›'));
      const b = el('button', 'pn-crumb', x.title);
      b.type = 'button';
      b.addEventListener('click', () => B.select(x.id));
      bc.appendChild(b);
    });
    return bc;
  }

  function renderItem(panel, it) {
    const e = B.entryOf(it.id);
    panel.appendChild(breadcrumb(it, e));

    const head = el('div', 'pn-header');
    const h2 = el('h2');
    h2.appendChild(document.createTextNode(it.title));
    h2.appendChild(el('span', 'pn-kind', it.kind));
    head.appendChild(h2);
    head.appendChild(el('div', 'pn-detail', it.id + ((it.tags || []).length ? ' · ' + it.tags.join(', ') : '')));
    panel.appendChild(head);

    const pills = el('div', 'pn-meta-pills');
    pills.appendChild(el('span', 'pn-badge', it.status));
    pills.appendChild(it.owner ? el('span', 'pn-badge', 'Owner: ' + it.owner) : el('span', 'pn-badge bd-unassigned', 'Unassigned'));
    if (it.priority) pills.appendChild(el('span', 'pn-badge', 'Priority: ' + it.priority));
    if (it.size) pills.appendChild(el('span', 'pn-badge bd-size-pill', 'Size: ' + it.size));
    panel.appendChild(pills);

    // B43: description (plain text, line breaks kept by CSS), what it links to, and how it ended. Text only.
    if (it.description) {
      const ds = section('Description');
      ds.appendChild(el('div', 'bd-desc', it.description));
      panel.appendChild(ds);
    }
    if (it.docs && it.docs.length) {
      const dc = section('Documents (' + it.docs.length + ')');
      const ul = el('ul', 'bd-docs');
      it.docs.forEach(d => ul.appendChild(docRow(d)));
      dc.appendChild(ul);
      panel.appendChild(dc);
    }
    if (it.outcome) {
      const os = section('Outcome');
      os.appendChild(el('div', 'bd-desc', it.outcome));
      panel.appendChild(os);
    }

    // Time: start / due are typed by a person; created / updated / closed are set by the CLI. A missing date is not shown.
    const tsec = section('Time');
    const dl = el('dl', 'bd-time');
    const row = (k, v, cls) => { if (!v) return; dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', cls, v)); };
    row('Start', it.start);
    row('Due', dueText(it), B.isOverdue(it) ? 'over' : null);
    row('Created', it.created);
    row('Updated', it.updated);
    row('Closed', it.closed);
    if (!dl.children.length) dl.appendChild(el('dd', null, 'no dates yet'));
    tsec.appendChild(dl);
    panel.appendChild(tsec);

    // Relations between b-items
    const rel = (label, ids) => {
      if (!ids.length) return;
      const s = section(label);
      s.appendChild(itemChips(ids));
      panel.appendChild(s);
    };
    rel('Part of', it.parent ? [it.parent] : []);
    rel('Contains', B.children(it.id).map(k => k.id));
    rel('Depends on', it.dependsOn || []);
    rel('Blocks', B.dependents(it.id).map(d => d.id));

    // The c-items it touches (own links plus those of nested items). A chip only flies the camera: the highlight stays.
    const nodes = B.litNodeIds(it.id).map(id => M.nodeById(id)).filter(Boolean);
    const lsec = section('Lights up (' + nodes.length + ' c-item' + (nodes.length === 1 ? '' : 's') + ')');
    const chips = el('div', 'pn-deps');
    nodes.forEach(n => {
      const btn = el('button', 'pn-dep-chip', n.name || n.id);
      btn.type = 'button';
      btn.title = 'Fly to ' + n.id;
      btn.addEventListener('click', () => M.flyTo(n.id));
      chips.appendChild(btn);
    });
    // P16-B17b: a uid with no node is either a real dead link (the plan has no such element: `c4mp check` says so with a
    // board-dead-link finding) or a valid plan element that is not drawn (e.g. plan-only, below the zoom level).
    (it.deadLinks || []).forEach(uid => {
      const unknown = unknownUids.has(it.id + '\u0000' + uid);
      const dead = el('span', 'pn-dep-chip ' + (unknown ? 'bd-dead' : 'bd-undrawn'), (unknown ? '✗ ' : '○ ') + uid);
      dead.title = unknown ? 'Unknown uid: no plan element has it (dead link)' : 'No node on the map for this uid (the plan element exists but is not drawn)';
      chips.appendChild(dead);
    });
    if (!chips.children.length) chips.appendChild(el('span', 'bd-none', 'no c-items linked'));
    lsec.appendChild(chips);
    if (nodes.length && typeof B.zoomToLinked === 'function') {
      const zb = el('button', 'bd-zoom', 'Zoom to these c-items');
      zb.type = 'button';
      zb.addEventListener('click', () => B.zoomToLinked());
      lsec.appendChild(zb);
    }
    panel.appendChild(lsec);
    const testSec = testsSection(it);
    if (testSec) panel.appendChild(testSec);
    if (LIVE) panel.appendChild(editSection(it));
  }

  // T26-12 (D19): the tests of the c-items the item links itself (as `c4mp board show --with-tests`): to run (attached to
  // them or below them), to write (planned in the plan) and touching them. Only on a page with test data
  // (C4PM_DATA.tests, ViewNode.tests); the rows are panel.js's (C4PM_PANEL_TESTS), so they read as in a c-item's panel.
  function testsSection(it) {
    const T = window.C4PM_DATA && window.C4PM_DATA.tests;
    const P = window.C4PM_PANEL_TESTS;
    const nodes = (it.linked || []).map(l => M.nodeById(l.nodeId)).filter(Boolean);
    if (!T || !P || !nodes.length) return null;
    const run = new Set();
    const touch = new Set();
    const write = new Set();
    nodes.forEach(n => {
      const t = n.tests;
      if (!t) return;
      t.ids.concat(t.children || []).forEach(i => run.add(i));
      (t.touches || []).forEach(i => touch.add(i));
      (t.toWrite || []).forEach(i => write.add(i));
    });
    run.forEach(i => touch.delete(i));
    const sorted = s => [...s].sort((a, b) => a - b);
    const sec = section('Tests (' + run.size + ' to run · ' + write.size + ' to write · ' + touch.size + ' touching)');
    if (!run.size && !write.size && !touch.size) {
      sec.appendChild(el('span', 'bd-none', 'no tests attached to the linked c-items and none planned'));
      return sec;
    }
    if (run.size) sec.appendChild(P.renderTestList(sorted(run).map(i => [i, 'child'])));
    if (write.size) {
      sec.appendChild(el('div', 'pn-tests-sub', 'To write (planned in the plan)'));
      sec.appendChild(P.renderWriteList(sorted(write)));
    }
    if (touch.size) {
      sec.appendChild(el('div', 'pn-tests-sub', 'Attached elsewhere, touching these'));
      sec.appendChild(P.renderTestList(sorted(touch).map(i => [i, 'touch'])));
    }
    return sec;
  }

  function onBoardChange() {
    const id = B.selectedId();
    if (!id) return;   // no selected b-item: #panel is whatever panel.js drew
    const it = B.item(id);
    const panel = document.getElementById('panel');
    if (!it || !panel) return;
    panel.innerHTML = '';
    renderItem(panel, it);
  }
  B.onChange(onBoardChange);

  // ---- B31: a c-item's panel lists the b-items that touch it ----
  // panel.js has already redrawn #panel when this runs (its map listener is registered first), so the section is appended.
  // Only items of boards that are not archived, matched by the c-item's uid; nodes without a uid (files, functions) get none.
  const byUid = new Map();   // uid -> [{ item, entry }]
  B.boards().forEach(entry => {
    (entry.items || []).forEach(it => {
      (it.links || []).forEach(uid => {
        if (!byUid.has(uid)) byUid.set(uid, []);
        if (!byUid.get(uid).some(r => r.item === it)) byUid.get(uid).push({ item: it, entry });
      });
    });
  });

  function linkedRow(r) {
    const btn = el('button', 'bd-row');
    btn.type = 'button';
    btn.title = r.entry.name + ' · ' + r.item.status;
    // the class comes from the kind word only when it is a plain word (a kind is data from board.json)
    const kind = el('span', 'bd-kind' + (/^[a-z-]+$/.test(r.item.kind) ? ' bk-' + r.item.kind : ''), (r.item.kind || '?').charAt(0).toUpperCase());
    btn.appendChild(kind);
    btn.appendChild(el('span', 'bd-id', r.item.id));
    btn.appendChild(el('span', 'bd-t', r.item.title));
    btn.appendChild(el('span', 'bd-st', r.item.status));
    btn.addEventListener('click', () => { B.open(); B.select(r.item.id); });
    return btn;
  }

  M.onSelect(node => {
    if (!node || !node.uid) return;
    const rows = byUid.get(node.uid);
    const panel = document.getElementById('panel');
    if (!rows || !rows.length || !panel) return;
    const sec = section('Board items (' + rows.length + ')');
    const list = el('div', 'bd-rows');
    rows.forEach(r => list.appendChild(linkedRow(r)));
    sec.appendChild(list);
    panel.appendChild(sec);
  });
})();
