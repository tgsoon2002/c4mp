// viewModel.js: the panel's view of the data: tree lookups (parents, breadcrumb, owner, kids, deps), IO and storage kind tests, claim match, file lookups.
// LAY-12c (b389): split out of panel.js; creates window.C4PM_PANEL_PARTS (only when C4PM_DATA has a root) and registers P.vm on it.
(function(){
  'use strict';

  const PANEL_TAG = '[c4pm panel]';   // declared first: buildParentMap runs at load and logs with it

  // ===== helpers =====
  function esc(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s).replace(/[&<>"']/g, c => map[c]);
  }

  // T12c: "1 line" / "2 lines" (regular nouns only)
  function plural(n, word) {
    return Number(n) === 1 ? word : word + 's';
  }

  // ===== Build parent map =====
  // Two guards: `visited` (node objects already walked) stops any recursion cycle; an id already in `parents`
  // (first occurrence wins) is a duplicate id -- its parent link is skipped and logged, but its own children are
  // still walked (a system and its container may legitimately share an id before qualification).
  // Phase 28 LK-G: a container's subregions (node.subregions: notation, not children) get the container as their parent.
  function buildParentMap(node, parents = {}, visited = new Set()) {
    visited.add(node);
    // root gets null; a child keeps the parent its caller just set (writing null here wiped every parent link)
    if (!(node.id in parents)) parents[node.id] = null;
    (node.subregions || []).forEach(l => { if (!(l.id in parents)) parents[l.id] = node; });
    if (node.children) {
      node.children.forEach(child => {
        if (visited.has(child)) {
          console.debug(PANEL_TAG, 'buildParentMap: skip node already visited', { id: child.id, parent: node.id });
          return;
        }
        if (child.id in parents) {
          console.debug(PANEL_TAG, 'buildParentMap: skip parent link (repeated id)', { id: child.id, parent: node.id });
        } else {
          parents[child.id] = node;
        }
        buildParentMap(child, parents, visited);
      });
    }
    return parents;
  }

  // ===== Get breadcrumb chain (array of ids, root first) =====
  function getBreadcrumb(nodeId, parents) {
    const chain = [];
    let current = nodeId;
    let node = null;   // the node of `current` once it is a parent (parents[] holds node objects); null for nodeId itself
    while (current !== null && current !== undefined) {
      if (chain.indexOf(current) >= 0) {
        console.debug(PANEL_TAG, 'getBreadcrumb: cycle cut', { id: current, chain });
        break;
      }
      // C1 A1 (b828): an ancestor that is a holder (the C1 context) has no crumb, as it has no tree row (nodeId itself is kept)
      if (!(node && window.C4PM_MODE && window.C4PM_MODE.isHolder(node.kind))) chain.unshift(current);
      node = parents[current] || null;
      current = node ? node.id : null;
    }
    return chain;
  }

  // ===== Climb to the nearest owning component/shared/unassigned ancestor (inclusive) =====
  function getOwnerNode(node, parents) {
    let current = node;
    const seen = new Set();
    while (current) {
      if (current.kind === 'component' || current.kind === 'shared' || current.kind === 'unassigned') {
        return current;
      }
      if (seen.has(current)) {
        console.debug(PANEL_TAG, 'getOwnerNode: cycle cut', { id: current.id });
        return null;
      }
      seen.add(current);
      current = parents[current.id];
    }
    return null;
  }
  function getOwnerLabel(node, parents) {
    const owner = getOwnerNode(node, parents);
    return owner ? owner.name : 'Unassigned';
  }

  // ===== Find every function/method node in a given file, anywhere in the tree =====
  function findElementsInFile(root, file) {
    const out = [];
    function walk(node) {
      if ((node.kind === 'function' || node.kind === 'method') && node.file === file) {
        out.push(node);
      }
      if (node.children) node.children.forEach(walk);
    }
    walk(root);
    return out;
  }

  // ===== Initialize =====
  const data = window.C4PM_DATA;

  if (!data || !data.root) {
    console.warn('C4PM_DATA not available');
    return;
  }

  // P20-T5-E (b259): the tree this panel works on follows the view (C4PM_MODE, mode.js). 'io' = the screens tree.
  // Older panel-only test pages load panel.js without mode.js: no C4PM_MODE there means the architecture view.
  const modeNow = () => (window.C4PM_MODE ? window.C4PM_MODE.get() : 'arch');
  // STOR-6b (b340): the tree is the one map.js loadTree swapped in (C4PM_STATE.data.root, as tree.js since VIEW-0); a panel-only page
  // (no map.js) has only the architecture tree. archTree(): the loaded tree is the architecture one. ownRenderer(): the view draws
  // itself (C4PM_MODE.renderer(), VIEW-0: the IO and storage views), so the architecture sections do not apply.
  const root = () => (window.C4PM_STATE ? window.C4PM_STATE.data.root : data.root);
  const archTree = () => root() === data.root;
  const ownRenderer = () => !!(window.C4PM_MODE && window.C4PM_MODE.renderer());
  let parents = buildParentMap(root());
  let parentsRoot = root();
  // The parent map belongs to one tree: rebuild it when the tree changed (called on mode change and before any selection).
  function syncParents() {
    if (parentsRoot === root()) return;
    parentsRoot = root();
    parents = buildParentMap(parentsRoot);
  }

  // P13-T6b (Decision 6): "Depends on" / "Used by" from data.edges ({from,to,weight}, ViewEdge in src/types.ts;
  // from = importer, to = imported; finalizeEdges in src/view/model.ts guarantees both ids exist as nodes).
  //  - component: one chip per OTHER node, label = its name, xN = sum of edge weights.
  //  - container/system: members' edges to outside the subtree, endpoints rolled up to their container.
  //  - subregion (Phase 28 LK-G): its components' edges; a subregion has no children, its components are kidsOf.
  // A subregion's components: the children of its container (parents map) whose `subregion` is its id. Any other node: its children.
  function kidsOf(n) {
    if (n.kind !== 'subregion') return n.children || [];
    const c = parents[n.id];
    return c ? (c.children || []).filter(k => k.subregion === n.id) : [];
  }
  function subtreeIds(node) {
    const ids = new Set();
    (function walk(n) {
      if (ids.has(n.id)) return;   // duplicate-id guard
      ids.add(n.id);
      kidsOf(n).forEach(walk);
    })(node);
    return ids;
  }

  // nearest ancestor-or-self of `kind` (bounded walk); falls back to the node itself. A component in a subregion passes
  // its subregion on the way up (LK-G: the subregion is not its parent, but it is between it and its container).
  function nearestOfKind(id, kind) {
    const seen = new Set();
    let cur = findNodeById(root(), id);
    const start = cur;
    while (cur && !seen.has(cur)) {
      if (cur.kind === kind) return cur;
      seen.add(cur);
      cur = cur.subregion ? findNodeById(root(), cur.subregion) : parents[cur.id];
    }
    return start;
  }

  // dir 'out' = Depends on (this is importer), 'in' = Used by. Returns [{node, weight}] in first-seen order.
  function collectDeps(node, dir) {
    const edges = Array.isArray(data.edges) ? data.edges : [];
    const rollUp = node.kind !== 'component';
    // Phase 28 S10: a subregion rolls the other end up to the nearest subregion; a container (and the system) to the nearest container
    const unit = node.kind === 'subregion' ? 'subregion' : 'container';
    const members = subtreeIds(node);
    const sums = new Map();
    edges.forEach(e => {
      const mine = dir === 'out' ? e.from : e.to;
      const other = dir === 'out' ? e.to : e.from;
      if (!members.has(mine) || members.has(other)) return;   // not ours, or self/internal
      const target = rollUp ? nearestOfKind(other, unit) : findNodeById(root(), other);
      if (!target || members.has(target.id)) return;
      const w = Number(e.weight) || 0;
      sums.set(target.id, { node: target, weight: (sums.has(target.id) ? sums.get(target.id).weight : 0) + w });
    });
    return [...sums.values()];
  }

  // p27 (b266): every entry of the IO view (screen, command, route, tool) is a node of kind 'screen'; its real kind is io.kind.
  function entryKind(node) { return (node.io && node.io.kind) || node.kind; }

  // IO view parts: a part (region, control, flag, state, ...) is a ViewNode below its entry (navLayout.ts partNode); an entry is a 'screen' node
  // (with `io`), an app a 'container', the root a 'system'. States are listed apart ('States'), the other children are 'Inside'.
  const isPartNode = n => !!n && n.kind !== 'screen' && n.kind !== 'container' && n.kind !== 'system';
  const stateKids = n => (n.children || []).filter(c => c.kind === 'state');
  const insideKids = n => (n.children || []).filter(c => c.kind !== 'state');
  // the word of a part when its parent changes it (a param under a body is a 'field'); '' for anything else
  // (STOR-6b: a store, record or field is a part by this test too; its word is the technology's: database, table, column)
  const partWord = n => (ownRenderer() && isPartNode(n) && n.word ? String(n.word).toLowerCase() : '');
  // every entry (a 'screen' node) at or below `n`, depth first (a subcommand is a child of its command)
  function ioEntries(n, out) {
    out = out || [];
    if (n.kind === 'screen') out.push(n);
    (n.children || []).forEach(c => ioEntries(c, out));
    return out;
  }
  function owningEntry(n) { let x = n; while (x && !x.io) x = x.parent; return x || null; }

  // the NavEntry of an entry fqn in C4PM_DATA.nav.groups[].entries[]; null when the nav holds none
  function navEntryOf(fqn) {
    for (const g of (data.nav && data.nav.groups) || []) for (const e of g.entries || []) if (e.fqn === fqn) return e;
    return null;
  }

  const STORAGE_KINDS = ['store', 'record', 'field'];
  const isStorageNode = n => !!n && STORAGE_KINDS.indexOf(n.kind) >= 0;

  const treeEdges = () => (window.C4PM_STATE ? window.C4PM_STATE.data.edges : data.edges) || [];

  // Fields (src/types.ts ViewNode): claims[] = {kind 'folder'|'file'|'function', path, fn, ownedCount?}, source (.c4 path).
  // Match rule = src/view/model.ts claimMatches + CLAIM_RANK (function 3 > file 2 > folder 1; first claim wins a tie).
  // ViewNode.name of a method has the class prefix stripped, so a function claim's fn also matches by its last '.' segment.
  const CLAIM_RANK = { folder: 1, file: 2, function: 3 };
  function claimMatchesFn(claim, file, name) {
    if (claim.kind === 'folder') return typeof claim.path === 'string' && file.startsWith(claim.path);
    if (claim.kind === 'file') return file === claim.path;
    if (claim.kind === 'function') {
      const fn = claim.fn || '';
      return file === claim.path && (fn === name || fn.split('.').pop() === name);
    }
    return false;
  }
  function findMatchingClaim(owner, fnNode) {
    const claims = Array.isArray(owner.claims) ? owner.claims : [];
    let best = null;
    claims.forEach(c => {
      if (!claimMatchesFn(c, fnNode.file || '', fnNode.name)) return;
      if (!best || (CLAIM_RANK[c.kind] || 0) > (CLAIM_RANK[best.kind] || 0)) best = c;
    });
    return best;
  }

  function findViewFile(path) {
    const files = data.files || [];
    for (let i = 0; i < files.length; i++) if (files[i].path === path) return files[i];
    return null;
  }

  // Nodes (function/method/class/file/slice) whose `file` is the path; the same ViewNode object can be reachable
  // twice (file node and claim-mode slice reuse), so collect by identity.
  function collectFileNodes(root, path) {
    const seen = new Set();
    const out = [];
    (function walk(n) {
      if (n.file === path && !seen.has(n)) { seen.add(n); out.push(n); }
      if (n.children) n.children.forEach(walk);
    })(root);
    return out;
  }

  function collectFileFindings(nodes) {
    const seen = new Set();
    const out = [];
    nodes.forEach(n => (n.findings || []).forEach(f => {
      if (seen.has(f)) return;
      seen.add(f);
      out.push(f);
    }));
    return out;
  }

  // ===== Helper: find node by id =====
  function findNodeById(node, id) {
    if (node.id === id) return node;
    const sub = (node.subregions || []).find(l => l.id === id);   // Phase 28 LK-G: a container's subregions
    if (sub) return sub;
    if (node.children) {
      for (let child of node.children) {
        const found = findNodeById(child, id);
        if (found) return found;
      }
    }
    return null;
  }

  // LAY-12c (b389): the one namespace of the panel parts; each later part adds its key, panel.js reads them all.
  window.C4PM_PANEL_PARTS = { vm: { esc, plural, getBreadcrumb, getOwnerNode, getOwnerLabel, findElementsInFile, modeNow, root,
    archTree, ownRenderer, parents: () => parents, syncParents, kidsOf, collectDeps, entryKind, isPartNode, stateKids,
    insideKids, partWord, ioEntries, owningEntry, navEntryOf, isStorageNode, treeEdges, claimMatchesFn, findMatchingClaim,
    findViewFile, collectFileNodes, collectFileFindings, findNodeById } };
})();
