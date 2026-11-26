// storageView.js: the storage view's own renderer (STOR-6a, b339; look of Document/v0.7-three-views-demo.html VIEWS.storage).
// Zones (the containers that hold stores) > stores > record boxes with a header and one row per field, row-to-row FK arrows.
// The architecture engine is NOT used in storage mode: map.js draw() calls C4PM_STORAGEVIEW.draw. Camera, pointers, selection,
// mode switch and board stay the engine's. Loaded after ioView.js and BEFORE controls.js / map.js: layout() runs at script load.
//
// CONTRACT  window.C4PM_STORAGEVIEW = { layout, draw, hit, rect, bounds, hud, focus, arrows, setSample }   (c-item C4PM_STORAGEVIEW;
//           the seven renderer members of ioView.js:6-23, plus the test hook arrows and setSample, Phase 25 UI11)
//
//   layout()       idempotent; runs at script load. Needs C4PM_DATA.storageView (else it does nothing): root '(storage)' > container
//                  zones > store > record > field nodes (nested fields are a field's children). FIXED constants only (no canvas, no text
//                  measurement). Writes world x, y, w, h into every node (node.bubble = the same rect) BEFORE map.js loadTree caches
//                  origRects: root = bounds of the zones + 20 margin, zone / store / record = its box, field = its row (nested fields are
//                  flat rows below their parent, indented). A node of a kind the layout cannot place, or an edge whose end is no field
//                  row, throws with its id.
//   draw(map, C, now)   map = C4PM_STATE.map (ctx, cam, cw, ch, selectedId, hi), C = C4PM_RENDER.theme.readColors(). Draw order:
//                  zones, stores, FK arrows (below the boxes), records. Colours only from C (CSS tokens). Sets map.edgeLabels = [].
//                  Store and record titles never draw under TITLE_MIN_PX on screen (cut with an ellipsis to the box, RENDER.edges.fitText;
//                  the word beside them is left out while they are enlarged); field rows only from the zoom where their names are readable.
//                  A field row's name and type share the row: when both do not fit, the type is cut first (to no less than TYPE_KEEP),
//                  then the name, with ROW_GAP between them (RENDER.edges.fitText; b636).
//   hit(px, py)    screen point -> { id, entryId } | null. A field row (only when rows are readable: s * RH >= 8.46) gives
//                  { id: field, entryId: its record }; else a record, a store or a zone gives { id, entryId: null }.
//   rect(id)       world rect { x, y, w, h } (a copy) of the root, a zone, a store, a record or a field row; null when unknown.
//   bounds()       world rect of the root (rect('(storage)')), null before layout.
//   hud()          HUD text: node.word (else the kind word, C4PM_MODE.word) of focus(), else the words of the stores present joined ' · '.
//   focus()        { id, entryId: null } of the SMALLEST record or store rect that holds the view centre and fills
//                  sqrt((w * s / cw) * (h * s / ch)) >= 0.42 of the view (ioView.js focus rule); null when none.
//   arrows()       test hook: [{ from, to, label, x1, y1, x2, y2 }] in world units, one per storageView edge (label = the edge label,
//                  the FK's on delete, or null). (x1, y1) = the start dot on the from row, (x2, y2) = the arrow tip on the to row.
//   setSample(sizes)  Phase 25 UI11 (b761): sizes = { recordId: n } (the most sample rows any step of the selected s-item gives the
//                  record; sim.js sampleSizes) | null. Lays out again in place on the SAME nodes: a record with n > 0 grows by
//                  sampleH(n) = SHEAD + (n + 1) * SRH + 8 under its fields; the records below it move down. sim.js calls it on select
//                  and with null on clear.
//
// Simulation (UI11): map.sim (sim.js) computed for this view and no map.selectedId -> the records map.sim.ids names are lit (the
// selection look; map.hi still goes first); each gets an amber ring (BGLOW, 2.5, current step 4 + glow) and a step-number pill
// (teal C.flow / current amber with BGLOW_INK); while rows are readable a record with sample rows draws map.sim.tables[its id]
// under its fields (drawSample: label 'rows · step 5 · changed here' / '· unchanged' / '· as after step 5' / 'no rows yet · step 3',
// 'end of s-1' with no cursor; new row C.added + '+', changed cell C.changed + bold 'old→new').
//
// Selection: map.selectedId a record, a field or a store -> the record(s) it names plus every record joined to them by an FK edge are
// lit, the others dimmed; a selected field row is filled with C.accent at low alpha. Ids in map.hi (board selection) light their record
// (a record, one of its fields, or its store) too. Marks: record storage.origin 'code' -> dashed border (K8); 'plan' (not in code) ->
// header in C.muted; a field with storage.diff -> a C.findings bar on its left.
(function () {
  // Layout constants (world units), the demo's.
  const RW = 240, HH = 30, RH = 22, PAD = 4, COLGAP = 100, ROWGAP = 34, SPAD = 22, STITLE = 38, ZPAD = 30, ZTITLE = 46, ZGAP = 40;
  const MARGIN = 20;        // root bounds beyond the zones
  const INDENT = 16;        // a nested field row's name moves right by this per depth
  const TEXT_MIN = 5;       // text only when its font is at least this many px (the architecture header rule, render.js drawHeader)
  const ROWS_MIN = RH * TEXT_MIN / 13;   // = 8.46 px: rows (and their hits) only when the field names (13) are readable (b631)
  const TITLE_MIN_PX = 10;  // record and store titles never draw smaller than this on screen (b631)
  const TITLE_ROOM_MIN_PX = 28;   // ...and only when the box leaves at least this much room on screen
  const ROW_GAP = 8;        // world units between a field row's name and its type (b636)
  const TYPE_KEEP = 40;     // a cut type keeps at least this much room (a few characters + the ellipsis) before the name is cut (b636)
  const FOCUS_MIN = 0.42;   // ioView.js focus rule (geometric mean of the two view fractions)
  const SMALL_S = 0.45;     // under this zoom no arrow label
  // Phase 25 (UI11, b761): a record's sample-rows area (world units): label band SHEAD, then a head row and n rows of SRH
  const SRH = 17, SHEAD = 20;
  const sampleH = n => (n ? SHEAD + (n + 1) * SRH + 8 : 0);

  let laidOut = false;
  let SAMPLE = {};          // record id -> sample rows its card holds for the selected s-item (setSample)
  let rootId = null;
  const zones = [], stores = [], recs = [], links = [];
  const RECT = {};          // id -> world rect
  const NODE = {};          // id -> storageView node
  const recOf = {};         // record or field id -> its record entry
  const storeOf = {};       // store id -> its store entry
  const st = () => window.C4PM_STATE;   // created by state.js (loaded before this file); read at CALL time

  const need = (n, kind) => {
    if (n.kind !== kind) throw new Error('C4PM_STORAGEVIEW.layout: ' + JSON.stringify(n.id) + ' is a ' + JSON.stringify(n.kind) + ', the storage view places a ' + kind + ' here');
    return n;
  };
  // A record's fields, depth first: rows [{ node, d }]
  const flat = (fields, d, out) => {
    fields.forEach(f => { need(f, 'field'); out.push({ node: f, d }); flat(f.children || [], d + 1, out); });
    return out;
  };

  // Columns by FK direction (demo layoutStore): a record sits left of the records it references, so arrows flow right.
  function layoutStore(sr) {
    const own = links.filter(l => l.fromRec.store === sr && l.toRec.store === sr && l.fromRec !== l.toRec);
    const col = new Map(sr.recs.map(r => [r, 0]));
    for (let i = 0; i < sr.recs.length + 1; i++) own.forEach(l => {
      if (col.get(l.toRec) < col.get(l.fromRec) + 1) col.set(l.toRec, Math.min(col.get(l.fromRec) + 1, sr.recs.length));
    });
    // leaf records (nothing references them) sit right next to their targets, so arrows do not cross other records
    sr.recs.forEach(r => {
      const out = own.filter(l => l.fromRec === r), inn = own.some(l => l.toRec === r);
      if (out.length && !inn) col.set(r, Math.max(col.get(r), Math.min(...out.map(l => col.get(l.toRec))) - 1));
    });
    // FK cycles (a -> b -> a) push columns up to the cap and leave empty columns between: drop those, keeping the order
    const used = [...new Set(col.values())].sort((a, b) => a - b);
    const ncol = Math.max(1, used.length);
    const cols = Array.from({ length: ncol }, () => []);
    sr.recs.forEach(r => { r.col = used.indexOf(col.get(r)); cols[r.col].push(r); });
    // rows: columns from right to left, each sorted by the mean place of its targets
    const ypos = new Map(), colH = [];
    for (let c = ncol - 1; c >= 0; c--) {
      cols[c].forEach((r, i) => {
        const t = own.filter(l => l.fromRec === r && ypos.has(l.toRec)).map(l => ypos.get(l.toRec));
        r.k = t.length ? t.reduce((a, b) => a + b, 0) / t.length : i * 1000;
      });
      cols[c].sort((a, b) => a.k - b.k);
      let yy = 0;
      cols[c].forEach(r => { r.ry = yy; ypos.set(r, yy); yy += r.h + ROWGAP; });
      colH[c] = cols[c].length ? yy - ROWGAP : 0;
    }
    sr.cols = cols;
    sr.w = SPAD * 2 + ncol * RW + (ncol - 1) * COLGAP + 44;
    sr.h = STITLE + SPAD * 2 + Math.max(0, ...colH);
  }
  function layoutZone(z) {
    let x = 0;
    z.stores.forEach(s => { layoutStore(s); s.zx = x; x += s.w + ZGAP; });
    z.w = ZPAD * 2 + Math.max(0, x - ZGAP);
    z.h = ZTITLE + ZPAD * 2 + Math.max(0, ...z.stores.map(s => s.h));
  }
  function place(z) {
    z.stores.forEach(s => {
      s.x = z.x + ZPAD + s.zx; s.y = z.y + ZTITLE + ZPAD;
      s.cols.forEach((cl, c) => cl.forEach(r => {
        r.x = s.x + SPAD + c * (RW + COLGAP); r.y = s.y + STITLE + SPAD + r.ry;
        r.rows.forEach((row, i) => { row.x = r.x; row.y = r.y + HH + PAD + i * RH; });
      }));
    });
  }

  function layout() {
    if (laidOut) return;
    const D = window.C4PM_DATA;
    if (!D || !D.storageView || !D.storageView.root) return;
    const root = D.storageView.root;
    rootId = root.id;
    NODE[root.id] = root;
    const rowOf = {};
    (root.children || []).forEach(zn => {
      need(zn, 'container');
      const z = { node: zn, id: zn.id, x: 0, y: 0, w: 0, h: 0, stores: [] };
      zones.push(z); NODE[zn.id] = zn;
      (zn.children || []).forEach(sn => {
        need(sn, 'store');
        const s = { node: sn, id: sn.id, zone: z, x: 0, y: 0, w: 0, h: 0, recs: [] };
        z.stores.push(s); stores.push(s); storeOf[sn.id] = s; NODE[sn.id] = sn;
        (sn.children || []).forEach(rn => {
          need(rn, 'record');
          const r = { node: rn, id: rn.id, store: s, x: 0, y: 0, w: RW, h: 0, rows: [], col: 0 };
          flat(rn.children || [], 0, []).forEach(({ node, d }) => {
            const row = { node, id: node.id, d, rec: r, x: 0, y: 0, w: RW, h: RH };
            r.rows.push(row); rowOf[node.id] = row; recOf[node.id] = r; NODE[node.id] = node;
          });
          r.sample = SAMPLE[rn.id] || 0;   // UI11: sample rows of the selected s-item, under the fields
          r.h = HH + PAD * 2 + r.rows.length * RH + sampleH(r.sample);
          s.recs.push(r); recs.push(r); recOf[rn.id] = r; NODE[rn.id] = rn;
        });
      });
    });
    (D.storageView.edges || []).forEach(e => {
      const a = rowOf[e.from], b = rowOf[e.to];
      if (!a || !b) throw new Error('C4PM_STORAGEVIEW.layout: FK edge ' + JSON.stringify(e.from) + ' -> ' + JSON.stringify(e.to) + ' has an end that is no field row');
      links.push({ from: a, to: b, label: e.label === undefined ? null : e.label, fromRec: a.rec, toRec: b.rec });
    });
    zones.forEach(layoutZone);
    // the first zone on top, the others side by side below it (demo)
    let x = 0;
    zones.forEach((z, i) => {
      if (i === 0) { z.x = 0; z.y = 0; return; }
      z.x = x; z.y = zones[0].h + ZGAP; x += z.w + ZGAP;
    });
    zones.forEach(place);
    const all = [...zones, ...stores, ...recs];
    all.forEach(o => { RECT[o.id] = { x: o.x, y: o.y, w: o.w, h: o.h }; });
    recs.forEach(r => r.rows.forEach(row => { RECT[row.id] = { x: row.x, y: row.y, w: row.w, h: row.h }; }));
    if (zones.length) {
      const x0 = Math.min(...zones.map(z => z.x)), y0 = Math.min(...zones.map(z => z.y));
      const x1 = Math.max(...zones.map(z => z.x + z.w)), y1 = Math.max(...zones.map(z => z.y + z.h));
      RECT[root.id] = { x: x0 - MARGIN, y: y0 - MARGIN, w: x1 - x0 + 2 * MARGIN, h: y1 - y0 + 2 * MARGIN };
    } else {
      RECT[root.id] = { x: -MARGIN, y: -MARGIN, w: 2 * MARGIN, h: 2 * MARGIN };
    }
    Object.keys(RECT).forEach(id => {
      const n = NODE[id], r = RECT[id];
      n.x = r.x; n.y = r.y; n.w = r.w; n.h = r.h;
      n.bubble = { x: r.x, y: r.y, w: r.w, h: r.h };
    });
    laidOut = true;
    console.debug('[C4PM_STORAGEVIEW] layout', { zones: zones.length, stores: stores.length, records: recs.length, links: links.length, root: RECT[root.id] });
  }

  // UI11 (b761): the sample rows each record card holds for the selected s-item ({ recordId: n }, null = none). Lays the
  // view out again in place: the SAME data nodes get new x, y, w, h (map.js nodeById stays valid; origRects are not
  // touched: edit is off in renderer views). Before the first layout (no storage view yet) the sizes wait for it.
  function setSample(sizes) {
    SAMPLE = sizes || {};
    if (!laidOut) return;
    laidOut = false;
    rootId = null;
    [zones, stores, recs, links].forEach(a => { a.length = 0; });
    [RECT, NODE, recOf, storeOf].forEach(o => Object.keys(o).forEach(k => { delete o[k]; }));
    layout();
  }

  // Arrow geometry (world, demo route): bezier p0 (x1, y1), c1 (c1x, y1), c2 (c2x, y2), p3 (x2, y2).
  function route(l) {
    const A = l.fromRec, B = l.toRec, y1 = l.from.y + RH / 2, y2 = l.to.y + RH / 2;
    let x1, x2, d1, d2, k;
    if (A.x + RW > B.x - 4 && B.x + RW > A.x + 4) { x1 = A.x + RW; x2 = B.x + RW - 1; d1 = d2 = 1; k = 64 + (A === B ? 0 : 6); }
    else if (B.x > A.x) { x1 = A.x + RW; x2 = B.x + 1; d1 = 1; d2 = -1; k = Math.min(90, (x2 - x1) / 2); }
    else { x1 = A.x; x2 = B.x + RW - 1; d1 = -1; d2 = 1; k = Math.min(90, (x1 - x2) / 2); }
    return { x1, y1, x2, y2, c1x: x1 + d1 * k, c2x: x2 + d2 * k };
  }
  const bez = (r, t) => {
    const u = 1 - t;
    return { x: u * u * u * r.x1 + 3 * u * u * t * r.c1x + 3 * u * t * t * r.c2x + t * t * t * r.x2, y: (u * u * u + 3 * u * u * t) * r.y1 + (3 * u * t * t + t * t * t) * r.y2 };
  };

  // The records the selection names (a field's record, a record, a store's records), or null.
  function selRecs(sel) {
    if (!sel) return null;
    if (recOf[sel]) return new Set([recOf[sel]]);
    if (storeOf[sel]) return new Set(storeOf[sel].recs);
    return null;
  }
  // Lit records: the selected ones plus their FK neighbours, plus the records map.hi names; null = nothing dims.
  function litSet(sel, hi) {
    const named = selRecs(sel);
    let lit = null;
    if (named) {
      lit = new Set(named);
      links.forEach(l => { if (named.has(l.fromRec)) lit.add(l.toRec); if (named.has(l.toRec)) lit.add(l.fromRec); });
    }
    if (hi) {
      lit = lit || new Set();
      recs.forEach(r => { if (hi.has(r.id) || hi.has(r.store.id) || r.rows.some(row => hi.has(row.id))) lit.add(r); });
    }
    return lit;
  }

  const rrect = (ctx, x, y, w, h, r) => {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };

  function draw(map, C, now) {
    layout();
    if (!laidOut) return;
    const T = window.C4PM_RENDER.theme, ctx = map.ctx, { s, tx, ty } = map.cam, px = 1 / s, font = T.SANS;
    const sel = map.selectedId || null, named = selRecs(sel);
    // UI11 (b761): with nothing selected, the selected s-item (map.sim, sim.js, computed for this view) lights the records it names
    const sim = !sel && map.sim && map.sim.view === 'storage' ? map.sim : null;
    const lit = litSet(sel, map.hi || null) || (sim ? new Set(recs.filter(r => sim.ids.has(r.id))) : null);
    const headKey = window.C4PM_MODE.color('record');
    const head = headKey && C.vars[headKey];
    if (!head) throw new Error('C4PM_STORAGEVIEW.draw: no colour for the record kind (C4PM_MODE.color("record") = ' + JSON.stringify(headKey) + ')');
    const vx0 = -tx / s, vy0 = -ty / s, vx1 = (map.cw - tx) / s, vy1 = (map.ch - ty) / s;
    const vis = o => o.x < vx1 && o.x + o.w > vx0 && o.y < vy1 && o.y + o.h > vy0;
    const rows = s * RH >= ROWS_MIN;
    // text in world units; nothing when it would be under TEXT_MIN px
    const txt = (t, x, y, size, col, weight, align) => {
      if (size * s < TEXT_MIN) return;
      ctx.font = weight + ' ' + size + 'px ' + font; ctx.fillStyle = col;
      ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y);
    };
    // a store or record title: world size `size`, but never under TITLE_MIN_PX on screen; cut with an ellipsis to roomW (world);
    // nothing when the box leaves under TITLE_ROOM_MIN_PX on screen (b631)
    const titleFs = size => Math.max(size, TITLE_MIN_PX / s);
    const title = (t, x, y, size, col, weight, roomW) => {
      if (roomW * s < TITLE_ROOM_MIN_PX) return;
      ctx.font = weight + ' ' + titleFs(size) + 'px ' + font;
      const cut = window.C4PM_RENDER.edges.fitText(ctx, t, roomW);
      if (!cut) return;
      ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(cut, x, y);
    };
    // the world width of t in that font; 0 for no text or text under TEXT_MIN px (txt leaves it out)
    const width = (t, size, weight) => {
      if (!t || size * s < TEXT_MIN) return 0;
      ctx.font = weight + ' ' + size + 'px ' + font;
      return ctx.measureText(t).width;
    };
    // the room a title leaves for itself when a right-aligned word of `size` sits beside it; 0 when the word is left out
    const wordRoom = (word, size, weight) => { const w = width(word, size, weight); return w ? w + 12 : 0; };
    // a field row's name (left at x0, size 13) and type (right-aligned at x1, size 12) cut to share x1 - x0 with ROW_GAP between
    // them: the type gets what the whole name leaves, but no less than TYPE_KEEP; the name gets what the drawn type leaves (b636).
    // fitText (the one cutter) is called with the font of the text it cuts set on ctx by width().
    const rowFit = (name, nameWeight, type, x0, x1) => {
      const fit = window.C4PM_RENDER.edges.fitText, nameW = width(name, 13, nameWeight), fullT = width(type, 12, '400');
      const typeRoom = x1 - x0 - ROW_GAP - nameW;
      const t = !fullT ? '' : fullT <= typeRoom ? type : fit(ctx, type, Math.max(TYPE_KEEP, typeRoom));
      const typeW = width(t, 12, '400'), nameRoom = x1 - x0 - (typeW ? typeW + ROW_GAP : 0);
      const n = nameW <= nameRoom ? name : (width(name, 13, nameWeight), fit(ctx, name, nameRoom));
      return { name: n, type: t };
    };
    map.edgeLabels = [];
    ctx.save();
    ctx.translate(tx, ty); ctx.scale(s, s);

    // 1. zones and stores
    zones.forEach(z => {
      if (!vis(z)) return;
      rrect(ctx, z.x, z.y, z.w, z.h, 16);
      ctx.globalAlpha = 0.6; ctx.fillStyle = C.panel2; ctx.fill(); ctx.globalAlpha = 1;
      ctx.setLineDash([16 * px, 10 * px]); ctx.lineWidth = 1.5 * px; ctx.strokeStyle = C.line; ctx.stroke(); ctx.setLineDash([]);
      txt(z.node.name, z.x + ZPAD, z.y + ZTITLE / 2 + 4, 24, C.muted, '600');
      z.stores.forEach(sr => {
        if (!vis(sr)) return;
        rrect(ctx, sr.x, sr.y, sr.w, sr.h, 12);
        ctx.fillStyle = C.bp; ctx.fill(); ctx.lineWidth = 1.5 * px; ctx.strokeStyle = C.bpline; ctx.stroke();
        const sword = titleFs(17) > 17 ? null : sr.node.word;   // an enlarged title leaves no room for the word
        title(sr.node.name, sr.x + SPAD, sr.y + STITLE / 2 + 2, 17, C.ink, '600', sr.w - 2 * SPAD - wordRoom(sword, 13, '600'));
        if (sword) txt(sword, sr.x + sr.w - SPAD, sr.y + STITLE / 2 + 2, 13, C.muted, '600', 'right');
      });
    });

    // 2. FK arrows, below the records
    links.forEach(l => {
      const r = route(l), touch = !!named && (named.has(l.fromRec) || named.has(l.toRec));
      const fieldSel = touch && (sel === l.from.id || sel === l.to.id);
      ctx.globalAlpha = lit && !touch ? 0.12 : 1;
      ctx.strokeStyle = ctx.fillStyle = touch ? C.accent : C.edge;
      ctx.lineWidth = (fieldSel ? 3 : touch ? 2.2 : 1.5) * Math.max(1, px * 1.2);
      ctx.beginPath(); ctx.moveTo(r.x1, r.y1); ctx.bezierCurveTo(r.c1x, r.y1, r.c2x, r.y2, r.x2, r.y2); ctx.stroke();
      const dir = r.x2 >= r.c2x ? 1 : -1, hl = 10, hw = 4.5;
      ctx.beginPath(); ctx.moveTo(r.x2, r.y2); ctx.lineTo(r.x2 - dir * hl, r.y2 - hw); ctx.lineTo(r.x2 - dir * hl, r.y2 + hw); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(r.x1, r.y1, 2.6, 0, Math.PI * 2); ctx.fill();
      if (l.label === 'cascade' && s >= SMALL_S) {
        const m = bez(r, 0.5), w = 52, col = ctx.strokeStyle;
        rrect(ctx, m.x - w / 2, m.y - 8, w, 16, 8); ctx.fillStyle = C.panel; ctx.fill(); ctx.lineWidth = px; ctx.stroke();
        txt(l.label, m.x, m.y + 0.5, 10.5, col, '500', 'center');
      }
      ctx.globalAlpha = 1;
    });

    // 3. records: box, header, rows
    recs.forEach(rc => {
      if (!vis(rc)) return;
      const n = rc.node, origin = n.storage && n.storage.origin, on = !lit || lit.has(rc), isSel = !!named && named.has(rc);
      const alpha = on ? 1 : 0.28;
      ctx.globalAlpha = alpha;
      rrect(ctx, rc.x, rc.y, rc.w, rc.h, 8); ctx.fillStyle = C.panel; ctx.fill();
      ctx.save(); rrect(ctx, rc.x, rc.y, rc.w, rc.h, 8); ctx.clip();
      // while rows are off, the header band grows to hold an enlarged title (its ink is for the band, not the white body) (b631)
      const hh = rows ? HH : Math.min(rc.h, Math.max(HH, titleFs(15) * 1.3));
      ctx.fillStyle = origin === 'plan' ? C.muted : head; ctx.fillRect(rc.x, rc.y, rc.w, hh);
      const ink = origin === 'plan' ? C.panel : C.c3ink;
      const rword = titleFs(15) > 15 ? null : n.word;   // an enlarged title leaves no room for the word
      title(n.name, rc.x + 12, rc.y + hh / 2 + 0.5, 15, ink, '600', rc.w - 24 - wordRoom(rword, 11, '500'));
      if (rword) { ctx.globalAlpha = alpha * 0.8; txt(rword, rc.x + rc.w - 12, rc.y + HH / 2 + 0.5, 11, ink, '500', 'right'); ctx.globalAlpha = alpha; }
      if (rows) rc.rows.forEach((row, i) => {
        const f = row.node, fs = f.storage || {}, y = row.y, cy = y + RH / 2 + 0.5, nested = !!(f.children && f.children.length);
        if (sel === row.id) { ctx.globalAlpha = alpha * 0.25; ctx.fillStyle = C.accent; ctx.fillRect(rc.x, y, rc.w, RH); ctx.globalAlpha = alpha; }
        else if (i % 2) { ctx.globalAlpha = alpha * 0.7; ctx.fillStyle = C.panel2; ctx.fillRect(rc.x, y, rc.w, RH); ctx.globalAlpha = alpha; }
        if (fs.diff && fs.diff.length) { ctx.fillStyle = C.findings; ctx.fillRect(rc.x, y, 4, RH); }
        if (fs.pk || fs.fk) {
          rrect(ctx, rc.x + 8, y + 4, 22, RH - 8, 3); ctx.fillStyle = fs.pk ? C.drift_grew : C.accent; ctx.fill();
          txt(fs.pk ? 'PK' : 'FK', rc.x + 19, cy, 9, fs.pk ? C.c3ink : C.panel, '700', 'center');
        }
        if (nested) txt('▾', rc.x + 24 + row.d * INDENT, cy, 10, C.muted, '400', 'center');
        const nx = rc.x + 36 + row.d * INDENT, tr = rc.x + rc.w - (fs.nullable ? 30 : 12), nw = nested ? '600' : '400';
        const cut = rowFit(f.name, nw, f.meta && f.meta.type, nx, tr);
        if (cut.name) txt(cut.name, nx, cy, 13, C.ink, nw);
        if (cut.type) txt(cut.type, tr, cy, 12, C.muted, '400', 'right');
        if (fs.nullable) txt('?', rc.x + rc.w - 14, cy, 13, C.muted, '700', 'center');
      });
      if (rows && sim && rc.sample) drawSample(ctx, rc, (sim.tables || {})[rc.id], sim, C, txt);
      ctx.restore();
      // border on top of the header: dashed for a record only the code has (K8), accent when lit by a selection
      ctx.globalAlpha = alpha;
      rrect(ctx, rc.x, rc.y, rc.w, rc.h, 8);
      ctx.setLineDash(origin === 'code' ? [6 * px, 4 * px] : []);
      ctx.lineWidth = (isSel ? 3 : on && lit ? 2 : 1.2) * Math.max(1, px * 1.2);
      ctx.strokeStyle = on && lit ? C.accent : C.line; ctx.stroke();
      ctx.setLineDash([]);
      // UI11 (demo): a record the s-item names gets an amber ring (thicker with a glow on the current step) and a pill with its
      // step numbers on the ring's top-left (amber on the current step, else teal); pill sizes in world units, never under 11.5 px
      const se = sim && sim.ids.get(rc.id);
      if (se) {
        ctx.save();
        ctx.lineWidth = (se.cur ? 4 : 2.5) * Math.max(1, px); ctx.strokeStyle = T.BGLOW;
        if (se.cur) { ctx.shadowColor = T.BGLOW; ctx.shadowBlur = 12; }
        rrect(ctx, rc.x - 6, rc.y - 6, rc.w + 12, rc.h + 12, 12); ctx.stroke();
        ctx.restore();
        const t = se.ns.slice().sort((a, b) => a - b).join(' · '), pfs = Math.max(11, 11.5 * px), ph = pfs * 1.75;
        ctx.font = '700 ' + pfs + 'px ' + T.MONO;
        const pw = Math.max(ph, ctx.measureText(t).width + pfs);
        rrect(ctx, rc.x, rc.y - 6 - ph / 2, pw, ph, ph / 2); ctx.fillStyle = se.cur ? T.BGLOW : C.flow; ctx.fill();
        ctx.fillStyle = se.cur ? T.BGLOW_INK : C.panel; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t, rc.x + pw / 2, rc.y - 6 + 0.5);
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  // UI11 (b761, demo drawSample): the selected s-item's sample rows inside a record card, under its fields (called inside the
  // card's clip, world units). st = map.sim.tables[record id] (sim.js tableStateAt), undefined = no rows yet at this step.
  // A C.panel2 band with a C.flow top line; the label (C.flow when the rows changed at this step, else C.muted); column heads;
  // the rows in mono, each value cut to its cell. A new row: C.added tint and '+'; a changed cell: C.changed tint, bold 'old→new'.
  // txt = draw's text helper (sans, nothing under TEXT_MIN px).
  function drawSample(ctx, rc, st, sim, C, txt) {
    const MONO = window.C4PM_RENDER.theme.MONO, SIM = window.C4PM_SIM, a = ctx.globalAlpha;
    const y0 = rc.y + HH + PAD + rc.rows.length * RH + 4, x0 = rc.x + 8, w = rc.w - 16;
    ctx.fillStyle = C.panel2; ctx.fillRect(rc.x, y0 - 4, rc.w, sampleH(rc.sample) + 4);
    ctx.strokeStyle = C.flow; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rc.x, y0 - 4); ctx.lineTo(rc.x + rc.w, y0 - 4); ctx.stroke();
    // b853 S3b: a page object from sim.js with a depth numbers by flow step (flowStep; SIM.flowIndex for "as after") and
    // compares with tablesAt (the flow step's last original index); without those keys (an older map.sim) as before.
    const known = v => v !== null && v !== undefined;
    const end = !known(sim.step);
    const stepTxt = end ? 'end of ' + sim.id : 'step ' + ((known(sim.flowStep) ? sim.flowStep : sim.step) + 1);
    const curI = known(sim.tablesAt) ? sim.tablesAt : end ? (SIM ? SIM.steps(sim.id).length - 1 : -1) : sim.step;
    const afterN = at => { const k = known(sim.depth) && SIM && SIM.flowIndex ? SIM.flowIndex(at) : null; return (known(k) ? k : at) + 1; };
    const lab = st ? 'rows · ' + stepTxt + (st.touched ? ' · changed here' : st.at === curI ? ' · unchanged' : ' · as after step ' + afterN(st.at))
      : 'no rows yet · ' + stepTxt;
    txt(lab, x0, y0 + SHEAD / 2 - 2, 10.5, st && st.touched ? C.flow : C.muted, '600');
    if (!st || !st.cols.length) return;
    const cw = w / st.cols.length, yh = y0 + SHEAD;
    const val = v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
    st.cols.forEach((c, k) => txt(c, x0 + k * cw + 3, yh + SRH / 2, 9.5, C.muted, '600'));
    st.rows.forEach((r, i) => {
      const y = yh + (i + 1) * SRH;
      if (r.ins) {
        ctx.globalAlpha = a * 0.22; ctx.fillStyle = C.added; ctx.fillRect(x0 - 4, y, w + 8, SRH); ctx.globalAlpha = a;
        txt('+', x0 - 2, y + SRH / 2, 11, C.added, '600');
      }
      st.cols.forEach((c, k) => {
        const chg = Object.prototype.hasOwnProperty.call(r.old, c), x = x0 + k * cw;
        if (chg) { ctx.globalAlpha = a * 0.4; ctx.fillStyle = C.changed; ctx.fillRect(x, y + 1, cw - 2, SRH - 2); ctx.globalAlpha = a; }
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, cw - 2, SRH); ctx.clip();
        ctx.font = (chg ? '700 ' : '400 ') + '10.5px ' + MONO; ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(chg ? val(r.old[c]) + '→' + val(r.vals[c]) : val(r.vals[c]), x + (r.ins && k === 0 ? 8 : 3), y + SRH / 2 + 0.5);
        ctx.restore();
      });
    });
  }

  // ---- queries
  function hit(px, py) {
    if (!laidOut) return null;
    const cam = st().map.cam, wx = (px - cam.tx) / cam.s, wy = (py - cam.ty) / cam.s;
    const inside = o => wx >= o.x && wx <= o.x + o.w && wy >= o.y && wy <= o.y + o.h;
    for (const rc of recs) if (inside(rc)) {
      if (cam.s * RH >= ROWS_MIN) for (const row of rc.rows) if (inside(row)) return { id: row.id, entryId: rc.id };
      return { id: rc.id, entryId: null };
    }
    for (const sr of stores) if (inside(sr)) return { id: sr.id, entryId: null };
    for (const z of zones) if (inside(z)) return { id: z.id, entryId: null };
    return null;
  }
  const rect = id => (RECT[id] ? { x: RECT[id].x, y: RECT[id].y, w: RECT[id].w, h: RECT[id].h } : null);
  const bounds = () => (rootId === null ? null : rect(rootId));

  function focus() {
    const map = st().map;
    if (!laidOut || !map.cam) return null;
    const { s, tx, ty } = map.cam, wx = (map.cw / 2 - tx) / s, wy = (map.ch / 2 - ty) / s;
    let best = null, bestA = Infinity;
    [...recs, ...stores].forEach(o => {
      if (wx < o.x || wx > o.x + o.w || wy < o.y || wy > o.y + o.h) return;
      const area = o.w * o.h;
      if (Math.sqrt((o.w * s / map.cw) * (o.h * s / map.ch)) >= FOCUS_MIN && area < bestA) { best = o.id; bestA = area; }
    });
    return best ? { id: best, entryId: null } : null;
  }

  const wordOf = n => n.word || window.C4PM_MODE.word(n.kind) || n.kind;
  function hud() {
    const f = focus();
    if (f) return wordOf(NODE[f.id]);
    const words = [];
    stores.forEach(sr => { const w = wordOf(sr.node); if (words.indexOf(w) < 0) words.push(w); });
    return words.join(' · ');
  }

  function arrows() {
    layout();
    return links.map(l => {
      const r = route(l);
      return { from: l.from.id, to: l.to.id, label: l.label, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 };
    });
  }

  window.C4PM_STORAGEVIEW = { layout, draw, hit, rect, bounds, hud, focus, arrows, setSample };
  layout();

  // The storage view in the view registry (mode.js C4PM_VIEWS). chips = the header chips, color = the HUD chip colour.
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  window.C4PM_MODE.registerView('storage', {
    label: 'Storage view',
    short: 'Storage',
    tree: d => (d.storageView ? { root: d.storageView.root, edges: d.storageView.edges } : null),
    renderer: () => window.C4PM_STORAGEVIEW,
    chips: d => {
      const n = { store: 0, record: 0 };
      (function walk(x) { if (x.kind in n) n[x.kind]++; (x.children || []).forEach(walk); })(d.storageView.root);
      return plural(n.store, 'store') + ' · ' + plural(n.record, 'record') + ' · ' + plural(d.storageView.edges.length, 'link');
    },
    color: 'c2',
  });

  // Phase 30 SV9b (b642): the view-state part 'storage' = { id, rec }: the selected record, store or field (id) and the record it
  // belongs to (rec, null for a store or zone). The selection part of viewState.js brings the id back; when that id is gone (a
  // renamed field, a changed tree) and nothing is selected, the record is selected instead, when it is still laid out. The value
  // stays kept while another view is shown. viewState.js loads after this file, so the part is added at DOMContentLoaded (or on
  // the next timer in a loaded page).
  let keptSel = null;
  const own = (o, id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(o, id);
  const storagePart = {
    get: () => {
      if (!window.C4PM_MODE || window.C4PM_MODE.get() !== 'storage') return keptSel || undefined;
      const id = st().map.selectedId || null;
      keptSel = id && own(RECT, id) ? { id, rec: own(recOf, id) ? recOf[id].id : null } : null;
      return keptSel || undefined;
    },
    set: v => {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string') return;
      keptSel = { id: v.id, rec: typeof v.rec === 'string' ? v.rec : null };
      const MAP = window.C4PM_MAP;
      if (window.C4PM_MODE.get() !== 'storage' || !MAP || MAP.selectedId()) return;   // another view, or the selection part restored one
      const id = own(RECT, v.id) ? v.id : own(RECT, keptSel.rec) ? keptSel.rec : null;
      if (id && MAP.nodeById(id)) MAP.select(id);
    },
  };
  // C4PM_STATE.whenReady (state.js): a page without state.js has no viewState.js either.
  if (st()) st().whenReady(() => { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.part('storage', storagePart); });
})();
