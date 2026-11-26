// search.js: the search box (Names / Content, providers); setupSearch defines window.C4PM_SEARCH. panel.js calls P.search.setup().
// LAY-12c (b389): split out of panel.js; registers P.search on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const data = window.C4PM_DATA;
  const map = window.C4PM_MAP;
  const { getBreadcrumb, root, archTree, parents, syncParents, entryKind, isStorageNode, findNodeById } = P.vm;

  // ===== Search =====
  function setupSearch() {
    const searchInput = document.getElementById('search');
    const searchResults = document.getElementById('search-results');

    if (!searchInput || !searchResults) return;

    // Build searchable index
    // P20-T5-E (b259): in the IO view the index holds the groups and screens (not the '(io)' root); rebuilt on mode change.
    // STOR-6b (b340): the root of any tree but the architecture one stays out ('(storage)' is never a hit); records and fields are
    // the storage provider's rows (below), so each appears once; zones and stores stay here.
    const providedKinds = ['record', 'field'];
    let allNodes = [];
    function buildNodeIndex() {
      allNodes = [];
      (function walkNodes(node) {
        // C1 A1 (b828): a holder (the C1 context) is no hit either: it has no tree row and no box (its name is the system's)
        const holder = window.C4PM_MODE && window.C4PM_MODE.isHolder(node.kind);
        if ((node !== root() || archTree()) && !holder && providedKinds.indexOf(node.kind) < 0) allNodes.push(node);
        if (node.children) {
          node.children.forEach(walkNodes);
        }
      })(root());
    }
    buildNodeIndex();

    // ----- b144: Names | Content switch. Content searches the source text the page already holds. -----
    const CONTENT_MIN = 2;          // characters
    const CONTENT_DEBOUNCE = 150;   // ms
    const CONTENT_MAX_ROWS = 50;
    const CONTENT_SNIPPET = 140;    // characters of the matching line shown around the hit
    // P20-T11 (b232): the start mode is the 'search' setting (C4PM_SETTINGS); the settings popup and the switch below both set it.
    let searchMode = window.C4PM_SETTINGS.get('search');
    let contentTimer = null;
    let contentIndex = null;   // built on first Content search: [{ label, where, kind, ref, lines, lower, firstLine }]
    const modeBox = document.getElementById('search-mode');
    const hintBox = document.getElementById('search-hint');
    const modeButtons = {};

    // What the page holds: function/method source (node.code, line numbers from node.line) and embedded plan files (data.files[].lines).
    function buildContentIndex() {
      const idx = [];
      allNodes.forEach(node => {
        if (!Array.isArray(node.code) || !node.code.length) return;
        idx.push({ label: node.name, where: node.file || node.id, kind: 'node', ref: node.id, lines: node.code, firstLine: node.line || 1 });
      });
      (data.files || []).forEach(f => {
        if (!f || !Array.isArray(f.lines) || !f.lines.length) return;
        idx.push({ label: f.path, where: f.path, kind: 'file', ref: f.path, lines: f.lines, firstLine: 1 });
      });
      idx.forEach(e => { e.lower = e.lines.map(l => String(l).toLowerCase()); });
      return idx;
    }

    // ----- SRCH-1 (b235): search providers. Names = what an item is called, Content = what it says. A provider is
    // { id, names(query), content(query), first? }; query = the trimmed lower-case text; each returns rows { el, pick? }. Its rows
    // follow the map rows in registration order; Phase 25 UI6 (b756): the rows of a `first: true` provider (the s-items) come
    // BEFORE the map rows instead. A row without pick (a group label) is shown, not picked. A provider that throws is not
    // wrapped: the error reaches the console.
    const providers = [];
    let pickRows = [];   // provider rows with pick that are in the results now, in order (Enter takes the first one)
    function registerSearchProvider(provider) {
      if (providers.some(p => p.id === provider.id)) throw new Error("search provider '" + provider.id + "' is already registered");
      providers.push(provider);
    }
    // The rows of the providers whose `first` flag equals `first` (true: the ones listed before the map rows), in registration order.
    function providerRows(kind, query, first) {
      const out = [];
      providers.forEach(p => { if (!!p.first === first) p[kind](query).forEach(r => out.push(r)); });
      return out;
    }

    // One result row (the Names map rows, the storage rows): the name, a detail line, the names of its parents. Text only.
    function resultRow(node, detailText, cls) {
      syncParents();   // the typed text runs again on a mode change, before the panel's own listener rebuilt the parent map
      const item = document.createElement('button');
      item.style.display = 'block';
      item.style.width = '100%';
      item.style.padding = '8px 12px';
      item.style.border = 'none';
      item.style.background = 'none';
      item.style.textAlign = 'left';
      item.style.cursor = 'pointer';
      item.style.borderBottom = '1px solid var(--line)';
      item.style.fontSize = '13px';
      item.className = cls || 'pn-search-result';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = node.name;
      nameSpan.style.fontWeight = '500';
      item.appendChild(nameSpan);

      const detailSpan = document.createElement('div');
      detailSpan.textContent = detailText;
      detailSpan.style.fontSize = '12px';
      detailSpan.style.color = 'var(--muted)';
      detailSpan.style.marginTop = '2px';
      item.appendChild(detailSpan);

      const parentChain = getBreadcrumb(node.id, parents()).slice(0, -1);
      if (parentChain.length > 0) {
        const pathSpan = document.createElement('div');
        pathSpan.style.fontSize = '11px';
        pathSpan.style.color = 'var(--muted)';
        pathSpan.style.marginTop = '2px';
        const path = parentChain.map(id => {
          const n = findNodeById(root(), id);
          return n ? n.name : id;
        }).join(' › ');
        pathSpan.textContent = path;
        item.appendChild(pathSpan);
      }
      return item;
    }

    // ----- STOR-6b (b340): the 'storage' search provider (S7). Names = record and field names (the code name or plan title, or the
    // last segment of the id: the plan local id); Content = field types (meta.type), notes (FK, on delete, index and check text) and descriptions (node.detail) of the store,
    // record and field nodes. Rows only for the storage nodes of the loaded tree (C4PM_STATE.data.root), so another view gets none;
    // a pick flies to the node and selects it. At most STORAGE_MAX_ROWS rows per mode.
    const STORAGE_MAX_ROWS = 20;
    let storageMemo = { root: null, nodes: [] };
    function storageNodes() {
      if (storageMemo.root !== root()) {
        const nodes = [];
        (function walk(n) { if (isStorageNode(n)) nodes.push(n); (n.children || []).forEach(walk); })(root());
        storageMemo = { root: root(), nodes };
      }
      return storageMemo.nodes;
    }
    const has = (s, q) => typeof s === 'string' && s.toLowerCase().indexOf(q) >= 0;
    // the last segment of a storage id: a plan fqn 'app.api.db.login' -> 'login', a code id 'db/x.ts#users.id' -> 'id' (the whole
    // id would match every field of a record whose file or record name holds the text)
    const localId = id => id.slice(Math.max(id.lastIndexOf('.'), id.lastIndexOf('#')) + 1);
    // what a storage node says, as [label, text] pairs
    function storageTexts(n) {
      const s = n.storage || {}, out = [];
      if (n.meta && n.meta.type) out.push(['type', n.meta.type]);
      if (s.fk) out.push(['FK', s.fk]);
      if (s.onDelete) out.push(['on delete', s.onDelete]);
      (s.indexes || []).forEach(ix => out.push(['index', ix.name + ' (' + ix.columns.join(', ') + ')' + (ix.where ? ' where ' + ix.where : '')]));
      (s.checks || []).forEach(c => out.push(['check', c.name + (c.expr ? ': ' + c.expr : '')]));
      if (n.detail) out.push(['description', n.detail]);
      return out;
    }
    const storageRow = (n, detailText, cls) => ({ el: resultRow(n, detailText, cls), pick: () => { map.flyTo(n.id); map.select(n.id); } });
    registerSearchProvider({
      id: 'storage',
      names: q => storageNodes()
        .filter(n => providedKinds.indexOf(n.kind) >= 0 && (has(n.name, q) || has(localId(n.id), q)))
        .slice(0, STORAGE_MAX_ROWS)
        .map(n => storageRow(n, [n.word || n.kind].concat(n.meta && n.meta.type ? [n.meta.type] : []).join(' · '))),
      content: q => storageNodes()
        .map(n => ({ n, hit: storageTexts(n).find(t => has(t[1], q)) }))
        .filter(x => x.hit)
        .slice(0, STORAGE_MAX_ROWS)
        .map(x => storageRow(x.n, x.hit[0] + ': ' + x.hit[1], 'pn-search-result pn-search-content')),
    });
    function appendProviderRows(rows) {
      rows.forEach(r => {
        if (r.pick) {
          r.el.addEventListener('click', () => { r.pick(); donePick(); });
          pickRows.push(r);
        }
        searchResults.appendChild(r.el);
      });
    }
    function clearResults() {
      searchResults.innerHTML = '';
      pickRows = [];
    }
    function noResults() {
      const empty = document.createElement('div');
      empty.style.padding = '8px 12px';
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '12px';
      empty.textContent = 'No results';
      searchResults.appendChild(empty);
    }

    // After a pick: empty the box and the results and drop the focus, so the popup (#search-box:focus-within) closes and the panel is free.
    function donePick() {
      searchInput.value = '';
      clearResults();
      const a = document.activeElement;
      if (a && typeof a.blur === 'function') a.blur();
      searchInput.blur();
    }
    function openNode(id) {
      if (map && map.flyTo && map.select) {
        map.flyTo(id);
        map.select(id);
        donePick();
      }
    }

    // Row: name, file:line, then the matching line with the hit in <mark>. Everything is textContent / text nodes: source may contain markup.
    function contentRow(hit) {
      const item = document.createElement('button');
      item.style.display = 'block';
      item.style.width = '100%';
      item.style.padding = '8px 12px';
      item.style.border = 'none';
      item.style.background = 'none';
      item.style.textAlign = 'left';
      item.style.cursor = 'pointer';
      item.style.borderBottom = '1px solid var(--line)';
      item.style.fontSize = '13px';
      item.className = 'pn-search-result pn-search-content';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = hit.entry.label;
      nameSpan.style.fontWeight = '500';
      item.appendChild(nameSpan);

      const loc = document.createElement('div');
      loc.textContent = hit.entry.where + ':' + hit.lineNo;
      loc.className = 'pn-search-loc';
      loc.style.fontSize = '11px';
      loc.style.color = 'var(--muted)';
      loc.style.marginTop = '2px';
      item.appendChild(loc);

      // Skip indentation, then cut a long line to a window around the hit.
      const full = String(hit.text);
      const lead = full.length - full.replace(/^\s+/, '').length;
      let from = Math.min(lead, hit.col);
      if (hit.col - from > CONTENT_SNIPPET / 2) from = hit.col - Math.floor(CONTENT_SNIPPET / 2);
      const to = Math.min(full.length, from + CONTENT_SNIPPET);
      const mEnd = Math.min(hit.col + hit.len, to);
      const line = document.createElement('div');
      line.className = 'pn-search-line';
      line.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
      line.style.fontSize = '12px';
      line.style.marginTop = '2px';
      line.style.whiteSpace = 'pre-wrap';
      line.style.wordBreak = 'break-all';
      line.appendChild(document.createTextNode((from > lead ? '…' : '') + full.slice(from, hit.col)));
      const mark = document.createElement('mark');
      mark.textContent = full.slice(hit.col, mEnd);
      line.appendChild(mark);
      line.appendChild(document.createTextNode(full.slice(mEnd, to) + (to < full.length ? '…' : '')));
      item.appendChild(line);

      item.addEventListener('click', () => {
        if (hit.entry.kind === 'node') {
          openNode(hit.entry.ref);
        } else if (P.file && P.file.showFile) {
          P.file.showFile(hit.entry.ref);
          donePick();
        }
      });
      return item;
    }

    // `lead` / `extra`: the providers' Content rows, shown before (first providers) / after the source hits.
    // STOR-6b: the source lines are the architecture tree's; another tree (storage) shows the providers' rows only.
    function runContentSearch(query, lead, extra) {
      if (!contentIndex && archTree()) contentIndex = buildContentIndex();
      const q = query.toLowerCase();
      const hits = [];
      let total = 0;
      (archTree() ? contentIndex : []).forEach(entry => {
        entry.lower.forEach((l, i) => {
          const col = l.indexOf(q);
          if (col < 0) return;
          total++;
          if (hits.length < CONTENT_MAX_ROWS) hits.push({ entry, lineNo: entry.firstLine + i, text: entry.lines[i], col, len: q.length });
        });
      });
      clearResults();
      if (!hits.length && !lead.length && !extra.length) { noResults(); return; }
      appendProviderRows(lead);
      hits.forEach(h => searchResults.appendChild(contentRow(h)));
      if (total > hits.length) {
        const more = document.createElement('div');
        more.className = 'pn-search-more';
        more.style.padding = '8px 12px';
        more.style.color = 'var(--muted)';
        more.style.fontSize = '12px';
        more.textContent = '+' + (total - hits.length) + ' more';
        searchResults.appendChild(more);
      }
      appendProviderRows(extra);
    }

    // P20-T5-E (b259): Content has nothing to read in the IO view (screens hold no source): there it behaves as Names.
    // STOR-6b: a tree with storage nodes has content (field types, notes, descriptions: the storage provider's Content rows).
    const contentSearch = () => searchMode === 'content' && (archTree() || storageNodes().length > 0);

    function syncModeUi() {
      Object.keys(modeButtons).forEach(m => {
        modeButtons[m].classList.toggle('active', m === searchMode);
        modeButtons[m].setAttribute('aria-pressed', m === searchMode ? 'true' : 'false');
      });
      const contentHint = archTree() ? 'Content: what it says (functions, plan text and b-items the page holds; use `c4mp search` for the whole repo)' : 'Content: what it says (field types, notes and descriptions of the storage tree)';
      if (hintBox) hintBox.textContent = contentSearch() ? contentHint : 'Names: what it is called';
      searchInput.placeholder = contentSearch() ? 'Search content...' : 'Search nodes...';
    }

    function applySearchMode(m) {
      if (m === searchMode) return;
      searchMode = m;
      syncModeUi();
      // Re-run the typed text in the new mode (the providers' rows follow the mode).
      if (typeof searchInput.dispatchEvent === 'function' && typeof Event === 'function') searchInput.dispatchEvent(new Event('input'));
      else onSearchInput({ target: searchInput });
    }

    if (modeBox) {
      [['names', 'Names'], ['content', 'Content']].forEach(pair => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pn-search-mode-btn';
        b.textContent = pair[1];
        b.addEventListener('click', () => window.C4PM_SETTINGS.set('search', pair[0]));
        modeBox.appendChild(b);
        modeButtons[pair[0]] = b;
      });
    } else {
      searchMode = 'names';   // no switch in this page: Content cannot be reached
    }
    syncModeUi();
    window.C4PM_SEARCH = { mode: () => searchMode, registerSearchProvider };
    window.C4PM_SETTINGS.onChange((key, value) => { if (key === 'search') applySearchMode(value); });

    function onSearchInput(e) {
      if (contentTimer !== null) { clearTimeout(contentTimer); contentTimer = null; }
      const query = e.target.value.toLowerCase().trim();

      if (!query) {
        clearResults();
        return;
      }

      if (contentSearch()) {
        if (query.length < CONTENT_MIN) { clearResults(); return; }
        contentTimer = setTimeout(() => { contentTimer = null; runContentSearch(query, providerRows('content', query, true), providerRows('content', query, false)); }, CONTENT_DEBOUNCE);
        return;
      }

      const results = [];
      allNodes.forEach(node => {
        if (results.length >= 20) return;
        const name = node.name.toLowerCase();
        const id = node.id.toLowerCase();
        if (name.includes(query) || id.includes(query) || (node.uid && node.uid.toLowerCase().includes(query)) || (node.meta && node.meta.tags && node.meta.tags.toLowerCase().includes(query))) {
          results.push(node);
        }
      });

      const lead = providerRows('names', query, true), extra = providerRows('names', query, false);
      clearResults();
      if (results.length === 0 && lead.length === 0 && extra.length === 0) { noResults(); return; }
      appendProviderRows(lead);

      results.forEach(node => {
        // P20-T5-E (b259): groups and screens carry no detail line; a screen shows its status (any tree but the architecture one)
        const item = resultRow(node, archTree() ? node.detail : ((node.meta && node.meta.status) || entryKind(node)));
        item.addEventListener('click', () => {
          if (map && map.flyTo && map.select) {
            map.flyTo(node.id);
            map.select(node.id);
            donePick();
          }
        });

        searchResults.appendChild(item);
      });
      appendProviderRows(extra);
    }
    searchInput.addEventListener('input', onSearchInput);

    // P20-T5-E (b259): new tree -> new index; the Content index (arch source text) is dropped; the typed text runs again
    if (window.C4PM_MODE) window.C4PM_MODE.onChange(() => {
      buildNodeIndex();
      contentIndex = null;
      syncModeUi();
      if (typeof searchInput.dispatchEvent === 'function' && typeof Event === 'function') searchInput.dispatchEvent(new Event('input'));
      else onSearchInput({ target: searchInput });
    });

    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        // the first row in the list (an s-item row of a first provider, else a map row); else the first provider row with pick
        const firstResult = searchResults.querySelector('.pn-search-result');
        if (firstResult) {
          firstResult.click();
        } else if (pickRows.length) {
          pickRows[0].el.click();
        }
      } else if (e.key === 'Escape') {
        if (contentTimer !== null) { clearTimeout(contentTimer); contentTimer = null; }
        searchInput.value = '';
        clearResults();
        searchInput.blur();
      }
    });
  }

  P.search = { setup: setupSearch };
})();
