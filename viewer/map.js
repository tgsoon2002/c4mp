(function() {
  const data = window.C4PM_DATA;
  if (!data || !data.root) {
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('map-wrap');
      if (el) el.innerHTML = '<div style="padding:20px;color:var(--muted)">No data to display. Run the snapshot command first.</div>';
    });
    return;
  }

  const CAM = window.C4PM_CAM;   // camera.js: members are read at CALL time (CAM.fitCam(...) etc.)
  const RD = window.C4PM_RENDER; // render.js: members are read at CALL time (RD.theme.C() etc.)
  const CT = window.C4PM_CONTROLS; // controls.js: members are read at CALL time (CT.updateHud() etc.)

  // State: created by state.js (loaded before this file); map, nodeById and origRects are the same objects it holds.
  const state = window.C4PM_STATE;
  const { map, nodeById, origRects } = state;

  // Build lookup table (nodeById lives in state.js)
  // Phase 28 LK-G: a container's subregions (n.subregions) are found by id too (select, flyTo, the tree's group rows), not as children.
  function indexNodes(n) {
    nodeById[n.id] = n;
    if (n.subregions) n.subregions.forEach(l => { nodeById[l.id] = l; });
    if (n.children) n.children.forEach(indexNodes);
  }

  // Original rects taken when a tree is first loaded, so Reset layout can restore them (edits are in memory only).
  // One set per tree root (P20-T5-B, b256): switching mode and back must not take the edited rects as the originals.
  const origRectsByRoot = new Map();
  function rectsOf(root) {
    let r = origRectsByRoot.get(root);
    if (!r) {
      r = {};
      Object.keys(nodeById).forEach(id => { r[id] = window.C4PM_EDIT.rectOf(nodeById[id]); });   // SR2 (R5): one rect record (placed too)
      origRectsByRoot.set(root, r);
    }
    return r;
  }
  // state.data is the tree of the current mode (P20-T5-B, b256); read it at call time

  // Request redraw
  function req() {
    if (map.ctx && !map.raf) map.raf = requestAnimationFrame(draw);
  }
  window.C4PM_STATE.requestDraw = req;

  // Main draw function. `now` is the rAF timestamp (ms); drawEdges uses it to pulse the glow on
  // edges touching the selected node, so draw keeps re-scheduling itself via map.pulse while a
  // selection is active (ported from the mock's draw/req split).
  function draw(now) {
    map.raf = 0;
    if (!map.ctx || !map.cam) return;
    // A hidden map (0 x 0, e.g. #map-wrap hidden in the sequence's own window, UI14) draws nothing: its fit scale is 0 and
    // the grid loops below (step *= 2 until >= 18) would never end.
    if (!(map.cw > 0) || !(map.ch > 0) || !(map.cam.s > 0)) return;
    const C = RD.theme.readColors();
    const dpr = window.devicePixelRatio || 1;
    const { cw, ch } = map;
    const { s, tx, ty } = map.cam;

    const ctx = map.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.panel2;
    ctx.fillRect(0, 0, cw, ch);

    // Dot grid
    let step = 40 * s;
    while (step < 18) step *= 2;
    while (step > 36) step /= 2;
    ctx.fillStyle = C.line;
    for (let x = ((tx % step) + step) % step; x < cw; x += step) {
      for (let y = ((ty % step) + step) % step; y < ch; y += step) {
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    map.alpha = {};
    map.animating = false;
    map.opens = [];
    map.headerRects = [];   // b841: the header text rects of the open regions this frame (drawRegion); relation labels keep off them
    const R = window.C4PM_MODE.renderer();   // VIEW-0 (b337): null = the architecture engine below
    if (R) {
      R.draw(map, C, now || 0);   // a view with its own renderer (IO: ioView.js); the IO renderer also sets map.edgeLabels
    } else {
      const bubbles = [];
      RD.regions.drawRegion(state.data.root, 1, bubbles); // pass 1: blueprint regions
      RD.edges.drawEdges(now || 0);             // pass 2: lines, visible in the gaps
      bubbles.forEach(RD.beans.drawBubble);      // pass 3: bubbles on top
      RD.edges.drawLabels(bubbles);              // pass 4 (C1 D2, b836): relation labels last, off every box
      if (map.edit) RD.regions.drawHandles();
    }
    // Phase 25 (UI4, b754): post-draw overlays (state.js C4PM_STATE.post) on top of the view, under the HUD
    (state.post || []).forEach(fn => fn(map, C, now || 0));
    CT.updateHud();

    // Keep the glow pulsing while something is selected or lit (board item, s-item), or while openness is easing -- each frame re-requests the next one.
    if (map.selectedId || map.animating || map.hi || map.sim) {
      cancelAnimationFrame(map.pulse);
      map.pulse = requestAnimationFrame(() => req());
    }
  }

  window.C4PM_STATE.draw = draw;

  // Camera that fits the current tree's root (first load, and after a mode switch; P20-T5-B, b256).
  function fitRoot() {
    const r = state.data.root;
    return r && r.w > 0 && r.h > 0 ? CAM.fitCam(r, 0.85) : { s: 1, tx: 0, ty: 0 };
  }

  // Initialize map
  function initMap() {
    map.canvas = document.getElementById('map');
    map.ctx = map.canvas.getContext('2d');
    const wrap = document.getElementById('map-wrap');

    if (map.ro) map.ro.disconnect();
    map.ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const first = !map.cw;
      const oldCw = map.cw, oldCh = map.ch;
      map.cw = wrap.clientWidth;
      map.ch = wrap.clientHeight;
      map.canvas.width = Math.round(map.cw * dpr);
      map.canvas.height = Math.round(map.ch * dpr);

      if (!map.cam || first) {
        map.cam = fitRoot();
        // C1 A1 follow-up: the HUD pill gets its word and colour with the first camera, not only on the first drawn frame
        // (a big page can paint before its first animation frame runs). A renderer view (IO, storage) fills its own HUD
        // from its drawn state, so it waits for its first draw.
        if (map.cw > 0 && map.ch > 0 && !window.C4PM_MODE.renderer()) CT.updateHud();
      } else if (map.cw !== oldCw || map.ch !== oldCh) {
        // A panel collapsed or expanded: keep the world point that was at the centre at the centre
        // of the new size. No refit, so the user's zoom stays.
        const c = map.cam;
        const cx = (oldCw / 2 - c.tx) / c.s, cy = (oldCh / 2 - c.ty) / c.s;
        map.cam = { s: c.s, tx: map.cw / 2 - cx * c.s, ty: map.ch / 2 - cy * c.s };
        console.debug('[C4PM_MAP] resize: kept centre', oldCw, 'x', oldCh, '->', map.cw, 'x', map.ch);
      }
      req();
    });
    map.ro.observe(wrap);

    // Wire buttons
    CT.wireButtons({ resetLayout: CT.resetLayout, downloadLayout: CT.downloadLayout, undoEdit: CT.undoEdit, redoEdit: CT.redoEdit, autoArrange: CT.autoArrangeSelected });
    document.addEventListener('keydown', CT.onKeydown);

    CT.wirePointers();
  }

  // Build parent references
  // Phase 28 LK-G: a subregion's parent is its container (not a level: no child has a subregion as parent); its frame rect
  // comes from its components (edit.js placeFrames), once they have their parents.
  // C1 A1 (b828): a holder root (the C1 context) gets depth -1, so the system stays depth 0 (Auto level off, Up, dive as before).
  // C1 B2 (b832): n.holder marks that root, so edit.js isTop treats its children (system, actors) as top nodes.
  function buildParents(n, parent = null) {
    const holder = !parent && window.C4PM_MODE.isHolder(n.kind);
    n.parent = parent;
    n.holder = holder; // C1 B2 (b832): read by edit.js isTop (a holder's children are top nodes)
    n.depth = parent ? parent.depth + 1 : holder ? -1 : 0;
    if (n.children) n.children.forEach(c => buildParents(c, n));
    if (n.subregions) {
      n.subregions.forEach(l => { l.parent = n; l.depth = n.depth + 1; });
      window.C4PM_EDIT.placeFrames(n);
    }
  }

  // P20-T5-B (b256): swap the tree the engine reads. tree = { root, edges } (arch: C4PM_DATA's own; io: navView).
  // camera/controls/render read C4PM_STATE.data at call time, so they follow with no edit. Called once below with the
  // arch tree and by mode.js on every real mode change.
  function loadTree(tree) {
    buildParents(tree.root);
    Object.keys(nodeById).forEach(id => { delete nodeById[id]; });
    indexNodes(tree.root);
    Object.keys(origRects).forEach(id => { delete origRects[id]; });
    Object.assign(origRects, rectsOf(tree.root));
    state.data = tree.root === data.root ? data : Object.create(data, { root: { value: tree.root }, edges: { value: tree.edges } });
    map.selectedId = null;
    cancelAnimationFrame(map.pulse);
    map.listeners.forEach(fn => fn(null));
    map.lockDepth = -1;   // autoLevel is kept
    map.opens = [];
    map.history = { undo: [], redo: [] };
    map.hi = null;
    buildImpl();
    map.cam = null;
    if (map.cw) map.cam = fitRoot();   // already sized: refit now; else the first resize does it
    req();
  }

  // b130: arch node lookup by uid / id / planId over data.root (the arch tree stays reachable while the IO view is shown).
  let archIdx = null;
  function archIndex() {
    if (archIdx) return archIdx;
    archIdx = { uid: {}, id: {}, plan: {} };
    (function walk(n) {
      archIdx.id[n.id] = n.id;
      if (n.uid) archIdx.uid[n.uid] = n.id;
      if (n.planId) archIdx.plan[n.planId] = n.id;
      (n.children || []).forEach(walk);
    })(data.root);
    return archIdx;
  }
  // The arch node a NavCall (data.nav.calls) stands for: the target's uid, else its nearest component fqn (a function lights its component).
  function archIdOf(call) {
    const ix = archIndex();
    if (call.toUid && ix.uid[call.toUid]) return ix.uid[call.toUid];
    const fqn = call.toComponent;
    return fqn ? (ix.plan[fqn] || ix.id[fqn] || null) : null;
  }

  // b130: persistent ring (overlays.impl, drawn by render.js drawOverlays) on the components the screens call. Own state, not map.hi,
  // so it never dims anything and the board/link highlight is untouched. Built in arch mode only, when setting lightImpl is on.
  function buildImpl() {
    map.impl = null; map.implN = null;
    if (window.C4PM_SETTINGS.get('lightImpl') !== 'on' || state.data.root !== data.root) return;
    const kinds = window.C4PM_MODE.callKinds;
    const impl = new Set(), n = {};
    ((data.nav && data.nav.calls) || []).forEach(c => {
      const id = kinds.indexOf(c.toKind) >= 0 ? archIdOf(c) : null;
      if (!id || !nodeById[id]) return;
      impl.add(id);
      for (let x = nodeById[id]; x; x = x.parent) n[x.id] = (n[x.id] || 0) + 1;   // a closed container rolls its components up
    });
    if (impl.size) { map.impl = impl; map.implN = n; }
  }
  window.C4PM_SETTINGS.onChange((key) => {
    if (key === 'lightImpl') { buildImpl(); req(); }
    else if (key === 'theme') req();   // LAY-12b: the map reads its colours from CSS at draw time (settings.js no longer calls requestDraw)
  });

  loadTree({ root: data.root, edges: data.edges });

  // Public API
  window.C4PM_MAP = {
    nodeById: id => nodeById[id],
    // Select a node by id (same path as a click; never moves the camera). null clears. Unknown id: no-op, false.
    select: (id) => {
      if (id && !nodeById[id]) {
        console.debug('[C4PM_MAP] select: unknown id, ignored', id);
        return false;
      }
      console.debug('[C4PM_MAP] select', id || null);
      map.selectedId = id || null;
      cancelAnimationFrame(map.pulse);
      map.listeners.forEach(fn => fn(id ? nodeById[id] : null));
      req();
      return true;
    },
    selectedId: () => map.selectedId,
    archIdOf,   // b130
    // Ids from the root down to (excluding) the node; [] for the root or an unknown id.
    ancestorsOf: (id) => {
      const out = [];
      const n = nodeById[id];
      for (let p = n && n.parent; p; p = p.parent) out.unshift(p.id);
      console.debug('[C4PM_MAP] ancestorsOf', id, out);
      return out;
    },
    flyTo: (id) => {
      console.debug('[C4PM_MAP] flyTo', id);
      const n = nodeById[id];
      if (n && n.w > 0 && n.h > 0) {
        // Locked: same rule as a double-click dive, so the target opens (its parent's level if a leaf).
        if (!map.autoLevel && !window.C4PM_MODE.renderer()) {   // a renderer view (IO) has no levels
          const t = n.children && n.children.length ? n : n.parent;
          if (t) map.lockDepth = t.depth;
        }
        // b858 S3: fly to where the box is drawn (inside a fill)
        CAM.flyTo(CAM.fitCam(CAM.worldOf(n)));
      }
    },
    // Any number of subscribers (panel, tree); each gets the node or null.
    onSelect: (fn) => {
      console.debug('[C4PM_MAP] onSelect subscriber added, total', map.listeners.length + 1);
      map.listeners.push(fn);
    },
    // P16-B30b: light up the c-items of a selected board item. Unknown ids are ignored; none left (or
    // null) clears. Returns how many ids were kept. Never moves the camera or the selection.
    setHighlight: (nodeIds) => {
      const known = Array.isArray(nodeIds) ? nodeIds.filter(id => nodeById[id]) : [];
      map.hi = known.length ? new Set(known) : null;
      req();
      return known.length;
    },
    // { lit: c-items lit, arrows: data.edges with BOTH ends lit (un-rolled ends, same test as the drawing) }
    highlightInfo: () => {
      if (!map.hi) return { lit: 0, arrows: 0 };
      const inHi = RD.edges.inHi;
      const arrows = (state.data.edges || []).filter(e => nodeById[e.from] && nodeById[e.to] && inHi(e.from) && inHi(e.to)).length;
      return { lit: map.hi.size, arrows };
    },
    setAutoLevel: CT.setAutoLevel,
    setEdit: CT.setEdit,
    undo: CT.undoEdit,
    redo: CT.redoEdit,
    exportLayout: CT.exportLayout,
    setOverlay: (name, on) => {
      state.overlays[name] = on;
      req();
    },
    overlays: state.overlays,   // the SAME object state.js made (render.js reads st().overlays)
    draw: () => {
      draw();
    },
    state: map,
  };
  window.C4PM_MAP.loadTree = loadTree;
  CT.setSelect(window.C4PM_MAP.select);                // LAY-12b: controls.js selects through this (no read of C4PM_MAP there)
  window.C4PM_MODE.setTreeLoader(loadTree);            // LAY-12b: mode.js loads the tree of a view through this (set() step 3)
  window.C4PM_MODE.start();   // P20-T5-0 (b254): once, right after C4PM_MAP exists (mode.js reads the #io hash)

  // Wait for DOM, then initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initMap();
      CT.fillHeader();
      req();
    });
  } else {
    initMap();
    CT.fillHeader();
    req();
  }
})();
