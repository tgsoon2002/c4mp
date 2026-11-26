// ioScreens.js: the screens family of the IO view (demo 6 / demo 7 wireframes). A screen is a wireframe frame (web = wide, phone = tall and
// rounder) holding its REGIONS stacked in plan order, each region holding its CONTROLS in a grid, state dots / pills, and a -> marker on a control
// that navigates. Screens stand in columns by navigation steps (W14 b310: entry.column from navColumns on the server, column c + 1 right of
// column c; an older page without it: entry.rank); inside a column they stack in plan order. A frame keeps its device
// width but GROWS in height until every region row has the height it needs (a screen with 14 regions / 45 controls stays readable).
// Three levels by the drawn width of a web frame: 1 = grey region bars (< 230 px), 2 = names + dots (< 560 px), 3 = everything + named pills.
// Region and control NAMES are drawn from level 2 up whenever their font is >= 6 px (not tied to level 3: a tall grown screen never reaches it).
//
// W11 (b307): a screen with a measured wireframe (band.wire[fqn].ok, measured once by ioView.layout with ioWireframe.js) is drawn from its
// boxes instead: a frame of its viewport's aspect (viewport x WORLD_PER_PX under the title row), each region / control where the HTML puts it.
// A screen without a wireframe, with a server error or with ok:false keeps the stacked strips above, unchanged (C8: the reason shows as a badge).
// b606: there a region's name never covers a box: it sits inside the region when the room above its first box holds the name row, else
// just above the region's top edge when that room is free, else it is not drawn at that zoom (the panel still names it).
// Back arrows go around the frames of the columns they cross (below the lowest one), see navGeom. b607: a forward arrow from a via first
// leaves its source frame by the nearest free edge; arrow labels are drawn after every arrow and avoid frames and the other arrows; the
// title-row badge shows a short mark (MARK_SHORT) when its text does not fit, also next to the title written above a small frame.
//
// CONTRACT  window.C4PM_IO_SCREENS = { families, measure(band), draw(dc, band), geom, WORLD_PER_PX, TB }   -- see the CONTRACT comment at the top of ioView.js
//   Layout uses fixed constants only (no ctx, no text measurement). The device of a screen comes from its navView node `io.device`
//   (band.io, from C4PM_DATA.navView; server rule navLayout.ts deviceOf), else entry.metadata.device, else 'web'. Ids of regions / controls are their fqn.
//   WORLD_PER_PX  map units per viewport px of a wireframe (0.25: a 1280 px web viewport keeps today's 320 wide frame).
//   TB            height of a frame's title row in map units; a wireframe frame is TB + viewport.h x WORLD_PER_PX (+ STRIP with screen states) high.
//   Wireframe boxes (band.wire[fqn].boxes, { ref, x, y, w, h, hidden, order } in viewport px): ref -> fqn only through entry.wireframe.refs (C1,
//   nothing is resolved here). measure sets band.boxes[fqn] = [{ x, y, w, h, hidden }] (band-local, one per box) and band.local[fqn] = their
//   union (C9). A ref to a state is not drawn and not hit (H5); a ref with a problem (unknown, ambiguous) or no fqn is drawn with a findings
//   outline and the name '? <ref>', and is not hit. A part with no box gets no rect here (ioView falls back to the screen's rect).
(function () {
  // demo constants
  const TB = 24, STRIP = 18, COLGAP = 110, ROWGAP = 90;
  const DEVICES = { web: { W: 320, H: 240, rad: 6 }, phone: { W: 130, H: 282, rad: 18 } };
  const SW = DEVICES.web.W;
  const REGION_INSET = 2.5, LABEL_H = 12, CTRL_H = 24, CTRL_PAD = 3;
  const PAD_MIN = 60;   // above / below the columns when no arrow needs more
  const SAME_OUT = 60;   // W14: how far right of its column a same-column arrow turns
  const BACK_IN = 0.75;  // W14: a back arrow comes from below: it enters the right edge at 3/4 of the frame height
  const BACK_OUT = 35, BACK_R = 40;   // b606: a back arrow goes down / up this far right of a column's right edge, with corners of this radius
  const EXIT = 20, EXIT_TB = 44;   // b607: a forward arrow from a via leaves its frame by this much before it turns (right; top / bottom:
                                   // above the title written over a small frame at the usual zooms)
  const WORLD_PER_PX = 0.25;   // W11 (b307, C10): the one scale from wireframe viewport px to map units (320 / 1280)
  const HIDDEN_DASH = [4, 3], HIDDEN_FILL = 0.45;   // H6 / D2: a box shown only sometimes: dashed outline, faint fill

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const colsFor = (w, n) => clamp(Math.floor(w / 62), 1, Math.max(1, Math.min(3, n)));
  const inset = (b, d) => ({ x: b.x + d, y: b.y + d, w: Math.max(1, b.w - 2 * d), h: Math.max(1, b.h - 2 * d) });
  const isState = p => p.kind === 'state';

  // ---- device of an entry: the entry's io.device from band.io (one rule, on the server), else its metadata, else web
  const deviceMap = band => { const m = {}; band.entries.forEach(e => { const io = band.io[e.fqn]; if (io && io.device) m[e.fqn] = io.device; }); return m; };

  // ---- one screen's wireframe in its own coordinates (origin = top-left of the frame)
  function shapeOf(entry, device) {
    const dev = DEVICES[device] ? device : 'web', d = DEVICES[dev];
    const regions = entry.parts.filter(p => !isState(p)), states = entry.parts.filter(isState);
    const bodyW = d.W - 16, natural = d.H - TB - STRIP - 8;
    const infos = regions.map(r => {
      const ctls = r.parts.filter(p => !isState(p)), n = ctls.length;
      const cols = colsFor(bodyW - 11, n), rows = Math.ceil((n / cols) || 1);
      return { r, ctls, share: 0.7 + rows, min: LABEL_H + CTRL_PAD + CTRL_H * rows + 2 * REGION_INSET };
    });
    const totShare = infos.reduce((a, x) => a + x.share, 0) || 1, totMin = infos.reduce((a, x) => a + x.min, 0);
    const bodyH = Math.max(natural, totMin);
    const prop = infos.map(x => bodyH * x.share / totShare);
    const useProp = infos.every((x, i) => prop[i] >= x.min - 1e-6);
    const slots = infos.map((x, i) => (useProp ? prop[i] : x.min + (bodyH - totMin) * x.share / totShare));
    let y = TB + 4;
    const boxes = infos.map((x, i) => {
      const b = inset({ x: 8, y, w: bodyW, h: slots[i] }, REGION_INSET);
      y += slots[i];
      return { node: x.r, x: b.x, y: b.y, w: b.w, h: b.h, controls: placeControls(b, x.ctls) };
    });
    return { dev, w: d.W, h: bodyH + TB + STRIP + 8, rad: d.rad, boxes, states };
  }
  // ---- W11 (b307): one screen's frame from its measured wireframe (res = band.wire[fqn], ok). Same origin as shapeOf. items = the boxes to
  // draw, in draw order (C10): shown before hidden; within each, regions before controls (a box with no part last); then document order.
  function wireShape(entry, res, device) {
    const dev = DEVICES[device] ? device : 'web', d = DEVICES[dev];
    const states = entry.parts.filter(isState), partOf = {}, refOf = {};
    (function walk(ps) { ps.forEach(p => { partOf[p.fqn] = p; walk(p.parts); }); })(entry.parts);
    entry.wireframe.refs.forEach(r => { refOf[r.ref] = r; });
    const vp = res.viewport, items = [];
    res.boxes.forEach(b => {
      const r = refOf[b.ref], node = r && r.fqn && !r.problem ? partOf[r.fqn] || null : null;
      if (node && isState(node)) return;   // H5: states are not placed
      items.push({ node, ref: b.ref, hidden: !!b.hidden, order: b.order, rank: !node ? 2 : node.kind === 'region' ? 0 : 1,
        x: b.x * WORLD_PER_PX, y: TB + b.y * WORLD_PER_PX, w: b.w * WORLD_PER_PX, h: b.h * WORLD_PER_PX });
    });
    items.sort((a, b) => (a.hidden - b.hidden) || (a.rank - b.rank) || (a.order - b.order));
    items.forEach(it => { if (it.rank === 0) nameRoom(it, items); });
    return { dev, w: vp.w * WORLD_PER_PX, h: TB + vp.h * WORLD_PER_PX + (states.length ? STRIP : 0), rad: d.rad, boxes: [], states,
      wire: true, viewport: { w: vp.w, h: vp.h }, items };
  }
  // b606: the room (world units) for a region's name, so that it never covers a box. it.gap = from its top edge down to the first box
  // that overlaps it (its controls, a region inside it); it.room = from its top edge up to the first box above it in its x span, or to the
  // title row. A box that holds the whole region does not count; a shown region counts only shown boxes (a hidden box is drawn over it).
  function nameRoom(it, items) {
    let gap = it.h, room = it.y - TB;
    items.forEach(o => {
      if (o === it || (o.hidden && !it.hidden) || o.x >= it.x + it.w || it.x >= o.x + o.w) return;
      if (o.x <= it.x && o.y <= it.y && o.x + o.w >= it.x + it.w && o.y + o.h >= it.y + it.h) return;
      if (o.y + o.h <= it.y) room = Math.min(room, it.y - o.y - o.h);
      else if (o.y < it.y + it.h) { gap = Math.min(gap, Math.max(0, o.y - it.y)); if (o.y < it.y) room = 0; }
    });
    it.gap = gap; it.room = room;
  }
  const union = rs => {
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
    return { x: x0, y: y0, w: Math.max(...rs.map(r => r.x + r.w)) - x0, h: Math.max(...rs.map(r => r.y + r.h)) - y0 };
  };

  function placeControls(box, ctls) {
    if (!ctls.length) return [];
    const n = ctls.length, lb = Math.min(LABEL_H, box.h * 0.3);
    const area = { x: box.x + CTRL_PAD, y: box.y + lb, w: box.w - 2 * CTRL_PAD, h: Math.max(4, box.h - lb - CTRL_PAD) };
    const cols = colsFor(area.w, n), rows = Math.ceil(n / cols), cw = area.w / cols, ch = Math.min(CTRL_H, area.h / rows);
    return ctls.map((c, i) => ({ node: c, x: area.x + (i % cols) * cw + 1.5, y: area.y + Math.floor(i / cols) * ch + 1.5, w: Math.max(2, cw - 3), h: Math.max(2, ch - 3),
      states: c.parts.filter(isState) }));
  }

  // ---- navigation geometry (demo navGeom, W14 b310 / D5): a path of cubic segments [p0, c, c, p1, c, c, p2, ...] (3n + 1 points) that
  // starts at the centre of the right edge of v (the via's box; default: the source frame). Next column = side to side into the target's
  // left edge; further right = arc above into its left edge; the same column = out to the right, into the target's right edge (one cubic
  // each). Back (an earlier column, b606) = around the frames of the columns it crosses: right of the source's column, below the lowest
  // frame of those columns, up right of the target's column, into the lower part of the target's right edge (round corners).
  // a, b = world (band-local) rects of the source and target frames with .col; v = a world rect; frames = the rects (with .col) of every
  // screen of the band (a and b among them).
  // b607: a FORWARD arrow (dc >= 1) from a via inside the source frame first leaves that frame by its nearest free edge (right; top only when
  // no frame stands above the source in its column; bottom only when none stands below): straight from the via's side to outside the edge
  // (EXIT right, EXIT_TB above / below), then from the top / bottom along that edge (round corner) to EXIT right of the column. The usual
  // curve starts there, so the arrow never runs through the source's other boxes. The label sits on that curve (path.mid = its segment index).
  function navGeom(a, b, v, frames) {
    const dc = b.col - a.col, via = !!v && !(v.x === a.x && v.y === a.y && v.w === a.w && v.h === a.h);
    const lead = via && dc >= 1 ? exitPath(a, v, frames) : null;
    const st = v || a, p0 = lead ? lead[lead.length - 1] : { x: st.x + st.w, y: st.y + st.h / 2 };
    const left = { x: b.x, y: b.y + b.h / 2 }, right = { x: b.x + b.w, y: b.y + b.h / 2 };
    let p1, p2, p3;
    if (dc === 1) {
      p3 = left;
      const d = (p3.x - p0.x) / 2; p1 = { x: p0.x + d, y: p0.y }; p2 = { x: p3.x - d, y: p3.y };
    } else if (dc > 1) {
      p3 = left;
      const top = Math.min(a.y, b.y) - 130 - 45 * dc; p1 = { x: p0.x + 40, y: top }; p2 = { x: p3.x - 40, y: top };
    } else if (dc === 0) {
      p3 = right;
      const out = Math.max(a.x + a.w, b.x + b.w) + SAME_OUT; p1 = { x: out, y: p0.y }; p2 = { x: out, y: p3.y };
    } else {
      p3 = { x: right.x, y: b.y + b.h * BACK_IN };
      const crossed = frames.filter(f => f.col >= b.col && f.col <= a.col), colRight = c => Math.max(...crossed.filter(f => f.col === c).map(f => f.x + f.w));
      const bot = Math.max(...crossed.map(f => f.y + f.h)) + 50 + 38 * (-dc), xa = colRight(a.col) + BACK_OUT, xb = colRight(b.col) + BACK_OUT;
      return rounded([p0, { x: xa, y: p0.y }, { x: xa, y: bot }, { x: xb, y: bot }, { x: xb, y: p3.y }, p3], BACK_R);
    }
    if (!lead) return [p0, p1, p2, p3];
    const path = lead.concat([p1, p2, p3]);
    path.mid = (path.length - 1) / 3 - 1;
    return path;
  }
  // b607: the leading part of a forward arrow from via v out of its source frame a (see navGeom), ending EXIT right of a's column
  function exitPath(a, v, frames) {
    const col = frames.filter(f => f.col === a.col), others = col.filter(f => f.x !== a.x || f.y !== a.y);
    const xr = Math.max(a.x + a.w, ...col.map(f => f.x + f.w)) + EXIT;
    const sides = [['right', a.x + a.w - (v.x + v.w)]];
    if (!others.some(f => f.y + f.h <= a.y)) sides.push(['top', v.y - a.y]);
    if (!others.some(f => f.y >= a.y + a.h)) sides.push(['bottom', a.y + a.h - (v.y + v.h)]);
    const side = sides.reduce((m, q) => (q[1] < m[1] ? q : m))[0];
    if (side === 'right') { const p0 = { x: v.x + v.w, y: v.y + v.h / 2 }; return rounded([p0, { x: xr, y: p0.y }], BACK_R); }
    const top = side === 'top', p0 = { x: v.x + v.w / 2, y: top ? v.y : v.y + v.h }, y = top ? a.y - EXIT_TB : a.y + a.h + EXIT_TB;
    return rounded([p0, { x: p0.x, y }, { x: xr, y }], EXIT_TB);   // the corner turns outside the frame
  }
  // b606: a polyline as cubic segments (a straight piece = a cubic with its control points on it), each corner rounded with radius
  // r (at most half of either piece next to it; a quarter-circle cubic for a right angle)
  function rounded(pts, r) {
    const K = 0.5523, out = [pts[0]], lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const line = q => { const p = out[out.length - 1]; out.push(lerp(p, q, 1 / 3), lerp(p, q, 2 / 3), q); };
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], k = pts[i], n = pts[i + 1], lp = Math.hypot(k.x - p.x, k.y - p.y), ln = Math.hypot(n.x - k.x, n.y - k.y);
      const rr = Math.min(r, lp / 2, ln / 2), s = lerp(k, p, rr / lp), e = lerp(k, n, rr / ln);
      line(s); out.push(lerp(s, k, K), lerp(e, k, K), e);
    }
    line(pts[pts.length - 1]);
    return out;
  }
  const segs = P => { const s = []; for (let i = 0; i + 3 < P.length; i += 3) s.push(P.slice(i, i + 4)); return s; };   // the cubics of a path
  const bez = (P, t) => {
    const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
    return { x: k0 * P[0].x + k1 * P[1].x + k2 * P[2].x + k3 * P[3].x, y: k0 * P[0].y + k1 * P[1].y + k2 * P[2].y + k3 * P[3].y };
  };

  // ---- measure: columns by navigation step (entry.column, else rank), screens stacked per column in plan order, room around for the arrows
  function measure(band) {
    const devs = deviceMap(band);
    const colKey = e => (e.column === undefined ? e.rank : e.column);
    const keys = [...new Set(band.entries.map(colKey))].sort((a, b) => a - b);
    const shapes = {}, cols = keys.map(k => band.entries.filter(e => colKey(e) === k));
    band.entries.forEach(e => {
      const dev = devs[e.fqn] || (e.metadata && e.metadata.device), res = band.wire && band.wire[e.fqn];
      shapes[e.fqn] = res && res.ok ? wireShape(e, res, dev) : shapeOf(e, dev);
    });
    // column x and the rects of the screens and their parts (y from 0 = top of the columns; moved down by the room above at the end)
    band.local = {};
    band.shapes = shapes; band.cols = {}; band.owner = {}; band.boxes = {};
    let x = 0, bottom = 0;
    cols.forEach((col, ci) => {
      const colW = Math.max(...col.map(e => shapes[e.fqn].w));
      let y = 0;
      col.forEach(e => {
        const sh = shapes[e.fqn], r = { x: x + (colW - sh.w) / 2, y, w: sh.w, h: sh.h };
        band.local[e.fqn] = r; band.cols[e.fqn] = ci; band.owner[e.fqn] = e.fqn;
        sh.boxes.forEach(b => {
          band.local[b.node.fqn] = { x: r.x + b.x, y: r.y + b.y, w: b.w, h: b.h }; band.owner[b.node.fqn] = e.fqn;
          b.controls.forEach(c => { band.local[c.node.fqn] = { x: r.x + c.x, y: r.y + c.y, w: c.w, h: c.h }; band.owner[c.node.fqn] = e.fqn; });
        });
        if (sh.wire) sh.items.forEach(it => {   // W11: one band-local rect per box; the part's rect is their union (below)
          if (!it.node) return;
          (band.boxes[it.node.fqn] = band.boxes[it.node.fqn] || []).push({ x: r.x + it.x, y: r.y + it.y, w: it.w, h: it.h, hidden: it.hidden });
          band.owner[it.node.fqn] = e.fqn;
        });
        y += sh.h + ROWGAP;
      });
      bottom = Math.max(bottom, y - ROWGAP);
      x += colW + COLGAP;
    });
    Object.keys(band.boxes).forEach(id => { band.local[id] = union(band.boxes[id]); });
    const width = Math.max(0, x - COLGAP);
    // room for the arrows: sample every curve of this band (from its via's box)
    const at = id => ({ ...band.local[id], col: band.cols[id] });
    let minY = 0, maxY = bottom, maxX = width;
    arrowsOf(band).forEach(a => segs(arrowGeom(band, a, at)).forEach(P => {
      for (let i = 0; i <= 20; i++) { const q = bez(P, i / 20); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); maxX = Math.max(maxX, q.x); }
    }));
    const hasUp = minY < 0, hasDown = maxY > bottom;
    const top = hasUp ? Math.max(PAD_MIN, -minY + 30) : PAD_MIN, bot = hasDown ? Math.max(PAD_MIN, maxY - bottom + 30) : PAD_MIN;
    Object.keys(band.local).forEach(id => { band.local[id].y += top; });
    Object.keys(band.boxes).forEach(id => band.boxes[id].forEach(b => { b.y += top; }));
    band.w = maxX > width ? maxX + 30 : width; band.h = top + bottom + bot;
  }
  // world rect (with .col) of an entry in this band
  const worldRect = (band, id) => { const l = band.local[id]; return { x: band.x + l.x, y: band.y + l.y, w: l.w, h: l.h, col: band.cols[id] }; };
  // the path of one arrow; at(id) = the rect (with .col) of an id. It starts at its via's rect; a via with no rect (a state, a part with no box): the frame
  const arrowGeom = (band, a, at) => navGeom(at(a.from), at(a.to), at(a.via && band.local[a.via] ? a.via : a.from), band.entries.filter(e => band.local[e.fqn]).map(e => at(e.fqn)));

  // ---- drawing
  function stateTone(C, st) {   // badge colour from the first word of the state's title (a demo rule), from CSS variables
    const t = String(st.title || '').toLowerCase();
    if (t.startsWith('error')) return { bg: C.method.DELETE, fg: C.panel };
    if (t.startsWith('loading')) return { bg: C.method.PUT, fg: C.panel };
    if (t.startsWith('empty')) return { bg: C.muted, fg: C.panel };
    if (t.startsWith('disabled')) return { bg: C.line, fg: C.ink };
    return { bg: C.screenSoft, fg: C.accent };
  }
  function pill(dc, x, cy, text, fs, bg, fg, align) {   // filled pill with centred text; returns its screen rect
    const { ctx } = dc;
    ctx.font = `600 ${fs}px ${dc.font}`;
    const w = ctx.measureText(text).width + fs * 1.2, h = fs * 1.55, x0 = align === 'right' ? x - w : x;
    ctx.fillStyle = bg; dc.rr(x0, cy - h / 2, w, h, h / 2); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x0 + w / 2, cy + 0.5);
    return { x: x0, y: cy - h / 2, w, h };
  }
  const markers = (dc, band) => {   // ids of the parts that navigate (the rows' nav of every screen), cached on the band
    if (band._nav) return band._nav;
    const m = {};
    band.entries.forEach(e => { const io = dc.rows(e.fqn); if (io) io.rows.forEach(r => { if (r.nav) m[r.id] = true; }); });
    return (band._nav = m);
  };

  // One control box (both paths): white box, control stroke (accent when selected, amber when dc.ring holds it: map.hi, not a sim), its hit, name, -> marker, state dots / pills.
  // alpha = the box's alpha; hid (W11, H6) = shown only sometimes: faint fill (the caller sets the dash).
  function drawControl(dc, c, Q, states, lvl, nav, alpha, br, hid) {
    const { ctx, C, cam } = dc, s = cam.s;
    const csel = dc.sel === c.fqn, lit = !!dc.ring && dc.ring.has(c.fqn), go = !!nav[c.fqn];
    ctx.globalAlpha = hid ? alpha * HIDDEN_FILL : alpha; ctx.fillStyle = C.panel; dc.rr(Q.x, Q.y, Q.w, Q.h, br * 0.7); ctx.fill();
    if (hid) ctx.globalAlpha = alpha;
    ctx.strokeStyle = csel ? C.accent : lit ? dc.glow.hi : C.control; ctx.lineWidth = csel || lit ? 2 : 1; dc.rr(Q.x, Q.y, Q.w, Q.h, br * 0.7); ctx.stroke();
    dc.hits.push({ id: c.fqn, R: Q });
    const cfs = Math.min(12, 7 * s, Q.h * 0.5);
    if (cfs >= 6) {   // level 2 and up (level 1 returned above): names whenever the font reads, not tied to the frame width (tall grown screens)
      ctx.fillStyle = C.ink; ctx.font = `500 ${cfs}px ${dc.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const room = Q.w - 6 * s - (go ? cfs : 0);
      ctx.fillText(dc.fit(c.title, room) || c.title, Q.x + 3 * s, Q.y + Q.h / 2, Math.max(4, room));
    }
    if (go && lvl >= 2) {   // navigation marker: this control leads to another screen
      ctx.fillStyle = C.screen; ctx.font = `700 ${Math.max(7, cfs)}px ${dc.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('→', Q.x + Q.w - 2 * s, Q.y + Q.h / 2);
    }
    if (states.length) {   // control states: dots on level 2, named pills on level 3
      let x = Q.x + Q.w - 2;
      states.slice().reverse().forEach(stt => {
        const tone = stateTone(C, stt);
        if (lvl === 3) { const pr = pill(dc, x, Q.y, String(stt.title).split(':')[0], Math.min(10, 5 * s), tone.bg, tone.fg, 'right'); x = pr.x - 3; }
        else { ctx.fillStyle = tone.bg; ctx.beginPath(); ctx.arc(x - 3, Q.y + 1, Math.max(2, 2.4 * s), 0, 7); ctx.fill(); x -= 3 * s + 6; }
      });
    }
  }
  // One region box (both paths): soft fill, line (accent when selected), its hit, name at the left with its middle at ny (px; null: no name).
  const nameFs = s => Math.min(12, 8 * s);   // a region name's font size (px) at zoom s; drawn when >= 6
  function drawRegion(dc, node, B, br, hid, ny) {
    const { ctx, C, cam } = dc, s = cam.s, rsel = dc.sel === node.fqn, a = ctx.globalAlpha;
    if (hid) ctx.globalAlpha = a * HIDDEN_FILL;
    ctx.fillStyle = C.screenSoft; dc.rr(B.x, B.y, B.w, B.h, br); ctx.fill();
    if (hid) ctx.globalAlpha = a;
    ctx.strokeStyle = rsel ? C.accent : C.screenLine; ctx.lineWidth = rsel ? 2 : 1; dc.rr(B.x, B.y, B.w, B.h, br); ctx.stroke();
    dc.hits.push({ id: node.fqn, R: B });
    const lfs = nameFs(s);
    if (lfs >= 6 && ny !== null) {
      ctx.fillStyle = C.screen; ctx.font = `600 ${lfs}px ${dc.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(dc.fit(node.title, B.w - 6 * s) || node.title, B.x + 3 * s, ny);
    }
  }

  // ---- W11 (b307): the boxes of a screen drawn from its wireframe, in sh.items order (C10). Every box of a part is a hit (a part on two
  // elements is hit in both places). Level 1: grey bars only, no part hits (as the strips). A box with no part: findings outline, '? <ref>'.
  function drawWire(dc, sh, W, lvl, wa, nav) {
    const { ctx, C, cam } = dc, s = cam.s, br = Math.max(1.5, 4 * s), ga = ctx.globalAlpha;
    sh.items.forEach(it => {
      const B = dc.toPx({ x: W.x + it.x, y: W.y + it.y, w: it.w, h: it.h });
      if (dc.offScreen(B)) return;
      ctx.globalAlpha = ga * wa;
      if (it.hidden) ctx.setLineDash(HIDDEN_DASH);
      if (!it.node) {
        ctx.strokeStyle = C.findings; ctx.lineWidth = 1.2; dc.rr(B.x, B.y, B.w, B.h, br); ctx.stroke();
        const fs = Math.min(12, 8 * s), t = '? ' + it.ref;
        if (lvl > 1 && fs >= 6) {
          ctx.fillStyle = C.findings; ctx.font = `600 ${fs}px ${dc.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(dc.fit(t, B.w - 6 * s) || t, B.x + 3 * s, B.y + Math.min(LABEL_H, it.h * 0.3) * s / 2 + 0.5);
        }
      } else if (lvl === 1) {
        const ctl = it.rank === 1;
        ctx.fillStyle = ctl ? C.control : C.screenLine; ctx.globalAlpha = ga * wa * (ctl ? 0.6 : 1) * (it.hidden ? HIDDEN_FILL : 1);
        dc.rr(B.x, B.y, B.w, ctl ? Math.max(1, B.h * 0.75) : B.h, ctl ? br * 0.6 : br); ctx.fill();
      } else if (it.rank === 0) {   // b606: the name row inside the region above its first box, else just above its top edge, else no name
        const row = nameFs(s) + 2;
        drawRegion(dc, it.node, B, br, it.hidden, it.gap * s >= row ? B.y + row / 2 : it.room * s >= row ? B.y - row / 2 : null);
      } else drawControl(dc, it.node, B, it.node.parts.filter(isState), lvl, nav, ga * wa, br, it.hidden);
      if (it.hidden) ctx.setLineDash([]);
    });
    ctx.globalAlpha = ga;
  }

  // W11 (b307): the right end of the title row: the badge of band.mark (section 6) and, for a frame drawn from its wireframe, its viewport size
  // (H9). x0 = the right end of the title; each is drawn only when it fits between the title and the frame's right edge.
  // b607: MARK_SHORT = the badge when its full text does not fit (also next to the title written above a small frame).
  const MARK_TEXT = { none: 'no wireframe', error: 'wireframe not drawn', 'not-drawn': 'wireframe not drawn', 'out-of-date': 'wireframe out of date' };
  const MARK_SHORT = { none: '∅', error: '!', 'not-drawn': '!', 'out-of-date': '!' };
  const markTone = (C, mark) => (mark === 'none' ? { bg: C.screenLine, fg: C.ink } : { bg: C.findings, fg: C.panel });
  function titleTail(dc, band, e, sh, R, tbH, x0) {
    const mark = band.mark ? band.mark[e.fqn] : undefined;
    if (!MARK_TEXT[mark] && !sh.wire) return;
    const { ctx, C, cam } = dc, fs = Math.min(10, tbH * 0.42), cy = R.y + tbH / 2;
    let xr = R.x + R.w - 6 * cam.s;
    if (MARK_TEXT[mark]) {
      ctx.font = `600 ${fs}px ${dc.font}`;
      const fits = t => xr - ctx.measureText(t).width - fs * 1.2 >= x0, text = fits(MARK_TEXT[mark]) ? MARK_TEXT[mark] : MARK_SHORT[mark];
      if (!fits(text)) return;
      const tone = markTone(C, mark);
      xr = pill(dc, xr, cy, text, fs, tone.bg, tone.fg, 'right').x - 4 * cam.s;
    }
    if (sh.wire) {
      const text = sh.viewport.w + ' x ' + sh.viewport.h;
      ctx.font = `500 ${fs}px ${dc.font}`;
      if (xr - ctx.measureText(text).width < x0) return;
      ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(text, xr, cy);
    }
  }

  function drawScreen(dc, band, e, lvl) {
    const { ctx, C, cam } = dc, s = cam.s, sh = band.shapes[e.fqn], W = worldRect(band, e.fqn), R = dc.toPx(W);
    if (dc.offScreen({ x: R.x - 40, y: R.y - 40, w: R.w + 80, h: R.h + 80 })) return;
    const planned = dc.statusOf(e.fqn) === 'planned', rad = Math.max(3, sh.rad * s), nav = markers(dc, band);
    dc.entryBegin(e.fqn);
    dc.hits.push({ id: e.fqn, R });
    // frame
    if (planned) {
      ctx.fillStyle = C.screen; ctx.globalAlpha *= 0.06; dc.rr(R.x, R.y, R.w, R.h, rad); ctx.fill(); ctx.globalAlpha /= 0.06;
    } else { ctx.fillStyle = C.panel; dc.rr(R.x, R.y, R.w, R.h, rad); ctx.fill(); }
    ctx.lineWidth = 1.6; ctx.strokeStyle = C.screen; ctx.setLineDash(dc.dash(e.fqn)); dc.rr(R.x, R.y, R.w, R.h, rad); ctx.stroke(); ctx.setLineDash([]);
    // title bar (a label above the frame when the bar is too small to hold text)
    const tbH = TB * s;
    ctx.save(); dc.rr(R.x, R.y, R.w, R.h, rad); ctx.clip();
    ctx.globalAlpha *= planned ? 0.5 : 1; ctx.fillStyle = C.screenSoft; ctx.fillRect(R.x, R.y, R.w, tbH);
    ctx.strokeStyle = C.screenLine; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(R.x, R.y + tbH); ctx.lineTo(R.x + R.w, R.y + tbH); ctx.stroke();
    ctx.restore();
    if (tbH >= 14) {
      const fs = Math.min(14, tbH * 0.5), title = dc.fit(e.title, R.w * (sh.dev === 'phone' ? 0.8 : 0.55)) || e.title;
      ctx.fillStyle = C.ink; ctx.font = `700 ${fs}px ${dc.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(title, R.x + 8 * s, R.y + tbH / 2);
      titleTail(dc, band, e, sh, R, tbH, R.x + 16 * s + ctx.measureText(title).width);
    } else {
      const fs = clamp(R.w / 7, 9, 12), title = dc.fit(e.title, SW * 1.3 * s) || e.title;
      ctx.fillStyle = C.ink; ctx.font = `600 ${fs}px ${dc.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(title, R.x + R.w / 2, R.y - 4);
      const mark = band.mark ? band.mark[e.fqn] : undefined;
      if (MARK_SHORT[mark]) {   // b607: the badge's short mark right of the title
        const tone = markTone(C, mark);
        pill(dc, R.x + R.w / 2 + ctx.measureText(title).width / 2 + 4, R.y - 4 - fs / 2, MARK_SHORT[mark], Math.min(10, fs), tone.bg, tone.fg, 'left');
      }
    }
    // regions and controls
    const wa = planned ? 0.55 : 1;
    if (sh.wire) drawWire(dc, sh, W, lvl, wa, nav);
    else sh.boxes.forEach(b => {
      const B = dc.toPx({ x: W.x + b.x, y: W.y + b.y, w: b.w, h: b.h }), br = Math.max(1.5, 4 * s);
      if (dc.offScreen(B)) return;
      const ga = ctx.globalAlpha;
      ctx.globalAlpha = ga * wa;
      if (lvl === 1) {
        ctx.fillStyle = C.screenLine; dc.rr(B.x, B.y, B.w, B.h, br); ctx.fill();
        ctx.fillStyle = C.control; ctx.globalAlpha = ga * wa * 0.6;
        b.controls.forEach(c => { const Q = dc.toPx({ x: W.x + c.x, y: W.y + c.y, w: c.w, h: c.h }); dc.rr(Q.x, Q.y, Q.w, Math.max(1, Q.h * 0.75), br * 0.6); ctx.fill(); });
        ctx.globalAlpha = ga;
        return;
      }
      drawRegion(dc, b.node, B, br, false, B.y + Math.min(LABEL_H, b.h * 0.3) * s / 2 + 0.5);
      b.controls.forEach(cb => {
        const Q = dc.toPx({ x: W.x + cb.x, y: W.y + cb.y, w: cb.w, h: cb.h });
        if (dc.offScreen(Q)) return;
        drawControl(dc, cb.node, Q, cb.states, lvl, nav, ga * wa, br, false);
      });
      ctx.globalAlpha = ga;
    });
    // screen-level states: strip at the bottom of the frame
    const sy = R.y + R.h - STRIP * s / 2 - 3 * s;
    let x = R.x + 8 * s;
    sh.states.forEach(stt => {
      const tone = stateTone(C, stt);
      if (lvl === 1) { ctx.fillStyle = tone.bg; ctx.beginPath(); ctx.arc(x + 2, sy, Math.max(1.6, 3.2 * s), 0, 7); ctx.fill(); x += Math.max(6, 9 * s); return; }
      const t = String(stt.title);
      const pr = pill(dc, x, sy, lvl === 3 ? t : t.split(':')[0], Math.min(11, 6.5 * s), tone.bg, tone.fg, 'left');
      x = pr.x + pr.w + 4 * s;
    });
    if (dc.sel === e.fqn) { ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = C.accent; dc.rr(R.x - 4, R.y - 4, R.w + 8, R.h + 8, rad + 4); ctx.stroke(); }
    dc.entryEnd(e.fqn, R, rad);
  }

  // Navigation arrows inside the band (demo drawNav). W14 (b310, D5): one arrow per (via, target), from the via's box (via null: the screen
  // frame), its label = that via's own relation labels. A back arrow (to an earlier column) is C.muted (another colour, not dashes, C10).
  // The selected screen (or a part of it): arrows leaving it cyan, entering it magenta, the others dim (0.16, label 0.3); a selected control:
  // only its own arrows glow. The label rule is dc.label's (core).
  function arrowsOf(band) {
    if (band._arrows) return band._arrows;
    const ids = new Set(band.entries.map(e => e.fqn)), seen = new Map();
    band.edges.forEach(e => {
      if (e.self || !ids.has(e.from) || !ids.has(e.to)) return;
      const k = (e.via || e.from) + '\u0000' + e.to, v = seen.get(k) || { from: e.from, to: e.to, via: e.via || null, labels: [] };
      if (!seen.has(k)) seen.set(k, v);
      if (e.labelled && e.label && v.labels.indexOf(e.label) < 0) v.labels.push(e.label);
    });
    return (band._arrows = [...seen.values()].map(v => ({ from: v.from, to: v.to, via: v.via, label: v.labels.join(', ') })));
  }
  function drawNav(dc, band) {
    const { ctx, C, cam } = dc, G = dc.glow, owner = dc.sel ? band.owner[dc.sel] : null;
    const selCtl = dc.sel && dc.kindOf(dc.sel) === 'control' ? dc.sel : null;   // a selected control: only its own arrows glow (demo drawNav selCtl)
    const list = arrowsOf(band).map(a => ({ a, out: selCtl ? a.via === selCtl : !!owner && a.from === owner, inn: !selCtl && !!owner && a.to === owner }))
      .sort((x, y) => (x.out + x.inn) - (y.out + y.inn));
    const avoid = band.entries.filter(e => band.local[e.fqn]).map(e => {   // the screen frames: a label pill never covers one (nor the title written above a small frame)
      const R = dc.toPx(worldRect(band, e.fqn)), up = TB * cam.s < 14 ? 16 : 0;
      return { x: R.x, y: R.y - up, w: R.w, h: R.h + up };
    });
    ctx.save();
    const todo = [], paths = [];
    list.forEach(({ a, out, inn }) => {
      const Wp = arrowGeom(band, a, id => worldRect(band, id)), P = Wp.map(p => ({ x: p.x * cam.s + cam.tx, y: p.y * cam.s + cam.ty }));
      const xs = P.map(p => p.x), ys = P.map(p => p.y);
      if (dc.offScreen({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) })) return;
      const back = band.cols[a.to] < band.cols[a.from], col = out ? G.out : inn ? G.in : back ? C.muted : C.edge, dim = (!!owner || dc.simOn) && !out && !inn;
      ctx.globalAlpha = dim ? 0.16 : 1; ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = out || inn ? 2.4 : 1.6;
      const S = segs(P), E = P[P.length - 1], E1 = P[P.length - 2];
      ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y); S.forEach(q => ctx.bezierCurveTo(q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y)); ctx.stroke();
      const ang = Math.atan2(E.y - E1.y, E.x - E1.x);
      ctx.beginPath(); ctx.moveTo(E.x, E.y);
      ctx.lineTo(E.x - G.arrow * Math.cos(ang - 0.4), E.y - G.arrow * Math.sin(ang - 0.4));
      ctx.lineTo(E.x - G.arrow * Math.cos(ang + 0.4), E.y - G.arrow * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      paths.push(P);
      // the label's chord: its segment's; for a forward arrow from a via, the whole arrow's (the curve after the exit is shorter than before)
      const M = S[Wp.mid !== undefined ? Wp.mid : Math.floor(S.length / 2)], chord = Wp.mid !== undefined ? Math.hypot(E.x - P[0].x, E.y - P[0].y) : Math.hypot(M[3].x - M[0].x, M[3].y - M[0].y);
      if (a.label) todo.push({ a, P, M, chord, col, out, inn, dim });
    });
    // b607: the labels after every arrow. A label sits in the middle of the middle segment (one cubic: its middle; a back arrow: the piece
    // below the frames; a forward arrow from a via: the curve after it left its frame) and never covers a frame or another arrow.
    const clip = dc.toPx({ x: band.x, y: band.y, w: band.w, h: band.h });   // never outside the band's screen rect
    todo.forEach(({ a, P, M, chord, col, out, inn, dim }) => {
      const m = bez(M, 0.5);
      dc.label({ x: m.x, y: m.y, chord, text: a.label, col: out || inn ? col : C.line, alpha: dim ? 0.3 : 1, clip, avoid,
        avoidPaths: paths.filter(q => q !== P), along: P });
    });
    ctx.restore();
  }

  function draw(dc, band) {
    const lvl = dc.cam.s * SW < 230 ? 1 : dc.cam.s * SW < 560 ? 2 : 3;
    band.entries.forEach(e => { if (band.local[e.fqn]) drawScreen(dc, band, e, lvl); });
    drawNav(dc, band);
  }

  window.C4PM_IO_SCREENS = { families: ['screen'], measure, draw, geom: navGeom, WORLD_PER_PX, TB };
})();
