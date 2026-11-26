// sim-map.js: the simulation overlay on the map (Phase 25 UI8, b758): the path of the selected s-item drawn on top of the
// view, every frame, as a post-draw function (C4PM_STATE.post, map.js draw).
// Spec: Document/Roadmap/Phase25/UI_TASKS.md section C UI8 (feature inventory A4.2-A4.5); demo drawSimArch / numPill.
// Loaded right after sim.js (src/page/html.ts VIEWER_SCRIPTS); returns at once when the page has no s-items (no C4PM_SIM).
//
// CONTRACT  drawSimOverlay(map, C, now) (pushed to C4PM_STATE.post; nothing else is exported)
//   Reads map.sim (sim.js: { id, step, view, ids, calls, list, cur, tables }); draws nothing while it is null, or while it
//   was computed for another view than C4PM_MODE.get() (a mode switch in flight). Dispatch on the view:
//   'arch'    drawSimArch: per lit id, the deepest visible box that stands for it (C4PM_RENDER.edges.rep) gets an amber
//             ring (BGLOW, R +-5, radius min(16, h/2) + 5; a person: around its head and body, render.js shapePath; width 2.5, current step 4 + pulsing glow)
//             and a step-number pill at its top-left ("1 · 2 · 6", teal C.flow with C.panel ink; current: amber with
//             BGLOW_INK). Rings off the screen are skipped. Per step call, one teal arrow between the two visible boxes
//             (same pair = one arrow, numbers joined), offset 6 px to the right of its direction (a reply never hides its
//             call); width 2.6, current 4 + glow; head ARROW + 1 (current ARROW + 4); number pill 0.4 along from the
//             source. Unverified: C.unver, dash [9, 6], pill "8 ?". Both ends in one visible box: no arrow (the box's
//             pill carries the number). With a cursor the non-current arrows draw at alpha 0.45, rings at 0.55.
//             Non-lit boxes are not faded; the normal arrows dim in render.js drawEdges while map.sim is set.
//   'io'      drawSimIo (UI9, b759): screen rects = C4PM_IOVIEW.rect(id) through map.cam. Consecutive steps of map.sim.list
//             whose first targets sit in different entries (the target's entryId, server-resolved) are joined by a teal
//             arc over them (C.flow, width 2.6, current 4 + glow, alpha 0.5 off the cursor; control height = the higher
//             of the two entries - 46 - 10 * k); a gap in the numbers puts a pill "via 3–5 (other views)" (one step:
//             "via 4") on the arc. The same entry: no arc. Then per lit target an amber ring (BGLOW, pad 6 for an entry
//             = screen | command | route | tool, 3 for a smaller part; width 2.5, current 4 + glow; 0.55 off the
//             cursor) and a numbered circle (teal C.flow with C.panel ink, current amber with BGLOW_INK, r 10.5 / 12):
//             a part's on its top-left corner, an entry's left of its frame; a target used again shifts 24 px right per
//             earlier use. This ring is the only one: ioView.js dc.ring (entryEnd ring, control stroke) is map.hi only. ioView.js
//             itself fades the unlit entries to 0.3 and dims its arrows to 0.16 while map.sim lights something in the io
//             view (dc.hi, dc.simOn); an s-item with no io target fades and dims nothing.
//   storage   drawn by storageView.js itself (UI11).
// Colours: C (readColors: flow, unver, panel), RENDER.theme BGLOW / BGLOW_INK; fonts RENDER.theme.MONO.
// The early opening of the current step's components (map.openEarly, camera.js openness) is set by sim.js.
(function () {
  'use strict';
  const SIM = window.C4PM_SIM, ST = window.C4PM_STATE;
  if (!SIM || !ST) return;   // no s-items (or no data): nothing to draw
  const RD = () => window.C4PM_RENDER;
  const CAM = () => window.C4PM_CAM;
  const lerp = (a, b, t) => a + (b - a) * t;
  const ENTRY_KINDS = ['screen', 'command', 'route', 'tool'];   // an io target of another kind (region, control, flag ...) is "small"

  // A step-number pill: height 20, at least 20 wide, centred on (x, cy) (align 'center') or starting at x ('left').
  function numPill(ctx, x, cy, text, bg, fg, align) {
    const T = RD().theme;
    ctx.font = '700 11.5px ' + T.MONO;
    const w = Math.max(20, ctx.measureText(text).width + 12), h = 20, x0 = align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = bg;
    RD().text.rr(x0, cy - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = T.C().panel;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + w / 2, cy + 0.5);
  }

  // The architecture overlay (demo drawSimArch): numbered arrows first (current last), then the rings with their pills,
  // then the arrow pills on top.
  function drawSimArch(map, C, now) {
    const L = map.sim, ctx = map.ctx, E = RD().edges, T = RD().theme;
    const scr = CAM().scr, offScreen = CAM().offScreen;
    const glow = 8 + 6 * (0.5 + 0.5 * Math.sin(now / 220)), hasCur = L.cur !== null && L.cur !== undefined;
    const groups = new Map();
    (L.calls || []).forEach(c => {
      const P = E.rep(c.from), Q = E.rep(c.to);
      if (!P || !Q || !P._R || !Q._R || P === Q || E.isAnc(P, Q) || E.isAnc(Q, P)) return;   // both ends in one visible box: its pill carries the step
      const k = P.id + '>' + Q.id + (c.unverified ? '?' : '');
      if (!groups.has(k)) groups.set(k, { P, Q, ns: [], unverified: c.unverified, cur: false });
      const g = groups.get(k);
      g.ns.push(c.n);
      if (c.cur) g.cur = true;
    });
    ctx.save();
    const pills = [];
    [...groups.values()].sort((a, b) => a.cur - b.cur).forEach(g => {
      const ra = scr(g.P), rb = scr(g.Q);
      const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 }, dx = cb.x - ca.x, dy = cb.y - ca.y;
      const tA = Math.min(Math.abs(ra.w / 2 / (dx || 1e-6)), Math.abs(ra.h / 2 / (dy || 1e-6)));
      const tB = Math.min(Math.abs(rb.w / 2 / (dx || 1e-6)), Math.abs(rb.h / 2 / (dy || 1e-6)));
      if (!(tA + tB < 0.98)) return;   // the boxes overlap: no room for an arrow
      const d0 = Math.hypot(dx, dy) || 1, ox = -dy / d0 * 6, oy = dx / d0 * 6;   // 6 px to the right of the direction: a reply never hides its call
      const p1 = { x: ca.x + dx * (tA + 0.01) + ox, y: ca.y + dy * (tA + 0.01) + oy };
      const p2 = { x: cb.x - dx * (tB + 0.01) + ox, y: cb.y - dy * (tB + 0.01) + oy };
      const ang = Math.atan2(dy, dx);
      const col = g.unverified ? C.unver : C.flow, AH = g.cur ? T.ARROW + 4 : T.ARROW + 1;
      ctx.globalAlpha = hasCur && !g.cur ? 0.45 : 1;
      ctx.strokeStyle = ctx.fillStyle = col;
      ctx.lineWidth = g.cur ? 4 : 2.6;
      ctx.shadowColor = g.cur ? col : 'transparent';
      ctx.shadowBlur = g.cur ? glow : 0;
      if (g.unverified) ctx.setLineDash([9, 6]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x - Math.cos(ang) * AH * 0.6, p2.y - Math.sin(ang) * AH * 0.6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - AH * Math.cos(ang - 0.42), p2.y - AH * Math.sin(ang - 0.42));
      ctx.lineTo(p2.x - AH * Math.cos(ang + 0.42), p2.y - AH * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      // the number pill sits 0.4 along from the source: a reply's numbers never sit on its call's
      pills.push({
        x: lerp(p1.x, p2.x, 0.4), y: lerp(p1.y, p2.y, 0.4), t: g.ns.join(' · ') + (g.unverified ? ' ?' : ''),
        bg: g.cur ? T.BGLOW : col, fg: g.cur ? T.BGLOW_INK : C.panel, a: ctx.globalAlpha,
      });
    });
    const reps = new Map();   // visible box -> { ns, cur }: the lit ids rolled up
    L.ids.forEach((e, id) => {
      const r = E.rep(id);
      if (!r || !r._R) return;   // not drawn this tree (no screen rect yet)
      const x = reps.get(r) || { ns: [], cur: false };
      e.ns.forEach(n => { if (x.ns.indexOf(n) < 0) x.ns.push(n); });
      if (e.cur) x.cur = true;
      reps.set(r, x);
    });
    [...reps.entries()].sort((a, b) => a[1].cur - b[1].cur).forEach(([n, x]) => {
      const R = scr(n);
      if (offScreen(R)) return;
      ctx.globalAlpha = hasCur && !x.cur ? 0.55 : 1;
      ctx.strokeStyle = T.BGLOW;
      ctx.lineWidth = x.cur ? 4 : 2.5;
      ctx.shadowColor = x.cur ? T.BGLOW : 'transparent';
      ctx.shadowBlur = x.cur ? glow : 0;
      RD().beans.shapePath(n, R, 5, Math.min(16, R.h / 2));   // C1 C1 (b833): around a person's head and body; a box keeps its rounded ring
      ctx.stroke();
      ctx.shadowBlur = 0;
      x.ns.sort((a, b) => a - b);
      numPill(ctx, R.x + 2, R.y - 5, x.ns.join(' · '), x.cur ? T.BGLOW : C.flow, x.cur ? T.BGLOW_INK : C.panel, 'left');
    });
    pills.forEach(p => { ctx.globalAlpha = p.a; numPill(ctx, p.x, p.y, p.t, p.bg, p.fg, 'center'); });
    ctx.restore();
  }

  // The IO overlay (demo drawSimIO, UI9 b759): teal arcs between IO steps on different entries with "via" pills, then the
  // amber rings and numbered circles of the lit targets. Geometry from C4PM_IOVIEW.rect through map.cam.
  function drawSimIo(map, C, now) {
    const L = map.sim, IOV = window.C4PM_IOVIEW;
    if (!IOV || !L.list || !L.list.length) return;
    const ctx = map.ctx, cam = map.cam, T = RD().theme, rr = RD().text.rr, offScreen = CAM().offScreen;
    const glow = 8 + 6 * (0.5 + 0.5 * Math.sin(now / 220)), hasCur = L.cur !== null && L.cur !== undefined;
    const tgt = new Map();   // io node id -> its step target (entryId and kind, resolved on the server)
    SIM.steps(L.id).forEach(st => st.targets.forEach(t => { if (t.view === 'io' && t.nodeId && !tgt.has(t.nodeId)) tgt.set(t.nodeId, t); }));
    const home = id => (tgt.has(id) && tgt.get(id).entryId) || id;   // the entry (screen, command, route, tool) that holds it
    const R = id => {   // world rect (C4PM_IOVIEW.rect) -> screen px through map.cam; null when the layout has none
      const w = IOV.rect(id);
      return w ? { x: w.x * cam.s + cam.tx, y: w.y * cam.s + cam.ty, w: w.w * cam.s, h: w.h * cam.s } : null;
    };
    ctx.save();
    // the path: consecutive IO steps on different entries joined by an arc over them; a gap = steps in other views
    for (let k = 1; k < L.list.length; k++) {
      const a = L.list[k - 1], b = L.list[k], ha = home(a.ids[0]), hb = home(b.ids[0]);
      if (ha === hb) continue;   // the same entry: the numbers sit side by side, no arc
      const A = R(a.ids[0]), B = R(b.ids[0]), HA = R(ha), HB = R(hb);
      if (!A || !B || !HA || !HB) continue;
      const p0 = { x: A.x + A.w / 2, y: A.y }, p3 = { x: B.x + B.w / 2, y: B.y }, top = Math.min(HA.y, HB.y) - 46 - 10 * k;
      ctx.globalAlpha = hasCur && !b.cur ? 0.5 : 1;
      ctx.strokeStyle = ctx.fillStyle = C.flow;
      ctx.lineWidth = b.cur ? 4 : 2.6;
      ctx.shadowColor = b.cur ? C.flow : 'transparent';
      ctx.shadowBlur = b.cur ? glow : 0;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.bezierCurveTo(p0.x, top, p3.x, top, p3.x, p3.y - 6);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(p3.x, p3.y);
      ctx.lineTo(p3.x - 6, p3.y - 12);
      ctx.lineTo(p3.x + 6, p3.y - 12);
      ctx.closePath();
      ctx.fill();
      if (b.n - a.n > 1) {   // "via 3–5 (other views)", one step: "via 4 (other views)"
        const m = { x: (p0.x + p3.x) / 2, y: 0.25 * p0.y + 0.75 * top };
        const t = 'via ' + (a.n + 1) + (b.n - 1 > a.n + 1 ? '–' + (b.n - 1) : '') + ' (other views)';
        ctx.font = '600 11px ' + T.SANS;
        const w = ctx.measureText(t).width + 14;
        ctx.fillStyle = C.panel;
        rr(m.x - w / 2, m.y - 10, w, 20, 10);
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = C.flow;
        ctx.stroke();
        ctx.fillStyle = C.ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t, m.x, m.y + 0.5);
      }
    }
    // the lit targets: an amber ring (the only ring: ioView's entryEnd draws none for sim-lit entries) and a numbered circle
    // at the top-left corner (an entry's left of its frame, clear of its title); the current step last, on top
    L.list.slice().sort((a, b) => a.cur - b.cur).forEach(st => st.ids.forEach(id => {
      const Q = R(id);
      if (!Q || offScreen(Q)) return;
      const t = tgt.get(id), small = ENTRY_KINDS.indexOf(t ? t.kind : '') < 0, pad = small ? 3 : 6;
      ctx.globalAlpha = hasCur && !st.cur ? 0.55 : 1;
      ctx.strokeStyle = T.BGLOW;
      ctx.lineWidth = st.cur ? 4 : 2.5;
      ctx.shadowColor = st.cur ? T.BGLOW : 'transparent';
      ctx.shadowBlur = st.cur ? glow : 0;
      rr(Q.x - pad, Q.y - pad, Q.w + 2 * pad, Q.h + 2 * pad, 6 + pad);
      ctx.stroke();
      ctx.shadowBlur = 0;
      const before = L.list.filter(o => o.n < st.n && o.ids.indexOf(id) >= 0).length;   // a target used again: its number steps right
      const cx = (small ? Q.x - pad + 2 : Q.x - pad - 14) + before * 24, cy = small ? Q.y - pad : Q.y + 10, r = st.cur ? 12 : 10.5;
      ctx.fillStyle = st.cur ? T.BGLOW : C.flow;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = C.panel;
      ctx.stroke();
      ctx.fillStyle = st.cur ? T.BGLOW_INK : C.panel;
      ctx.font = '700 ' + (st.cur ? 12.5 : 11.5) + 'px ' + T.MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(st.n), cx, cy + 0.5);
    }));
    ctx.restore();
  }

  function drawSimOverlay(map, C, now) {
    const mode = window.C4PM_MODE.get();
    if (!map.sim || !map.ctx || map.sim.view !== mode) return;
    if (mode === 'arch') drawSimArch(map, C, now || 0);
    else if (mode === 'io') drawSimIo(map, C, now || 0);
  }

  ST.post.push(drawSimOverlay);
})();
