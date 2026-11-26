// storagePanel.js: the storage view panel (store, record, field: fields, FKs, drift, owner).
// LAY-12c (b389): split out of panel.js; registers P.storage on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const data = window.C4PM_DATA;
  const { plural, root, parents, treeEdges, findViewFile, findNodeById } = P.vm;
  const { section, goTo, renderMetaPills, renderVscodeLink, ioLink, pillsOf, chipsSection, idRowOf, lineOf } = P.kit;
  const { openArch } = P.io;

  // ===== STOR-6b (b340): storage view panel (c-item renderStorageNode). Data: the storage-view nodes of STOR-5
  // (src/view/storageModel.ts; ViewStorage in src/types.ts): a store (detail = technology, word), a record (file, line, word,
  // storage.origin / indexes / checks), a field (meta.type, storage.pk / nullable / unique / fk / onDelete / diff); the loaded tree's
  // edges are the FK edges field -> field (C4PM_STATE.data.edges = C4PM_DATA.storageView.edges). The owner of a record = the components
  // that own its file (C4PM_DATA.files[].owners, arch node ids). The b-items of a node with a uid: board-panel.js (by uid). =====
  // What a field drift kind says (FieldDiffKind, src/storage/fieldDiff.ts)
  const DRIFT_WORDS = { missing: 'not in the plan', extra: 'not in the code', type: 'type differs from the plan', nullable: 'nullability differs from the plan', fk: 'FK differs from the plan' };
  const ORIGIN_WORDS = { both: 'in the plan and the code', code: 'code-only: in the code, not in the plan', plan: 'plan-only: in the plan, not in the code' };

  // the nearest record at or above a storage node (a field's record; nested fields climb), null above records
  function recordOf(n) {
    let x = n;
    while (x && x.kind !== 'record') x = parents()[x.id];
    return x || null;
  }
  // every field below `n`, depth first (nested fields follow their parent)
  function fieldsBelow(n, out) {
    out = out || [];
    (n.children || []).forEach(c => { if (c.kind === 'field') { out.push(c); fieldsBelow(c, out); } });
    return out;
  }
  // the field path below its record ('address.city' for a nested field), and 'record.field'
  function fieldNames(f) {
    const names = [];
    for (let x = f; x && x.kind === 'field'; x = parents()[x.id]) names.unshift(x.name);
    return names.join('.');
  }
  function fieldPath(f) {
    const rec = recordOf(f);
    return (rec ? rec.name + '.' : '') + fieldNames(f);
  }
  const fkFlags = s => (s.fk ? ['FK ' + s.fk + (s.onDelete ? ' on delete ' + s.onDelete : '')] : []);
  const fieldFlags = s => [s.pk ? 'PK' : null, s.nullable ? 'nullable' : 'not null', s.unique ? 'unique' : null].filter(Boolean).concat(fkFlags(s));
  const driftTexts = s => (s.diff || []).map(k => DRIFT_WORDS[k] || k);
  // The Fields table of a record: one row per field (nested ones as parent.child): name, flags (PK, not null, unique, FK + on delete,
  // drift) and the type on the right; a row selects its field.
  function renderFieldRows(rec) {
    const fields = fieldsBelow(rec);
    const sec = section('Fields', String(fields.length));
    const list = document.createElement('div');
    list.className = 'pn-children';
    fields.forEach(f => {
      const s = f.storage || {};
      const row = document.createElement('button');
      row.className = 'pn-child-row';
      row.title = f.id;
      const name = document.createElement('div');
      name.className = 'pn-child-name';
      name.appendChild(document.createTextNode(fieldNames(f)));
      const flags = fieldFlags(s).concat(driftTexts(s).map(t => 'drift: ' + t));
      const small = document.createElement('small');
      small.textContent = flags.join(' · ');
      name.appendChild(small);
      row.appendChild(name);
      const type = document.createElement('div');
      type.className = 'pn-child-weight';
      type.textContent = (f.meta && f.meta.type) || '';
      row.appendChild(type);
      row.onclick = () => goTo(f.id);
      list.appendChild(row);
    });
    sec.appendChild(list);
    return sec;
  }
  // FK rows: a chip that selects the other end (its record, or its field when `toField`), then 'from -> to · on delete x'
  function renderFkRows(title, edges, otherOf, toField) {
    const sec = section(title, String(edges.length));
    if (!edges.length) { sec.appendChild(lineOf('pn-note', 'none')); return sec; }
    edges.forEach(e => {
      const from = findNodeById(root(), e.from), to = findNodeById(root(), e.to), other = otherOf === 'to' ? to : from;
      const target = other && (toField ? other : recordOf(other));
      const row = document.createElement('div');
      row.className = 'pn-rel';
      if (target) row.appendChild(ioLink(target.id, toField ? fieldPath(target) : target.name));
      else console.error(PANEL_TAG, 'storage FK edge end is not in the tree', { from: e.from, to: e.to });
      const note = document.createElement('span');
      note.className = 'pn-detail';
      note.textContent = ' ' + (from ? fieldPath(from) : e.from) + ' → ' + (to ? fieldPath(to) : e.to) + (e.label ? ' · on delete ' + e.label : '');
      row.appendChild(note);
      sec.appendChild(row);
    });
    return sec;
  }
  // Owner: the components that own the record's file (ViewFile.owners); each chip opens the architecture view on it (openArch).
  function renderStorageOwner(rec) {
    const sec = section('Owner');
    if (!rec.file) { sec.appendChild(lineOf('pn-detail', 'no owner (no code file)')); return sec; }
    const vf = findViewFile(rec.file);
    if (!vf) {
      console.debug(PANEL_TAG, 'storage owner: the record file is not in the page files', { id: rec.id, file: rec.file });
      sec.appendChild(lineOf('pn-detail', 'no owner (' + rec.file + ' is not in the scanned files)'));
      return sec;
    }
    if (!vf.owners.length) { sec.appendChild(lineOf('pn-detail', 'no owner')); return sec; }
    const row = document.createElement('div');
    row.className = 'pn-deps';
    vf.owners.forEach(id => {
      const n = findNodeById(data.root, id);
      const btn = document.createElement('button');
      btn.className = 'pn-dep-chip';
      btn.title = id;
      btn.textContent = n ? n.name : id;
      btn.onclick = () => { console.debug(PANEL_TAG, 'storage owner click', { record: rec.id, owner: id }); openArch([id]); };
      row.appendChild(btn);
    });
    sec.appendChild(row);
    return sec;
  }
  function renderStorageNode(panel, node) {
    const s = node.storage;
    if (!s) {
      console.error(PANEL_TAG, 'storage node without storage data', node.id);
      panel.appendChild(lineOf('pn-note', 'no storage data for ' + node.id));
      return;
    }
    panel.appendChild(idRowOf(node));
    const status = renderMetaPills(node);   // meta.status of a plan element
    if (status) panel.appendChild(status);
    const edges = treeEdges();
    if (node.kind === 'store') {
      const recs = (node.children || []).filter(c => c.kind === 'record');
      const word = recs.length && recs[0].word ? recs[0].word : 'record';
      panel.appendChild(pillsOf([node.detail || 'no technology', recs.length + ' ' + plural(recs.length, word)]));
      panel.appendChild(chipsSection('Contents', recs));
      return;
    }
    if (node.kind === 'record') {
      const store = parents()[node.id];
      panel.appendChild(pillsOf([node.word || 'record'].concat(store && store.detail ? [store.detail] : [])));
      panel.appendChild(lineOf('pn-detail', ORIGIN_WORDS[s.origin] || s.origin));
      if (node.file) {
        panel.appendChild(lineOf('pn-detail', node.file + (node.line ? ':' + node.line : '')));
        const vlink = renderVscodeLink(node);   // b914: null on a source-less page (no absolute path)
        if (vlink) panel.appendChild(vlink);
      }
      panel.appendChild(renderFieldRows(node));
      const own = new Set(fieldsBelow(node).map(f => f.id));
      panel.appendChild(renderFkRows('References (out)', edges.filter(e => own.has(e.from)), 'to', false));
      panel.appendChild(renderFkRows('Referenced by (in)', edges.filter(e => own.has(e.to)), 'from', false));
      const ixs = s.indexes || [], cks = s.checks || [];
      if (ixs.length) {
        const sec = section('Indexes', String(ixs.length));
        ixs.forEach(ix => sec.appendChild(lineOf('pn-detail', ix.name + ': ' + (ix.unique ? 'unique ' : '') + '(' + ix.columns.join(', ') + ')' + (ix.where ? ' where ' + ix.where : ''))));
        panel.appendChild(sec);
      }
      if (cks.length) {
        const sec = section('Checks', String(cks.length));
        cks.forEach(c => sec.appendChild(lineOf('pn-detail', c.name + (c.expr ? ': ' + c.expr : ''))));
        panel.appendChild(sec);
      }
      panel.appendChild(renderStorageOwner(node));
      return;
    }
    // a field
    panel.appendChild(pillsOf([node.word || 'field'].concat(node.meta && node.meta.type ? [node.meta.type] : [], fieldFlags(s))));
    panel.appendChild(lineOf('pn-detail', ORIGIN_WORDS[s.origin] || s.origin));
    const rec = recordOf(node);
    if (rec) panel.appendChild(chipsSection('In', [rec]));
    else console.error(PANEL_TAG, 'storage field has no record above it', node.id);
    const drift = driftTexts(s);
    if (drift.length) {
      const sec = section('Drift', String(drift.length));
      drift.forEach(t => sec.appendChild(lineOf('pn-detail', t)));
      panel.appendChild(sec);
    }
    panel.appendChild(renderFkRows('References (out)', edges.filter(e => e.from === node.id), 'to', true));
    panel.appendChild(renderFkRows('Referenced by (in)', edges.filter(e => e.to === node.id), 'from', true));
    const kids = (node.children || []).filter(c => c.kind === 'field');
    if (kids.length) panel.appendChild(chipsSection('Children', kids));
  }

  P.storage = { renderStorageNode };
})();
