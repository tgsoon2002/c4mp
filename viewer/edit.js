// Pure layout-edit math for the blueprint map (no DOM, no canvas). Ported from the demo
// (Document/v0.4-blueprint-map-demo.html: shift, recenterBubble, childBounds, minRegion,
// growParents, editTarget, applyDrag) and adapted to the real node shape:
//   region = n.x/n.y/n.w/n.h, bubble = n.bubble {x,y,w,h} (optional), n.headerH (world units),
//   n.children, n.parent and n.holder (set by map.js buildParents), n._R (last drawn screen rect), n._tv (eased openness).
// Camera is always passed in as { s, tx, ty }; map.js internals are never touched.
(function () {
  const GRIP = 8; // px: resize grip width on an open region's right/bottom edge
  // Keep equal to src/view/arrange.ts SLOT and PAD (the viewer cannot import it; the edit test asserts equality).
  const SLOT = { w: 300, h: 150 }; // one child's slot in its parent's local frame
  const PAD = 30; // margin between a region's border and its slots

  const hasKids = n => !!(n.children && n.children.length);
  // A node of a two-phase tree (P14-I3 layoutTree) carries a numeric scale; old trees do not.
  const isNew = n => typeof n.scale === 'number';
  // C1 B2 (b832): a holder is not a level; its children are top nodes like a root: never moved, resized or exported.
  const isTop = n => !n.parent || !!n.parent.holder;
  // b268: new trees pad by the layout's own margin (PAD x scale, same as moveNew's clamp and the server's floor).
  const padOf = n => (isNew(n) ? PAD * n.scale : (typeof n.headerH === 'number' ? n.headerH : 0) * 0.3);
  // SR2: a subregion frame (n.subregions of a container) and its members (the container's children with `subregion` = its id).
  const isFrame = n => n.kind === 'subregion';
  const subregionMembers = (c, id) => (c.children || []).filter(k => k.subregion === id);
  // What sits below n in the edit tree: its children and its frames (a container's frames move with it).
  const below = n => (n.children || []).concat(n.subregions || []);

  // Move n and every descendant (region + bubble, frames too) by the same world delta.
  function shift(n, dx, dy) {
    n.x += dx; n.y += dy;
    if (n.bubble) { n.bubble.x += dx; n.bubble.y += dy; }
    below(n).forEach(c => shift(c, dx, dy));
  }

  // After a region resize/grow: an unplaced bubble (bubbleMoved falsy) stays centred; a user-placed one
  // keeps its position (= its offset from the region's top-left, which a resize does not move), clamped
  // so it stays inside the region.
  function recenterBubble(n) {
    const b = n.bubble;
    if (!b) return;
    if (!n.bubbleMoved) {
      b.x = n.x + (n.w - b.w) / 2;
      b.y = n.y + (n.h - b.h) / 2;
    } else {
      b.x = Math.max(n.x, Math.min(b.x, n.x + n.w - b.w));
      b.y = Math.max(n.y, Math.min(b.y, n.y + n.h - b.h));
    }
  }

  // Bounding box of every child's region AND bubble (a child shows as a bubble when closed, as a region
  // when open; the user may have placed the bubble outside the region), and of every placed frame (SR2; auto frames
  // follow the children). null when there is none.
  function childBounds(n) {
    const kids = below(n).filter(c => !isFrame(c) || c.placed); // SR2: an auto frame follows its boxes; a placed one counts
    if (!kids.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    kids.forEach(c => {
      [c, c.bubble].forEach(r => {
        if (!r) return;
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
      });
    });
    return { x0, y0, x1, y1 };
  }

  // Smallest region n can be resized to: must still hold its bubble and every child (+ padding). A frame (SR2): half a
  // slot wide, its label band + PAD high (free placement: it need not hold its members).
  function minRegion(n) {
    if (isFrame(n)) { const K = n.scale || 1; return { w: SLOT.w * K / 2, h: (n.headerH || 0) + PAD * K }; } // SR2: free placement, need not hold its members
    const m = isNew(n) ? 20 * n.scale : 20; // b268: the bubble margin is world units scaled like the region
    let w = (n.bubble ? n.bubble.w : 0) + m, h = (n.bubble ? n.bubble.h : 0) + m;
    const b = childBounds(n);
    if (b) {
      const pad = padOf(n);
      w = Math.max(w, b.x1 + pad - n.x);
      h = Math.max(h, b.y1 + pad - n.y);
    }
    return { w, h };
  }

  // Largest x and y a region's top-left may take while its right/bottom edge stays at r0's: it must still hold its
  // bubble (a user-placed one keeps its world position) and every child (+ padding; the header sits above the children).
  // A frame (SR2) only needs its minimum size. Mirrors minRegion for the left/top sides.
  function maxOrigin(n, r0) {
    const right = r0.x + r0.w, bottom = r0.y + r0.h;
    if (isFrame(n)) { const m = minRegion(n); return { x: right - m.w, y: bottom - m.h }; }
    const mg = isNew(n) ? 20 * n.scale : 20, b = n.bubble;
    let x = right - (b ? b.w + mg : 0), y = bottom - (b ? b.h + mg : 0);
    if (b && n.bubbleMoved) { x = Math.min(x, b.x); y = Math.min(y, b.y); }
    const k = childBounds(n);
    if (k) {
      const pad = padOf(n), hh = typeof n.headerH === 'number' ? n.headerH : 0;
      x = Math.min(x, k.x0 - pad); y = Math.min(y, k.y0 - hh - pad);
    }
    return { x, y };
  }

  // After a move/resize of n, grow every ancestor (never shrink) so it still contains its children.
  function growParents(n) {
    for (let p = n.parent; p && !p.holder; p = p.parent) { // C1 B2 (b832): a holder never grows
      const b = childBounds(p), pad = padOf(p), hh = typeof p.headerH === 'number' ? p.headerH : 0;
      // b268: a new-tree region grows only right/bottom (top-left fixed: its children's local units are relative to it).
      const x0 = isNew(p) ? p.x : Math.min(p.x, b.x0 - pad), y0 = isNew(p) ? p.y : Math.min(p.y, b.y0 - hh - pad);
      const x1 = Math.max(p.x + p.w, b.x1 + pad), y1 = Math.max(p.y + p.h, b.y1 + pad);
      p.x = x0; p.y = y0; p.w = x1 - x0; p.h = y1 - y0;
      recenterBubble(p);
    }
  }

  // ---- subregion frames (Phase 28 LK-G) ----
  // A container's plan subregions (n.subregions, src/types.ts) are notation, not a level: each is drawn as a frame around its
  // components (the container's children whose `subregion` is its id). The frame is computed from where those components
  // are now, so it follows an edit: across the container's slot area (half a PAD in from its border), from the label
  // band (the subregion's headerH, kept free by the layout's arrangeStack) above the highest component slot down to the
  // lowest slot (half a PAD up). A slot is SLOT x container scale, centred on the component's region (as moveNew).
  // Sets each subregion's x, y, w, h (world); a subregion with no component gets w = h = 0 (nothing drawn).
  // b454: the first shared subregion (l.sharedColumn) with components, in a container that has other children too, is the side
  // column of the layout (arrangeStack): its frame spans its components' slots (half a PAD out on the left and right)
  // and the full height of the other frames (top of the first to bottom of the last; its own slots too); every other
  // frame then ends a PAD left of it, so no two frames overlap. Same condition as the layout, so the two agree.
  // SR2: only auto frames are fitted here. A placed frame (l.placed: saved layout or dragged/resized in the page) keeps its
  // own x, y, w, h and is not counted in the side-column stack.
  function slotRect(n, Kp) {
    const w = SLOT.w * Kp, h = SLOT.h * Kp;
    return { x: n.x + n.w / 2 - w / 2, y: n.y + n.h / 2 - h / 2, w, h };
  }
  function placeFrames(c) {
    const K = c.scale || 1, inset = PAD * K / 2;
    const subregions = (c.subregions || []).filter(l => !l.placed);
    const shared = subregions.find(l => l.sharedColumn);
    const sideSlots = shared ? subregionMembers(c, shared.id).map(k => slotRect(k, K)) : [];
    const side = sideSlots.length > 0 && sideSlots.length < (c.children || []).length ? shared : null;
    const sideX = side ? Math.min(...sideSlots.map(r => r.x)) - inset : 0;
    const right = side ? sideX - 2 * inset : c.x + c.w - inset;
    const frame = (l, slots, x, r) => {
      if (!slots.length) { l.x = c.x; l.y = c.y; l.w = 0; l.h = 0; return; }
      const top = Math.min(...slots.map(s => s.y)) - (l.headerH || 0);
      const bottom = Math.max(...slots.map(s => s.y + s.h)) - inset;
      l.x = x; l.y = top; l.w = Math.max(0, r - x); l.h = Math.max(0, bottom - top);
    };
    subregions.forEach(l => { if (l !== side) frame(l, subregionMembers(c, l.id).map(k => slotRect(k, K)), c.x + inset, right); });
    if (!side) return;
    frame(side, sideSlots, sideX, Math.max(...sideSlots.map(r => r.x + r.w)) + inset);
    const stack = subregions.filter(l => l !== side && l.w > 0 && l.h > 0);
    if (!stack.length) return;
    const top = Math.min(side.y, ...stack.map(l => l.y)), bottom = Math.max(side.y + side.h, ...stack.map(l => l.y + l.h));
    side.y = top; side.h = bottom - top;
  }
  // SR2: the rect (world) a move of n must keep inside its parent's body. A box: its slot (SLOT x parent scale, centred
  // on its region, as slotRect). A frame: its own rect joined with the slot of each member (the members move with it).
  function footprint(n) {
    const p = n.parent, Kp = (p && p.scale) || 1;
    if (!isFrame(n)) return slotRect(n, Kp);
    const rs = [n].concat(p ? subregionMembers(p, n.id).map(m => slotRect(m, Kp)) : []);
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
    const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // What an edit-mode drag starting at screen point p would do. openNodes = open regions in draw
  // order (parents before children; checked deepest-first so nested edges win), hitNode = the node
  // map.js hit-tests at p (or null), cam = {s,tx,ty}. Returns {type:'resize',n,rx,ry},
  // {type:'move',n} (region + descendants), {type:'moveBubble',n} (closed shape: only its bubble) or null (-> pan). The root (no parent) is never editable.
  // SR2: a subregion frame moves by its label band (headerH; hitTest returns a frame only there) and resizes by its edge.
  function editTarget(p, openNodes, hitNode, cam) {
    for (let i = openNodes.length - 1; i >= 0; i--) {
      const n = openNodes[i], R = n._R;
      if (isTop(n) || !R) continue;
      const inX = p.x > R.x - GRIP && p.x < R.x + R.w + GRIP, inY = p.y > R.y - GRIP && p.y < R.y + R.h + GRIP;
      const rx = Math.abs(p.x - (R.x + R.w)) < GRIP && inY;
      const ry = Math.abs(p.y - (R.y + R.h)) < GRIP && inX;
      const lx = Math.abs(p.x - R.x) < GRIP && inY;
      const ty = p.y > R.y - GRIP && p.y < R.y + GRIP / 2 && inX; // only the outer half: below it the header moves the box
      if (rx || ry || lx || ty) return { type: 'resize', n, rx, ry, lx, ty };
    }
    const n = hitNode;
    if (!n || isTop(n)) return null;
    if (!isFrame(n) && (!hasKids(n) || (n._tv || 0) < 0.5)) return { type: n.bubble ? 'moveBubble' : 'move', n }; // closed shape
    const R = n._R; // SR2: a frame is always in region mode; its header is its label band
    if (R && p.y < R.y + (n.headerH || 0) * cam.s) return { type: 'move', n }; // open blueprint's header / frame label
    return null;                                                              // blueprint or frame body -> pan
  }

  // New tree (P14-I8): the node moves as a whole (region, bubble, descendants) in world units, then is
  // clamped so its footprint (a box: its SLOT, SLOT x parent scale centred on the region) stays inside the parent's
  // body. No ancestor grows (the layout sized them). Conversion to parent-local units happens in exportLayout.
  // SR2: a frame carries its members by the same delta (free placement: members may sit outside it), its footprint
  // covers them too, and the move marks it placed.
  function moveNew(op, dX, dY) {
    const n = op.n, p = n.parent, Kp = p.scale;
    if (!op.f0) { // footprint at drag start (r0), kept for the whole drag like op.b0
      const f = footprint(n);
      op.f0 = { x: f.x + op.r0.x - n.x, y: f.y + op.r0.y - n.y, w: f.w, h: f.h };
    }
    const f0 = op.f0, fx = f0.x + dX, fy = f0.y + dY;
    // The body, widened to where the footprint was at drag start, so a drag never jumps (an auto frame spans the
    // container's width half a PAD in from its border, a full PAD is the body's margin).
    const loX = Math.min(p.x + PAD * Kp, f0.x), loY = Math.min(p.y + (p.headerH || 0), f0.y);
    const hiX = Math.max(p.x + p.w - PAD * Kp, f0.x + f0.w), hiY = Math.max(p.y + p.h - PAD * Kp, f0.y + f0.h);
    let ax = 0, ay = 0;
    if (fx < loX) ax = loX - fx; else if (fx + f0.w > hiX) ax = hiX - (fx + f0.w);
    if (fy < loY) ay = loY - fy; else if (fy + f0.h > hiY) ay = hiY - (fy + f0.h);
    const dx = op.r0.x + dX + ax - n.x, dy = op.r0.y + dY + ay - n.y; // this call's delta: repeated calls stay absolute from r0
    shift(n, dx, dy);
    if (isFrame(n)) { subregionMembers(p, n.id).forEach(m => shift(m, dx, dy)); n.placed = true; } else n.bubbleMoved = true;
  }

  // Apply a drag to the tree. op = editTarget result + { start:{x,y}, r0:{x,y,w,h} } (region at
  // drag start); cur = current screen point; cam = {s,tx,ty}. Absolute from r0, so repeatable.
  function applyDrag(op, cur, cam) {
    const dX = (cur.x - op.start.x) / cam.s, dY = (cur.y - op.start.y) / cam.s, n = op.n;
    if (isNew(n) && op.type !== 'resize') { moveNew(op, dX, dY); return; }
    if (op.type === 'moveBubble') {
      // Only this node's bubble moves; region and descendants stay. Marks it user-placed.
      if (!op.b0) op.b0 = { x: n.bubble.x, y: n.bubble.y }; // bubble at drag start (first call is before any change)
      n.bubble.x = op.b0.x + dX; n.bubble.y = op.b0.y + dY;
      n.bubbleMoved = true;
    } else if (op.type === 'move') {
      shift(n, op.r0.x + dX - n.x, op.r0.y + dY - n.y);
    } else {
      const m = minRegion(n), r0 = op.r0, mo = (op.lx || op.ty) ? maxOrigin(n, r0) : null;
      // inward stops at the start edge when the content already breaks the spacing (no jump on a click); outward still works
      const lim = mo && { x: Math.max(mo.x, r0.x), y: Math.max(mo.y, r0.y) };
      if (op.rx) n.w = Math.max(m.w, r0.w + dX);
      if (op.ry) n.h = Math.max(m.h, r0.h + dY);
      // left/top: the opposite edge stays; children and bubble keep their world positions (the origin is clamped to them)
      if (op.lx) { n.x = Math.min(lim.x, r0.x + dX); n.w = r0.x + r0.w - n.x; }
      if (op.ty) { n.y = Math.min(lim.y, r0.y + dY); n.h = r0.y + r0.h - n.y; }
      if (isFrame(n)) n.placed = true; // SR2: a resized frame keeps its own rect; its members stay where they are
      recenterBubble(n); // b268: new trees too: x, y, children and scale stay; only this box changes
    }
    growParents(n);
  }

  // ---- Auto arrange (SR3, b693): put a container or one subregion back to the automatic layout ----
  // A box's auto rect in layout-metadata units (parent-local, not rounded): the server's n.autoLayout (set when the plan's
  // saved layout moved it away from auto), else its load rect (origRects, id -> rectOf at load) relative to its parent's.
  function autoOf(n, origRects) {
    return n.autoLayout || localOf(origRects[n.id], n.scale, n.parent.scale, origRects[n.parent.id]);
  }
  // scope = a container: its size goes back to auto (its top-left stays: its place belongs to its parent), every child
  // to its auto rect (descendants move with it; a placed bean is centred again) and every frame to auto (placeFrames).
  // scope = a subregion frame: its members go to their auto rects and the frame to auto. Then the ancestors grow to
  // hold it (growParents, never shrink). A new tree only (the auto rects are in its units). Mutates; returns nothing.
  function autoArrange(scope, origRects) {
    const frame = isFrame(scope), C = frame ? scope.parent : scope;
    if (!C || !isNew(C)) return;
    let boxes;
    if (frame) {
      boxes = subregionMembers(C, scope.id);
      delete scope.placed;
    } else {
      if (C.parent) { const a = autoOf(C, origRects); C.w = a.rw * C.scale; C.h = a.rh * C.scale; recenterBubble(C); }
      boxes = C.children || [];
      (C.subregions || []).forEach(l => { delete l.placed; });
    }
    boxes.forEach(m => {
      const t = fromLocal(autoOf(m, origRects), m.scale, C.scale, C);
      shift(m, t.x - m.x, t.y - m.y);
      m.w = t.w; m.h = t.h;
      delete m.bubbleMoved;
      recenterBubble(m);
    });
    placeFrames(C);
    growParents(scope); // a frame: its container too (a box may have left a container the user made smaller)
  }

  // ---- history (Decision 0.6): one entry per finished drag, in memory, capped, pure data ----
  const MAX_HISTORY = 100;

  // The nodes one edit can change: the dragged node, all its descendants (frames too), all its ancestors (growParents);
  // for a frame also its members and their descendants (SR2: a frame move carries them).
  function editNodes(n) {
    const out = [];
    const walk = x => { out.push(x); below(x).forEach(walk); };
    walk(n);
    if (isFrame(n) && n.parent) subregionMembers(n.parent, n.id).forEach(walk); // SR2: a frame move carries its members
    for (let p = n.parent; p && !p.holder; p = p.parent) out.push(p); // C1 B2 (b832): a holder never changes
    return out;
  }

  // One node's editable state as data (SR2, Risk R5): region, bubble (deep copy), bubbleMoved and placed. The one copy
  // used by snapshot/undo here and, through the api, by the page's load rects (map.js rectsOf) and Reset (controls.js).
  function rectOf(n) {
    return { x: n.x, y: n.y, w: n.w, h: n.h, bubble: n.bubble ? { ...n.bubble } : null, bubbleMoved: !!n.bubbleMoved, placed: !!n.placed };
  }
  // Put a rectOf() value back on n exactly (a missing bubble, bubbleMoved or placed is removed).
  function setRect(n, r) {
    n.x = r.x; n.y = r.y; n.w = r.w; n.h = r.h;
    if (r.bubble) n.bubble = { ...r.bubble }; else delete n.bubble;
    if (r.bubbleMoved) n.bubbleMoved = true; else delete n.bubbleMoved;
    if (r.placed) n.placed = true; else delete n.placed;
  }

  // Deep copy of each node's rectOf (region, bubble, bubbleMoved, placed), so it can be restored exactly later.
  function snapshotRects(nodes) {
    return nodes.map(n => ({ id: n.id, ...rectOf(n) }));
  }

  function applyRects(rects, nodeById) {
    rects.forEach(r => {
      const n = nodeById[r.id];
      if (n) setRect(n, r);
    });
  }

  // Record a finished edit. A new edit drops the redo branch; the oldest entry goes past the cap.
  function pushEdit(history, before, after) {
    history.undo.push({ before, after });
    history.redo.length = 0;
    while (history.undo.length > MAX_HISTORY) history.undo.shift();
  }

  // Restore the newest entry's 'before' rects (undo) / 'after' rects (redo) in place. true if anything happened.
  function undo(history, nodeById) {
    const e = history.undo.pop();
    if (!e) return false;
    applyRects(e.before, nodeById);
    history.redo.push(e);
    return true;
  }
  function redo(history, nodeById) {
    const e = history.redo.pop();
    if (!e) return false;
    applyRects(e.after, nodeById);
    history.undo.push(e);
    return true;
  }

  // ---- export (P10-T2c, format v2 by P10-T1d): the layout.json that `c4mp plan apply-layout` writes into the .c4 plan ----
  // Only system/container/component/subregion are placed boxes of plan elements, so only they are exported. A subregion
  // frame exports once placed (SR2: n.placed); an auto frame follows its components (placeFrames) and is never listed.
  // Slices, files, functions, methods, classes stay automatic. nodes = flat list (map.js nodeById values); origRects =
  // id -> rectOf(n) {x,y,w,h,bubble,bubbleMoved,placed} at load. Each node has two positions + one size, all relative to the
  // PARENT region's top-left (root: absolute): bubble pos bx,by (only when user-placed), region pos rx,ry,
  // region size rw,rh. A node is listed when any of them differs from the original relative value: moving a
  // container shifts its children with it, leaving their relative values (and entries) alone.
  // SR3 (b693): a node the plan has a layout for (n.savedLayout) that is back at auto is listed as null (apply-layout then
  // drops its layout metadata): a frame that is not placed (even when its rect did not move), or a changed box whose
  // entry equals its rounded auto rect (autoOf, no bx,by).
  const EXPORT_KINDS = { system: 1, container: 1, component: 1, subregion: 1 };
  const EPS = 0.5;
  const roundLocal = l => ({ rx: Math.round(l.rx), ry: Math.round(l.ry), rw: Math.round(l.rw), rh: Math.round(l.rh) });
  const same = (a, b) => Object.keys({ ...a, ...b }).every(k => a[k] === b[k]);
  // New tree (P14-I8): parent-local units. Kp = parent scale, own scale s. Rounded, so compare rounded values.
  // rx,ry = slot top-left (slot centred on the region); rw,rh = own local size; bx,by only when the bean was placed.
  function newLocal(r, b, placed, s, Kp, po) {
    const e = roundLocal(localOf(r, s, Kp, po));
    if (placed && b) { e.bx = Math.round((b.x - po.x) / Kp); e.by = Math.round((b.y - po.y) / Kp); }
    return e;
  }
  // SR3 (b693): the same, not rounded and without bx,by (rect r, own scale s, parent scale Kp, parent rect po). The twin of
  // src/view/layout.ts localLayoutOf; fromLocal is its inverse (a world rect inside the parent rect po).
  function localOf(r, s, Kp, po) {
    return {
      rx: (r.x + r.w / 2 - SLOT.w * Kp / 2 - po.x) / Kp,
      ry: (r.y + r.h / 2 - SLOT.h * Kp / 2 - po.y) / Kp,
      rw: r.w / s, rh: r.h / s,
    };
  }
  function fromLocal(e, s, Kp, po) {
    const w = e.rw * s, h = e.rh * s;
    return { x: po.x + (e.rx + SLOT.w / 2) * Kp - w / 2, y: po.y + (e.ry + SLOT.h / 2) * Kp - h / 2, w, h };
  }
  function exportLayout(nodes, origRects) {
    const rel = (r, b, pr) => ({
      rx: r.x - (pr ? pr.x : 0), ry: r.y - (pr ? pr.y : 0), rw: r.w, rh: r.h,
      bx: b ? b.x - (pr ? pr.x : 0) : null, by: b ? b.y - (pr ? pr.y : 0) : null,
    });
    const out = { version: 2, nodes: {} };
    nodes.forEach(n => {
      const o = origRects[n.id];
      if (!EXPORT_KINDS[n.kind] || !o) return;
      if (isFrame(n) && !n.placed) { // SR2: an auto frame follows its boxes; it is never exported
        if (n.savedLayout) out.nodes[n.id] = null; // SR3 (b693): unless the plan placed it: null drops that layout
        return;
      }
      if (isNew(n)) {
        if (isTop(n) || !origRects[n.parent.id]) return; // a new-tree root or a holder's child (C1 B2 b832) has no unit: never exported
        const Kp = n.parent.scale, po = origRects[n.parent.id];
        const cur = newLocal(n, n.bubble, !!n.bubbleMoved, n.scale, Kp, n.parent);
        const was = newLocal(o, o.bubble, !!o.bubbleMoved, n.scale, Kp, po);
        if (!same(cur, was)) out.nodes[n.id] = n.savedLayout && !isFrame(n) && same(cur, roundLocal(autoOf(n, origRects))) ? null : cur; // SR3: back at auto
        return;
      }
      if (n.parent && n.parent.holder) return; // C1 B2 (b832): a holder's child is a top node: never exported
      const po = n.parent ? origRects[n.parent.id] : null;
      if (n.parent && !po) return;
      const cur = rel(n, n.bubble, n.parent), was = rel(o, o.bubble, po);
      const placed = !!n.bubbleMoved && cur.bx !== null;
      const keys = ['rx', 'ry', 'rw', 'rh'].concat(placed ? ['bx', 'by'] : []);
      const bubbleChanged = placed !== !!o.bubbleMoved || (placed && ['bx', 'by'].some(k => was[k] === null || Math.abs(cur[k] - was[k]) > EPS));
      if (bubbleChanged || keys.some(k => Math.abs(cur[k] - was[k]) > EPS)) {
        const e = {};
        if (placed) { e.bx = Math.round(cur.bx); e.by = Math.round(cur.by); }
        e.rx = Math.round(cur.rx); e.ry = Math.round(cur.ry); e.rw = Math.round(cur.rw); e.rh = Math.round(cur.rh);
        out.nodes[n.id] = e;
      }
    });
    return out;
  }

  const api = { GRIP, MAX_HISTORY, subregionMembers, placeFrames, footprint, rectOf, setRect, exportLayout, localOf, fromLocal, autoOf, autoArrange, editNodes, snapshotRects, pushEdit, undo, redo, shift, recenterBubble, childBounds, minRegion, growParents, isTop, editTarget, applyDrag };
  if (typeof window !== 'undefined') window.C4PM_EDIT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
