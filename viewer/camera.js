// camera.js: camera and geometry. Moved unchanged from map.js (P14-G2).
(function() {
  const st = () => window.C4PM_STATE;        // created by state.js: { map, data, nodeById, origRects, overlays, requestDraw, draw }; read at CALL time only
  const MAX_S = 14;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Camera fitting
  // `ch` = the height to fit into (default the map's; fitCamIn passes a band of it)
  function fitCam(r, pad = 0.9, ch = st().map.ch) {
    const { map } = st();
    const s = Math.min(map.cw * pad / r.w, ch * pad / r.h);
    return { s, tx: map.cw / 2 - (r.x + r.w / 2) * s, ty: ch / 2 - (r.y + r.h / 2) * s };
  }
  // Phase 25 (UI4, b754): fitCam into the band between `top` and `bottom` px of the map (the path strip above, a caption
  // card below); the band is at least 120 px high.
  function fitCamIn(r, pad = 0.9, top = 0, bottom = 0) {
    const { map } = st();
    const c = fitCam(r, pad, Math.max(120, map.ch - top - bottom));
    return { s: c.s, tx: c.tx, ty: c.ty + top };
  }
  function minS() {
    const { data } = st();
    const r = data.root;
    if (!r.w || !r.h) return 0.1;
    // Low enough to reach the C1 view (fitCam(root, 0.3), see viewC1): 0.3/0.9 of the fit scale.
    return fitCam(r).s * 0.12;
  }

  // Openness: 0 = small bubble, 1 = full blueprint region. Driven by how much of the screen the
  // node's REGION (n.x/y/w/h) would cover at the current zoom: closed below 45%, fully open at
  // 65% (smoothstep between). Ported from the v0.4 demo's openness(). Phase 25: an early id
  // (map.openEarly) opens from 20% to 30% (b786, K 2026-11-17), measured against map.openBand (the visible band the sim
  // camera fitted into) when set, else the whole map. b786: a following code box (follows) takes
  // its parent's openness.
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  // C1 A1 (b828): a holder node (the C1 context, C4PM_MODE.isHolder) is always open, never the focus and never hit.
  const isHolder = n => !!(n && window.C4PM_MODE && window.C4PM_MODE.isHolder(n.kind));
  const CODE_BOX_TAGS = ['file', 'class'];   // b786: code levels between a component and a function (kind table tags)
  const isCodeBox = n => !!(window.C4PM_MODE && window.C4PM_MODE.tag && CODE_BOX_TAGS.indexOf(window.C4PM_MODE.tag(n.kind, 'arch')) >= 0);
  // b786 (K 2026-11-17): a lit code box (file, class) whose parent is lit too follows its parent: it opens as far as the
  // parent and is drawn without its own frame (render.js drawRegion), so a lit function shows inside its component like
  // the demo (one level skipped visually).
  function follows(n) {
    const { map } = st();
    return !!(map.autoLevel && map.openEarly && n.parent && map.openEarly.has(n.id) && map.openEarly.has(n.parent.id) && isCodeBox(n));
  }
  // With Auto level OFF, zoom no longer decides: every node with children down to lockDepth is
  // open, deeper ones closed, until a double-click (dive) or Up moves the lock. n.depth is set in
  // buildParents (system 0, container 1, component 2, ...; a holder above the system -1).
  function openness(n) {
    const { map } = st();
    if (!n.children || !n.children.length) return 0;
    if (isHolder(n)) return 1;   // C1 A1 (b828): a holder (the C1 context) is never a bubble; its children are the top level
    if (!map.autoLevel) return n.depth <= map.lockDepth ? 1 : 0;
    if (follows(n)) return openness(n.parent);   // b786: a following code box opens as far as its parent
    // C1 C1 (b833): the system under a holder (its first child of a kind that needs code; persons and externals need none) measures
    // the holder's rect, the whole C1 picture: open at the C1 Fit on any window shape, closed again when zoomed out past it (Up).
    const m = isHolder(n.parent) && n.parent.children.find(c => window.C4PM_MODE.needsCode(c.kind)) === n ? n.parent : n;
    const early = !!(map.openEarly && map.openEarly.has(n.id));
    const band = early && map.openBand ? Math.max(120, map.ch - map.openBand.top - map.openBand.bottom) : map.ch;   // b786: early ids measure against the visible band
    const f = Math.max(m.w * map.cam.s / map.cw, m.h * map.cam.s / band);
    const at = early ? 0.2 : 0.45;   // Phase 25 (UI8): ids in map.openEarly open at 20%
    const ramp = early ? 0.1 : 0.2;   // b786 (K 2026-11-17): lit boxes fully open at 30%
    return smooth(clamp((f - at) / ramp, 0, 1));
  }

  // Screen rect of a node: lerp bubble -> region by t, then apply the camera. A node without a
  // bubble (older data) uses its region for both ends.
  function toScreen(b, r, t) {
    const { map } = st();
    const { s, tx, ty } = map.cam;
    return { x: lerp(b.x, r.x, t) * s + tx, y: lerp(b.y, r.y, t) * s + ty, w: lerp(b.w, r.w, t) * s, h: lerp(b.h, r.h, t) * s };
  }

  // b858 (simulation only): the fill transform. T = { k, dx, dy } maps a world rect to the place it is drawn at
  // (x' = x*k + dx, y' = y*k + dy); null = no transform. A following code box (follows) that is its parent's only child
  // has its children drawn scaled up to fill the parent's body, so a lit function reads at about the size the demo shows.
  // The layout, the camera, the HUD and every unlit box stay as they are. GAP = src/view/arrange.ts GAP (the free margin of
  // a region in its slot), in the parent's local units, so it is scaled by the parent's world scale.
  const GAP = 15;
  const xf = (T, r) => (T ? { x: r.x * T.k + T.dx, y: r.y * T.k + T.dy, w: r.w * T.k, h: r.h * T.k } : r);
  // The fill of the following box F, drawn under T at openness t: { T: the transform for F's children, D: the rect (world,
  // transformed) they fill }, or null: edit mode (edit.js drags and grips work on the plain rects), no parent, no children,
  // a parent with other children, or no room to grow. The scale and the centre blend in with t, so nothing jumps.
  function followFill(F, T, t) {
    const { map } = st();
    const P = F.parent;
    if (map.edit || !P || !F.children || !F.children.length || P.children.length !== 1) return null;
    let base;
    if (follows(P) && P._D) base = P._D;   // a following parent: the rect it filled
    else {
      const m = GAP * (P.scale || 1), hd = follows(P) ? 0 : (P.headerH || 0);   // its body: below the header, inset by GAP
      base = xf(T, { x: P.x + m, y: P.y + hd + m, w: P.w - 2 * m, h: P.h - hd - 2 * m });
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;   // the union of the children's regions
    F.children.forEach(c => { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
    const S = xf(T, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    let g = Math.min(base.w / S.w, base.h / S.h);
    if (!(g > 1)) return null;
    g = 1 + (g - 1) * t;
    const sx = S.x + S.w / 2, sy = S.y + S.h / 2;
    const cx = lerp(sx, base.x + base.w / 2, t), cy = lerp(sy, base.y + base.h / 2, t);
    const k0 = T ? T.k : 1, dx0 = T ? T.dx : 0, dy0 = T ? T.dy : 0;
    return {
      T: { k: k0 * g, dx: (dx0 - sx) * g + cx, dy: (dy0 - sy) * g + cy },
      D: { x: cx - S.w * g / 2, y: cy - S.h * g / 2, w: S.w * g, h: S.h * g },
    };
  }

  // b858 S2 (simulation only): the card of a leaf whose parent follows (follows): the leaf is drawn as a box the size of its
  // slot minus GAP on each side (its layout box n.w x n.h inset by GAP, in the parent's local units, so scaled by the
  // parent's world scale) instead of its small bubble, so its name reads like the demo. The size blends in with the
  // parent's eased openness (_tv) and the card stays centred on the bubble, inside the leaf's layout box. A world rect
  // (render.js stepNode applies the fill transform after it), or null: edit mode (edit.js works on the plain rects), a box
  // with children, no parent, a parent that does not follow, or no room to grow.
  function leafCard(n) {
    const { map } = st();
    if (map.edit || (n.children && n.children.length) || !n.parent || !follows(n.parent)) return null;
    const m = GAP * (n.parent.scale || 1), b = n.bubble || n, e = n.parent._tv || 0;
    const w = lerp(b.w, n.w - 2 * m, e), h = lerp(b.h, n.h - 2 * m, e);
    if (w <= b.w) return null;
    return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
  }

  const offScreen = R => { const { map } = st(); return R.x > map.cw || R.y > map.ch || R.x + R.w < 0 || R.y + R.h < 0; };

  // Screen rect to anchor an edge on: the rect drawRegion last computed for this node (_R, bubble ->
  // region by openness), so lines touch the visible shape. Falls back to the region for a node
  // that has not been drawn yet.
  function scr(n) {
    const { map } = st();
    if (n._R) return n._R;
    const { s, tx, ty } = map.cam;
    return { x: n.x * s + tx, y: n.y * s + ty, w: n.w * s, h: n.h * s };
  }

  // A view with its own renderer (VIEW-0, b337: C4PM_MODE.renderer(), e.g. the IO view of ioView.js): own hit test, focus and
  // zoom limit; the architecture rules below do not apply to it.
  const renderer = () => window.C4PM_MODE.renderer();

  // Find focused node (deepest opened box under screen center)
  function focusNode() {
    const r = renderer();
    if (r) { const f = r.focus(); return f ? st().nodeById[f.entryId || f.id] || null : null; }
    const { map, data } = st();
    const { s, tx, ty } = map.cam;
    const wx = (map.cw / 2 - tx) / s;
    const wy = (map.ch / 2 - ty) / s;
    let f = null;
    let list = [data.root];
    for (;;) {
      const hit = list.find(
        n => n.children && wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h && openness(n) >= 0.5
      );
      if (!hit) break;
      if (!isHolder(hit)) f = hit;   // C1 A1 (b828): a holder is passed through, never the focus (HUD: the root's word, Up: the top)
      list = hit.children;
    }
    return f;
  }

  // Hit testing
  // Tests the rect each node was last DRAWN at (_R), and only descends into a node's children
  // while it is open (eased n._tv >= 0.5), so a click in the gap between two bubbles selects the
  // parent blueprint. Falls back to the region for a node with no _R.
  function hitTest(px, py) {
    const r = renderer();
    if (r) { const h = r.hit(px, py), by = st().nodeById; return h ? by[h.id] || by[h.entryId] || null : null; }   // the hit itself when it is a node (a part, an entry, a frame, the root), else the entry that holds it
    const { map, data } = st();
    let found = null;
    let list = [data.root];
    for (;;) {
      const h = list.find(n => {
        if ((map.alpha[n.id] || 0) < 0.5) return false;
        const R = scr(n);
        return px >= R.x && px <= R.x + R.w && py >= R.y && py <= R.y + R.h;
      });
      if (!h) break;
      found = h;
      if (h.children && h.children.length && (h._tv || 0) >= 0.5) list = h.children;
      else break;
    }
    if (found && isHolder(found)) return null;   // C1 A1 (b828): a holder is no hit target (a click in its empty space selects nothing)
    return (found && (found._tv || 0) >= 0.5 && frameLabelAt(found, px, py)) || found;
  }

  // Phase 28 LK-G: the subregion of an open container whose frame label band (drawn by render.js drawFrames) holds the
  // point, or null. Only where no component was hit: a subregion is notation, the rest of its frame is the container's.
  function frameLabelAt(n, px, py) {
    const { map } = st();
    return (n.subregions || []).find(l => {
      const R = l._R;
      if (!R || (map.alpha[l.id] || 0) < 0.5) return false;
      return px >= R.x && px <= R.x + R.w && py >= R.y && py <= R.y + (l.headerH || 0) * map.cam.s;
    }) || null;
  }

  // Relative zoom limit (P14-I6): world coordinates shrink by a node's `scale` per level, so the
  // same on-screen zoom of a deep bean needs a larger `s`. The limit follows the node in focus.
  // A node without `scale` counts as 1, so a tree without scale keeps MAX_S.
  const kOf = n => (n && typeof n.scale === 'number' && n.scale > 0 ? n.scale : 1);
  function maxS() {
    if (renderer()) return Math.max(fitCam(st().data.root).s * 60, 6);   // a renderer view (IO): 60 times the Fit zoom, no per-level scale
    const f = focusNode(); return MAX_S / kOf(f);
  }

  // Zoom at point
  function zoomAt(px, py, k, animate) {
    const { map } = st();
    const c = map.cam;
    const ns = clamp(c.s * k, minS(), maxS());
    k = ns / c.s;
    const target = { s: ns, tx: px - (px - c.tx) * k, ty: py - (py - c.ty) * k };
    if (animate) flyTo(target);
    else {
      cancelAnimationFrame(map.anim);
      map.cam = target;
      st().requestDraw();
    }
  }

  // Fly to (animate camera)
  function flyTo(target) {
    const { map } = st();
    cancelAnimationFrame(map.anim);
    const from = { ...map.cam };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      map.cam = target;
      st().requestDraw();
      return;
    }
    const cx0 = (map.cw / 2 - from.tx) / from.s;
    const cy0 = (map.ch / 2 - from.ty) / from.s;
    const cx1 = (map.cw / 2 - target.tx) / target.s;
    const cy1 = (map.ch / 2 - target.ty) / target.s;
    const t0 = performance.now();
    const D = 650;
    const step = now => {
      const p = clamp((now - t0) / D, 0, 1);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const s = from.s * Math.pow(target.s / from.s, e);
      const cx = cx0 + (cx1 - cx0) * e;
      const cy = cy0 + (cy1 - cy0) * e;
      map.cam = { s, tx: map.cw / 2 - cx * s, ty: map.ch / 2 - cy * s };
      st().draw();
      if (p < 1) map.anim = requestAnimationFrame(step);
    };
    map.anim = requestAnimationFrame(step);
  }

  // b858 S3: the drawn world rect of a node inside a fill (render.js stepNode sets n._W), else the node itself.
  function worldOf(n) { const m = st().map; return (n && m.alpha && m.alpha[n.id] > 0 && n._W) || n; }

  window.C4PM_CAM = { MAX_S, clamp, fitCam, worldOf, fitCamIn, minS, maxS, lerp, smooth, openness, follows, xf, followFill, leafCard, toScreen, offScreen, scr, hitTest, zoomAt, flyTo, focusNode };
})();
