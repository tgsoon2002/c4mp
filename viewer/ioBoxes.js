// ioBoxes.js: the box family module of the IO view (commands, routes, tools). Ports demo 7's box apps (measure / placeBox / drawBox) over a
// generic box tree built from the entry's io.rows: an entry is a box; a row with deeper rows after it is an inner box (options group, body);
// any other row is one line (name left, type / word right). A subcommand (entry whose `parent` is another entry of the band) is drawn INSIDE
// its parent's box after the parent's own rows; only top-level entries are band items. Both the band and the subcommands of one box are
// placed by the core's skyline packer (C4PM_IOVIEW.pack). Nothing is measured with a canvas:
// widths come from character counts, so layout() can run at script load; text that does not fit is cut at draw time (dc.fit).
//
// CONTRACT  window.C4PM_IO_BOXES = { families, measure(band), draw(dc, band), setPacker({ pack, mapAspect }) }   -- see the CONTRACT comment at the top of ioView.js
//   measure: band.local[id] for every entry (top-level and sub) and every row / group; band.w / band.h cover all boxes.
//   draw:    every drawn box and row pushes { id, R } to dc.hits (parent before its children); every entry is wrapped in
//            dc.entryBegin / dc.entryEnd; text only when the font is >= 5 px; off-screen boxes are culled with their whole subtree.
(function () {
  const KB = 1.7;   // the box apps are drawn bigger than their natural size, so they read as well as the web screens at Fit (demo 7)
  const ROW = 22 * KB, PADB = 8 * KB, GAPB = 6 * KB, GAPA = 18 * KB, ROWW = 200 * KB;
  const HEADH = { entry: 28 * KB, group: 22 * KB };
  const BAND_GAP = 60;            // between top-level boxes of the band (and between sub boxes inside a box)
  const MAX_W = 4 * ROWW;         // a box never grows wider than this for a long name (the rest is cut with an ellipsis)
  const CH_HEAD = 12, CH_ROW = 10;  // estimated world width of one character of a header (bold) / of a row

  // ---- the box tree: { id, type: 'entry'|'group'|'row', entry?, row?, title, kids[], subs[], w, h, r }
  function build(entry, byParent, rowsOf) {
    const io = rowsOf(entry.fqn) || {}, rows = io.rows || [];
    const root = { id: entry.fqn, type: 'entry', entry, title: entry.title, detail: entry.description || '', method: io.method || null, kids: [], subs: [], w: 0, h: 0, r: null };
    const stack = [{ depth: -1, node: root }];
    rows.forEach((row, i) => {
      while (stack.length > 1 && stack[stack.length - 1].depth >= row.depth) stack.pop();
      const parent = stack[stack.length - 1].node;
      const next = rows[i + 1], isGroup = !!(next && next.depth > row.depth);
      const node = { id: row.id, type: isGroup ? 'group' : 'row', row, title: row.title, kids: [], subs: [], w: 0, h: 0, r: null };
      parent.kids.push(node);
      stack.push({ depth: row.depth, node });
    });
    (byParent[entry.fqn] || []).forEach(sub => root.subs.push(build(sub, byParent, rowsOf)));
    return root;
  }

  const rowType = n => (n.row.meta && n.row.meta.type) || n.row.word || n.row.kind || '';
  const headNeed = n => Math.min(MAX_W, (n.title || '').length * CH_HEAD + 150);
  const rowNeed = n => Math.min(MAX_W, (n.title || '').length * CH_ROW + String(rowType(n)).length * (CH_ROW * 0.9) + 36);

  // ONE packer for the whole IO view: the core's skyline packer (C4PM_IOVIEW.pack, handed over by setPacker). Top-level boxes of a band aim at the aspect 2.0 (the core's 1.6 for a
  // frame, plus room for the frame's header and padding, which the module cannot see: it makes two small boxes stand side by side, as in demo 7); the sub boxes inside a parent aim at 1.3: the parent's own rows are a narrow column above them, so a squarer
  // block of sub boxes keeps the parent from growing wider than it is tall.
  const TOP_K = 1.0, SUB_K = 0.8;   // x the map area's aspect (C4PM_IOVIEW.mapAspect(): about 1.0 when unknown)
  // ioView.js registers it (setPacker, LAY-12b) before its layout() runs: this file names no later script.
  let core = null;   // { pack, mapAspect }
  const pack = (items, gap, k) => {
    if (!core) throw new Error('C4PM_IO_BOXES: no packer registered (setPacker)');
    return core.pack(items, { gap, aspect: k * core.mapAspect() });
  };

  // demo measure(): a row is ROWW x ROW; a box is its header + its kids stacked (+ its sub boxes packed below)
  function measureNode(n) {
    if (n.type === 'row') { n.w = Math.max(ROWW, rowNeed(n)); n.h = ROW; return; }
    n.kids.forEach(measureNode); n.subs.forEach(measureNode);
    const hd = HEADH[n.type];
    n.packed = pack(n.subs.map(c => ({ w: c.w, h: c.h })), GAPA, SUB_K);
    const inner = Math.max(ROWW, headNeed(n) - 2 * PADB, ...n.kids.map(c => c.w), n.packed.w);
    let h = hd + PADB;
    n.kids.forEach((c, i) => { h += c.h + (i ? GAPB : 0); });
    if (n.subs.length) h += (n.kids.length ? GAPB : 0) + n.packed.h;
    n.w = inner + 2 * PADB; n.h = h + PADB;
  }

  // demo placeBox(): rects relative to the band content origin
  function placeNode(n, x, y, w, local) {
    n.r = { x, y, w, h: n.h }; local[n.id] = n.r;
    if (n.type === 'row') return;
    let cy = y + HEADH[n.type] + PADB;
    n.kids.forEach((c, i) => { placeNode(c, x + PADB, cy, w - 2 * PADB, local); cy += c.h + GAPB; });
    if (n.subs.length) {
      if (!n.kids.length) cy -= GAPB;
      n.subs.forEach((c, i) => placeNode(c, x + PADB + n.packed.pos[i].x, cy + n.packed.pos[i].y, c.w, local));
    }
  }

  function measure(band) {
    const lookup = id => band.io[id];   // the core puts each entry's navView io on the band (rows, meta.type, method)
    const inBand = new Set(band.entries.map(e => e.fqn));
    const byParent = {};
    band.entries.forEach(e => { if (e.parent && inBand.has(e.parent)) (byParent[e.parent] = byParent[e.parent] || []).push(e); });
    const tops = band.entries.filter(e => !(e.parent && inBand.has(e.parent)));
    band.local = {};
    band.tree = tops.map(e => build(e, byParent, lookup));
    band.tree.forEach(measureNode);
    const p = pack(band.tree.map(n => ({ w: n.w, h: n.h })), BAND_GAP, TOP_K);
    band.tree.forEach((n, i) => placeNode(n, p.pos[i].x, p.pos[i].y, n.w, band.local));
    band.w = p.w; band.h = p.h;
  }

  // ---- drawing
  function drawNode(dc, band, n, ox, oy, top) {
    const { ctx, C, cam } = dc;
    const R = dc.toPx({ x: ox + n.r.x, y: oy + n.r.y, w: n.r.w, h: n.r.h });
    if (dc.offScreen(R)) return;
    const s = cam.s * KB, isEntry = n.type === 'entry', row = n.type === 'row', sel = dc.sel === n.id;
    if (isEntry) dc.entryBegin(n.id);
    dc.hits.push({ id: n.id, R });
    const rad = row ? Math.max(1.5, 3 * s) : Math.max(2, 6 * s);
    ctx.save();
    ctx.fillStyle = isEntry ? C.screenSoft : C.panel;
    dc.rr(R.x, R.y, R.w, R.h, rad); ctx.fill();
    ctx.lineWidth = sel ? 2.8 : isEntry ? 1.6 : 1.1;
    ctx.strokeStyle = sel ? C.accent : isEntry ? C.screen : row ? C.control : C.screenLine;
    if (isEntry) ctx.setLineDash(dc.dash(n.id));
    dc.rr(R.x, R.y, R.w, R.h, rad); ctx.stroke(); ctx.setLineDash([]);
    if (row) {
      const fs = Math.min(12, R.h * 0.5);
      if (fs >= 5) {
        const cy = R.y + R.h / 2;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.font = `500 ${fs}px ${dc.font}`;
        ctx.fillText(dc.fit(n.title, R.w * 0.6) || n.title, R.x + 6 * s, cy);
        ctx.textAlign = 'right'; ctx.fillStyle = C.muted; ctx.font = `400 ${fs * 0.88}px ${dc.font}`;
        ctx.fillText(rowType(n), R.x + R.w - 6 * s, cy, R.w * 0.34);
      }
    } else {
      const hd = HEADH[n.type] * cam.s, fs = Math.min(15, hd * 0.5);
      if (fs >= 5) {
        const cy = R.y + hd / 2, kind = isEntry ? n.entry.kind : n.row.kind;
        let x = R.x + 8 * s, title = n.title;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `700 ${fs}px ${dc.font}`;
        if (isEntry && n.method) {
          const m = String(n.method), mc = C.method && C.method[m.toUpperCase()];
          const first = title.split(' ')[0];
          if (first.toUpperCase() === m.toUpperCase()) title = title.slice(first.length).replace(/^\s+/, '');
          ctx.font = `700 ${fs * 0.78}px ${dc.font}`;
          const pw = ctx.measureText(m).width + 10 * cam.s * KB * 0.6 + 6, ph = fs * 1.15;
          ctx.fillStyle = mc || C.screen; dc.rr(x, cy - ph / 2, pw, ph, ph / 3); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(m, x + pw / 2, cy + 0.5);
          x += pw + 5 * cam.s * KB * 0.6 + 3; ctx.textAlign = 'left'; ctx.font = `700 ${fs}px ${dc.font}`;
        }
        ctx.fillStyle = isEntry ? C.screen : C.ink;
        ctx.fillText(dc.fit(title, R.x + R.w * 0.62 - x) || title, x, cy);
        ctx.textAlign = 'right'; ctx.fillStyle = C.muted; ctx.font = `500 ${fs * 0.78}px ${dc.font}`;
        const wd = dc.word(kind);   // an entry's header also says its description: 'Command  ·  Load products from a file' (cut to the room)
        ctx.fillText((isEntry && n.detail && dc.fit(wd + '  ·  ' + n.detail, R.w * 0.36)) || wd, R.x + R.w - 8 * s, cy, R.w * 0.36);
      }
    }
    ctx.restore();
    if (R.w >= 3) {
      n.kids.forEach(c => drawNode(dc, band, c, ox, oy));
      n.subs.forEach(c => drawNode(dc, band, c, ox, oy));
    }
    if (isEntry) dc.entryEnd(n.id, R, rad);
  }

  function draw(dc, band) {
    (band.tree || []).forEach(n => drawNode(dc, band, n, band.x, band.y));
  }

  window.C4PM_IO_BOXES = { families: ['command', 'route', 'tool'], measure, draw,
    // setPacker({ pack, mapAspect }): the core's packer (ioView.js calls it before layout()).
    setPacker(c) {
      if (!c || typeof c.pack !== 'function' || typeof c.mapAspect !== 'function') throw new Error('C4PM_IO_BOXES.setPacker: needs { pack, mapAspect } functions');
      core = c;
    } };
})();
