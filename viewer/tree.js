// P13-T3a: left panel. Tabs (Architecture / Files) and the Architecture tree built from
// window.C4PM_DATA.root. Does nothing when #left or window.C4PM_MAP is missing (fake-DOM tests).
// Tree depth per Decision 12: system > container > component > file slice; functions are
// rendered lazily when their parent row is expanded.
// UI5 (b755): the first tab is named after the view (Architecture / IO / Storage); row decorators (C4PM_TREE.decorate(fn),
// fn(row, node) on every row as it is made, lazy rows too; C4PM_TREE.redecorate() re-runs them on the rows that exist). A decorator
// must be idempotent: it removes what it added, then adds (sim-list.js lights the rows of the selected s-item this way).
(function () {
  const FLAG = { shared: 'auto', unassigned: 'unassigned' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build() {
    const left = document.getElementById('left');
    if (!left || !window.C4PM_MAP || !window.C4PM_DATA || !window.C4PM_DATA.root) {
      console.debug('[C4PM_TREE] skipped', {
        left: !!left, map: !!window.C4PM_MAP, root: !!(window.C4PM_DATA && window.C4PM_DATA.root),
      });
      return;
    }
    // P20-T5-D (b258): the tree to show follows the mode at build time (and again in rebuild()). VIEW-0 (b337): it is the tree
    // map.js loadTree swapped in (mode.js set), C4PM_STATE.data.root.
    const rootFor = () => window.C4PM_STATE.data.root;
    let root = rootFor();
    // default: the root is open, so containers show; a renderer view (IO) also opens its apps one level (their entries show, as in the demo).
    // C1-CTX + C1 A1 (b828): a holder root (the C1 context) has no row: its children (persons, the system, externals) are the top
    // rows, and they start open, so the system's containers show (an external holding containers shows them too).
    const isHolder = n => !!(window.C4PM_MODE && window.C4PM_MODE.isHolder(n.kind));
    const openAtStart = r => [r.id].concat((window.C4PM_MODE && window.C4PM_MODE.renderer()) || isHolder(r) ? (r.children || []).map(c => c.id) : []);
    const expanded = new Set(openAtStart(root));
    left.hidden = false;
    // b230: search moved to the top bar (#header, owned by panel.js), so #left holds only the tree.
    // The id filter below is a leftover from P13-T3b and matches nothing now; it is harmless.
    Array.prototype.slice.call(left.children).forEach(c => {
      if (c.id !== 'search' && c.id !== 'search-results') left.removeChild(c);
    });
    const map = window.C4PM_MAP;
    const ctl = {}; // node id -> { row, node, kids, setOpen(bool) } for every row currently rendered
    const decorators = []; // UI5 (b755): fn(row, node), run on each row before it is added and again by redecorate()
    const decorateRow = (row, node) => decorators.forEach(fn => fn(row, node));
    // UI5 (b755): the first tab says which tree it shows: the current view's label without ' view'
    const viewLabel = () => {
      const M = window.C4PM_MODE, V = window.C4PM_VIEWS;
      const spec = M && V ? V[M.get()] : null;
      return ((spec && spec.label) || 'Architecture').replace(/ view$/, '');
    };

    // ---- tabs ----
    const tabs = el('div', 'lt-tabs');
    tabs.setAttribute('role', 'tablist');
    const bodies = {};
    const buttons = {};
    let tab = 'arch';   // the active tab (SV9b: kept by the view state)
    function showTab(name) {
      console.debug('[C4PM_TREE] showTab', name);
      tab = name;
      Object.keys(bodies).forEach(k => {
        bodies[k].hidden = k !== name;
        buttons[k].setAttribute('aria-selected', k === name ? 'true' : 'false');
        buttons[k].classList.toggle('active', k === name);
      });
    }
    [['arch', viewLabel()], ['files', 'Files']].forEach(([key, label]) => {
      const b = el('button', 'lt-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.onclick = () => showTab(key);
      buttons[key] = b;
      tabs.appendChild(b);
      const body = el('div', 'lt-body');
      body.id = 'lt-' + key;
      bodies[key] = body;
    });
    left.appendChild(tabs);
    left.appendChild(bodies.arch);
    left.appendChild(bodies.files); // filled by buildFiles() below (P13-T4)

    // ---- architecture tree ----
    const treeEl = el('div', 'lt-tree');
    treeEl.setAttribute('role', 'tree');

    // P14-L4-5b: 'planned only' filter. A node is kept when its builtState is 'planned' or 'stub', or when a
    // kept node is below it (so its ancestors stay visible). Filter off = every child, as before.
    let plannedOnly = false;
    const keepMemo = new Map();
    function keeps(n) {
      if (!keepMemo.has(n)) {
        keepMemo.set(n, n.builtState === 'planned' || n.builtState === 'stub' || kidsOf(n).some(keeps));
      }
      return keepMemo.get(n);
    }
    // Phase 28 LK-G: a container's plan subregions (node.subregions) are group rows: each subregion row holds its components (the
    // container's children whose `subregion` is its id; map.js set the subregion's parent), the components with no subregion follow.
    function kidsOf(node) {
      if (node.kind === 'subregion') return node.parent ? node.parent.children.filter(k => k.subregion === node.id) : [];
      if (!node.subregions || !node.subregions.length) return node.children || [];
      return node.subregions.concat((node.children || []).filter(k => k.subregion === undefined));
    }
    function visibleKids(node) {
      const kids = kidsOf(node);
      return plannedOnly ? kids.filter(keeps) : kids;
    }
    // Turning the filter on opens every ancestor of a kept node, so the kept rows are not hidden in closed parents.
    function openKeptAncestors(node) {
      const kept = visibleKids(node);
      if (kept.length) expanded.add(node.id);
      kept.forEach(openKeptAncestors);
    }
    const filterLabel = el('label', 'lt-filter');
    const filterBox = el('input');
    filterBox.type = 'checkbox';
    filterBox.id = 'lt-planned-only';
    filterLabel.appendChild(filterBox);
    filterLabel.appendChild(document.createTextNode(' planned only'));
    bodies.arch.appendChild(filterLabel);
    bodies.arch.appendChild(treeEl);

    function renderNode(node, depth, parentEl) {
      const kids = visibleKids(node);
      const isOpen = expanded.has(node.id);
      const row = el('div', 'lt-row');
      row.dataset.id = node.id;
      row.dataset.kind = node.kind;
      row.style.paddingLeft = (8 + depth * 14) + 'px';
      row.setAttribute('role', 'treeitem');

      const twist = el('span', 'lt-twist', kids.length ? (isOpen ? '▾' : '▸') : '');
      row.appendChild(twist);
      row.appendChild(el('span', 'lt-tag lt-tag-' + node.kind, (window.C4PM_MODE && window.C4PM_MODE.tag((node.io && node.io.kind) || node.kind)) || node.kind));   // b142: chip word from the kind table (mode.js); b284: an IO entry shows its real kind (node.io.kind)
      row.appendChild(el('span', 'lt-name', node.name));
      // STOR-6b (b340): a node with storage data (store, record, field) also shows the word of its technology (database, table, column)
      if (node.storage && node.word) row.appendChild(el('span', 'lt-flag', node.word));
      if (FLAG[node.kind]) row.appendChild(el('span', 'lt-flag lt-flag-' + FLAG[node.kind], FLAG[node.kind]));
      // P14-T44b: plan-only node (T44a) has no code yet -- dim note, same style as the row flags.
      // C1 A2 (b829): only for a kind that needs code (C4PM_MODE.needsCode, from KIND_TABLE): never on a person or an external.
      if (node.planOnly && (!window.C4PM_MODE || window.C4PM_MODE.needsCode(node.kind))) row.appendChild(el('span', 'lt-flag', 'planned (no code yet)'));
      if (kids.length) row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (map.selectedId && map.selectedId() === node.id) row.classList.add('selected');
      // Row click: fly there, then select (same order as panel.js goTo). The highlight comes back
      // through onSelect below, which only paints and never calls select (no feedback loop).
      row.onclick = () => {
        console.debug('[C4PM_TREE] row click', node.id);
        map.flyTo(node.id);
        map.select(node.id);
      };
      decorateRow(row, node);
      parentEl.appendChild(row);
      ctl[node.id] = { row, node, kids: kids.length, setOpen: null };

      let childBox = null;
      function fill() {
        // children rows are created only when open (lazy), so big repos stay fast
        childBox.textContent = '';
        kids.forEach(k => renderNode(k, depth + 1, childBox));
      }
      if (kids.length) {
        childBox = el('div', 'lt-children');
        childBox.setAttribute('role', 'group');
        childBox.hidden = !isOpen;
        parentEl.appendChild(childBox);
        if (isOpen) fill();
        const setOpen = (open) => {
          if (open) expanded.add(node.id); else expanded.delete(node.id);
          console.debug('[C4PM_TREE] toggle', node.id, open ? 'open' : 'closed', 'children', kids.length);
          twist.textContent = open ? '▾' : '▸';
          row.setAttribute('aria-expanded', open ? 'true' : 'false');
          childBox.hidden = !open;
          if (open && !childBox.firstChild) fill();
        };
        ctl[node.id].setOpen = setOpen;
        twist.onclick = (ev) => {
          ev.stopPropagation();
          setOpen(!expanded.has(node.id));
        };
      }
    }
    // The top rows: the root, or (C1 A1) a holder root's visible children at depth 0.
    function renderRoot() {
      if (isHolder(root)) visibleKids(root).forEach(k => renderNode(k, 0, treeEl));
      else renderNode(root, 0, treeEl);
    }
    renderRoot();
    // P14-L4-5b: rebuild the rows for the filter state, then paint the current selection again.
    function renderTree() {
      treeEl.textContent = '';
      Object.keys(ctl).forEach(k => { delete ctl[k]; });
      renderRoot();
      const sel = map.selectedId ? map.selectedId() : null;
      if (sel) reveal(sel);
    }
    // P20-T5-D (b258): show another tree (io <-> arch). Opens only the new root, drops the old filter memo,
    // keeps the planned-only checkbox state, then paints the current selection if the new tree has it.
    function rebuild(newRoot) {
      console.debug('[C4PM_TREE] rebuild', newRoot.id);
      root = newRoot;
      buttons.arch.textContent = viewLabel();
      expanded.clear();
      openAtStart(root).forEach(id => expanded.add(id));
      keepMemo.clear();
      if (plannedOnly) openKeptAncestors(root);
      renderTree();
    }
    filterBox.onchange = () => {
      plannedOnly = filterBox.checked;
      console.debug('[C4PM_TREE] planned only', plannedOnly);
      if (plannedOnly) openKeptAncestors(root);
      renderTree();
    };

    // ---- files tab (P13-T4) ----
    // data.files: ViewFile[] {path, kind:'source'|'plan', owners[], flag?}. Directory tree by path
    // segments; plan paths starting '../' sit under a synthetic "plan" group (full path as the name).
    // Directories are not clickable (twist toggles only). Source file click: C4PM_PANEL.showFile(path)
    // when it exists, then Decision 7: fly/select `${owners[0]}::slice::${path}`. Plan file: showFile only.
    const files = Array.isArray(window.C4PM_DATA.files) ? window.C4PM_DATA.files : [];
    const filesBody = bodies.files;
    const fileRows = {}; // path -> row
    let fromFiles = false; // true while a Files-tab click drives map.select, so reveal() keeps this tab
    const filesOpen = new Set();

    function insertFile(dirNode, f, name) {
      dirNode.files.push({ file: f, name });
    }
    function buildFileTree() {
      const top = { dirs: {}, files: [] };
      files.forEach(f => {
        if (!f || typeof f.path !== 'string') { console.debug('[C4PM_TREE] files: skipped bad entry', f); return; }
        if (f.path.indexOf('../') === 0) {
          if (!top.dirs.plan) top.dirs.plan = { dirs: {}, files: [] };
          insertFile(top.dirs.plan, f, f.path);
          return;
        }
        const parts = f.path.split('/');
        let d = top;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!d.dirs[parts[i]]) d.dirs[parts[i]] = { dirs: {}, files: [] };
          d = d.dirs[parts[i]];
        }
        insertFile(d, f, parts[parts.length - 1]);
      });
      return top;
    }
    function countLeaves(d) {
      return d.files.length + Object.keys(d.dirs).reduce((s, k) => s + countLeaves(d.dirs[k]), 0);
    }
    function onFileClick(f) {
      console.debug('[C4PM_TREE] file click', f.path, f.kind, 'owners', f.owners, 'flag', f.flag);
      Object.keys(fileRows).forEach(p => fileRows[p].classList.toggle('selected', p === f.path));
      if (window.C4PM_PANEL && typeof window.C4PM_PANEL.showFile === 'function') {
        window.C4PM_PANEL.showFile(f.path);
      } else {
        console.debug('[C4PM_TREE] showFile unavailable (C4PM_PANEL missing), skipped');
      }
      if (f.kind !== 'source') return; // plan file: panel only, nothing on the map
      if (f.role === 'test') return;   // Phase 26 (D8): a test file has no box on the map either
      const owners = f.owners || [];
      if (!owners.length) { console.debug('[C4PM_TREE] file has no owner, nothing to select', f.path); return; }
      const sliceId = owners[0] + '::slice::' + f.path;
      fromFiles = true;
      try {
        map.flyTo(sliceId);
        const ok = map.select(sliceId);
        console.debug('[C4PM_TREE] select slice', sliceId, ok ? 'ok' : 'unknown id (no slice on map)');
      } finally {
        fromFiles = false;
      }
    }
    // Why a file is flagged (plan files and unflagged files: no reason).
    function fileReason(file) {
      if (file.kind === 'plan') return '';
      if (file.noFunctions) return 'no functions';
      if (file.flag === 'unassigned') return 'unassigned code';
      if (file.flag === 'shared') return 'shared code';
      if (file.flag === 'split') return 'owned by 2+ components';
      if (file.flag === 'test-only') return 'used by tests only';   // Phase 26 (0.2b)
      return '';
    }
    function renderFileDir(d, depth, parentEl, dirKey) {
      Object.keys(d.dirs).sort().forEach(name => {
        const sub = d.dirs[name];
        const key = dirKey + '/' + name;
        const isOpen = depth === 0 || filesOpen.has(key); // top level starts open
        const row = el('div', 'lt-row');
        row.dataset.dir = key;
        row.style.paddingLeft = (8 + depth * 14) + 'px';
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        const twist = el('span', 'lt-twist', isOpen ? '▾' : '▸');
        row.appendChild(twist);
        row.appendChild(el('span', 'lt-name', name + '/'));
        row.appendChild(el('span', 'lt-flag', String(countLeaves(sub))));
        parentEl.appendChild(row);
        const box = el('div', 'lt-children');
        box.setAttribute('role', 'group');
        box.hidden = !isOpen;
        parentEl.appendChild(box);
        if (isOpen) filesOpen.add(key);
        let filled = false;
        const fill = () => { filled = true; renderFileDir(sub, depth + 1, box, key); };
        if (isOpen) fill();
        twist.onclick = (ev) => {
          ev.stopPropagation();
          const open = box.hidden; // currently closed -> open
          if (open) filesOpen.add(key); else filesOpen.delete(key);
          console.debug('[C4PM_TREE] files toggle', key, open ? 'open' : 'closed');
          twist.textContent = open ? '▾' : '▸';
          row.setAttribute('aria-expanded', open ? 'true' : 'false');
          box.hidden = !open;
          if (open && !filled) fill();
        };
      });
      d.files.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).forEach(({ file, name }) => {
        const row = el('div', 'lt-row');
        row.dataset.path = file.path;
        row.dataset.kind = file.kind;
        row.style.paddingLeft = (8 + depth * 14) + 'px';
        row.setAttribute('role', 'treeitem');
        row.title = file.path;
        row.appendChild(el('span', 'lt-twist', ''));
        // Phase 26 (D8): a test file keeps its row, tagged 'test' (its cases are listed on the c-items they test)
        row.appendChild(el('span', 'lt-tag' + (file.role === 'test' ? ' lt-tag-test' : ''), file.kind === 'plan' ? 'c4' : file.role === 'test' ? 'test' : 'file'));
        row.appendChild(el('span', 'lt-name', name));
        if (file.flag) row.appendChild(el('span', 'lt-flag lt-flag-' + file.flag, file.flag));
        if (file.fileOnly) row.appendChild(el('span', 'lt-flag lt-flag-fileonly', 'file-only (no parser)'));
        const reason = fileReason(file);
        if (reason) {
          const rs = el('span', 'lt-reason', reason);
          rs.style.marginLeft = '6px';
          rs.style.fontSize = '11px';
          rs.style.opacity = '0.7';
          row.appendChild(rs);
          row.title = file.path + ' - ' + reason;
        }
        row.onclick = () => onFileClick(file);
        fileRows[file.path] = row;
        parentEl.appendChild(row);
      });
    }
    if (!files.length) {
      buttons.files.hidden = true;
      console.debug('[C4PM_TREE] files: none, Files tab hidden');
    } else {
      const ft = el('div', 'lt-tree');
      ft.setAttribute('role', 'tree');
      filesBody.appendChild(ft);
      renderFileDir(buildFileTree(), 0, ft, '');
      console.debug('[C4PM_TREE] files built, leaves', ft.querySelectorAll('.lt-row[data-path]').length, 'of', files.length);
    }
    showTab('arch');

    // Paint the selection for `id` (null clears): highlight its row, open every ancestor, scroll to it.
    function reveal(id) {
      Array.prototype.slice.call(treeEl.querySelectorAll('.lt-row.selected')).forEach(r => r.classList.remove('selected'));
      if (!fromFiles) Object.keys(fileRows).forEach(p => fileRows[p].classList.remove('selected'));
      if (!id) { console.debug('[C4PM_TREE] reveal: cleared'); return; }
      const open = aid => {
        const c = ctl[aid];
        if (c && c.setOpen && !expanded.has(aid)) c.setOpen(true); // root-down, so each row exists by now
      };
      const chain = map.ancestorsOf(id).concat(id);
      chain.forEach((aid, i) => {
        const n = map.nodeById(aid);
        if (n && n.subregion) open(n.subregion);   // LK-G: its subregion's group row sits between its container and it
        if (i < chain.length - 1) open(aid);
      });
      const c = ctl[id];
      if (!c) { console.debug('[C4PM_TREE] reveal: no row for', id); return; }
      if (!fromFiles) showTab('arch'); // a Files-tab click must not bounce the user back to Architecture
      c.row.classList.add('selected');
      if (c.row.scrollIntoView) c.row.scrollIntoView({ block: 'nearest' });
      console.debug('[C4PM_TREE] reveal', id);
    }
    map.onSelect(node => reveal(node ? node.id : null));
    if (map.selectedId && map.selectedId()) reveal(map.selectedId());

    console.debug('[C4PM_TREE] built, rows', treeEl.querySelectorAll('.lt-row').length);
    // UI5 (b755): add a row decorator (it runs on the rows that exist now too); re-run every decorator on the rendered rows.
    function redecorate() {
      Object.keys(ctl).forEach(id => decorateRow(ctl[id].row, ctl[id].node));
    }
    function decorate(fn) {
      if (typeof fn !== 'function') throw new Error('C4PM_TREE.decorate: fn must be a function');
      decorators.push(fn);
      Object.keys(ctl).forEach(id => fn(ctl[id].row, ctl[id].node));
    }
    window.C4PM_TREE = { expanded, reveal, rebuild, decorate, redecorate };
    // P20-T5-D (b258): subscribe once at load; mode.js has already loaded the tree it names before listeners run.
    if (window.C4PM_MODE) window.C4PM_MODE.onChange(() => rebuild(rootFor()));

    // Phase 30 SV9b (b642): the view-state part 'tree' = { view, open, tab, top }: the expanded rows of the current view's tree
    // (ids), the active tab and the scroll of its body. Kept rows of another view's tree, or ids no longer in the tree, are skipped.
    // The left column width is not in it: index.html keeps it in localStorage c4pm.leftWidth. viewState.js loads after this file,
    // and build() runs at DOMContentLoaded (or at once in a loaded page), so the part is added through C4PM_STATE.whenReady (state.js:
    // on the next timer, before the restore).
    const finite = n => typeof n === 'number' && isFinite(n);
    function treeIds() {
      const ids = new Set();
      const walk = n => { ids.add(n.id); kidsOf(n).forEach(walk); };
      walk(root);
      return ids;
    }
    const treePart = {
      get: () => ({ view: window.C4PM_MODE ? window.C4PM_MODE.get() : null, open: Array.from(expanded), tab, top: bodies[tab].scrollTop || 0 }),
      set: v => {
        if (!v || typeof v !== 'object') return;
        const view = window.C4PM_MODE ? window.C4PM_MODE.get() : null;
        if (Array.isArray(v.open) && v.view === view) {
          const ids = treeIds();
          expanded.clear();
          v.open.forEach(id => { if (typeof id === 'string' && ids.has(id)) expanded.add(id); });
          if (plannedOnly) openKeptAncestors(root);
          renderTree();   // paints the selection again (reveal)
        }
        if (typeof v.tab === 'string' && Object.prototype.hasOwnProperty.call(bodies, v.tab) && !buttons[v.tab].hidden) showTab(v.tab);
        if (finite(v.top) && v.top > 0) bodies[tab].scrollTop = v.top;
      },
    };
    if (window.C4PM_STATE) window.C4PM_STATE.whenReady(() => { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.part('tree', treePart); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
