// ioView.js: the IO view's own renderer (the way demo 6 / demo 7 draw it). The architecture engine (regions / edges / beans of
// render.js) is NOT used in io mode: map.js draw() calls C4PM_IOVIEW.draw instead. Camera, pointers, selection, panel, tree, search,
// mode switch, link and board stay the engine's. Loaded after render.js and BEFORE controls.js, and after its two family modules
// (ioScreens.js, ioBoxes.js), because layout() runs once at script load (see "Layout timing").
//
// CONTRACT  window.C4PM_IOVIEW = { layout, draw, hit, rect, bounds, hud, focus, familyWord, FAMILY_WORD, pack, wireOf, placed }   (FROZEN after step 2;
//           wireOf, placed added by W11, b307)
//
//   layout()       idempotent; runs at script load. Needs C4PM_DATA.nav and C4PM_DATA.navView (else it does nothing). Uses FIXED
//                  constants only (no canvas, no text measurement). Writes world rects into the navView nodes (root '(io)' = bounds of
//                  all frames + 60 margin, container node = its frame, entry node = its rect; node.bubble = the same rect) BEFORE
//                  map.js loadTree caches origRects. Everything is laid out once; there is no per-frame layout.
//                  W11 (b307, C6): before the bands, ONE call C4PM_IO_WIREFRAME.measureAll(items, C4PM_DATA.wireframeRules) measures every
//                  screen with entry.wireframe.html and a navView io.viewport (items = [{ fqn, html, viewport: { w, h } }]; no call when there
//                  is none). No measurer or no rules: console.debug, nothing measured, those screens are 'not-drawn' with that reason.
//   draw(map, C, now)   map = C4PM_STATE.map (ctx, cam, cw, ch, selectedId, hi), C = C4PM_RENDER.theme.readColors(), now = rAF ms.
//                  Builds dc, draws frames, band headers, the family modules, then the cross-band arrows. Replaces map.edgeLabels
//                  with dc.labels. The dot grid and the background are drawn by map.js before.
//   hit(px, py)    screen point -> { id, entryId } | null. Scans the hits of the LAST draw from the end (topmost first). id = what was
//                  hit (root '(io)', a frame = group fqn, an entry fqn, a part fqn); entryId = the entry that holds it (the entry itself
//                  for an entry; null for root / frame). camera.hitTest returns nodeById[entryId || id].
//   rect(id)       world rect { x, y, w, h } (a copy) of the root, a frame, an entry or a part; null when unknown. A part of a screen drawn
//                  from its wireframe: the union of its boxes (C9); a region / control with no box there: its screen's rect (the part's
//                  navView node holds the same rect).
//   wireOf(screenFqn)  the wireframe of a screen: { state, reason?, viewport? } | null (null for anything that is not a screen).
//                  state: 'none' (no wireframe file) | 'error' (the server could not use the file; reason = entry.wireframe.error) |
//                  'not-drawn' (not measured, or measureAll said ok:false; reason = why) | 'out-of-date' (drawn, but a region / control
//                  has no box or a ref has a problem; reason lists them) | 'ok'. viewport = the navView io.viewport { w, h, source } when known.
//   placed(partFqn)    { boxes: number, hidden: boolean } for a part drawn from a wireframe box (boxes = how many; hidden = every box of it
//                  is hidden, H6); null when the part has no box or its screen is not drawn from a wireframe.
//   bounds()       world rect of the root (the same as rect('(io)')), null before layout.
//   hud()          HUD text: the kind word (C4PM_MODE.word) of focus(), else the words of the entry kinds present joined ' · '
//                  (family order: screen, command, route, tool).
//   focus()        { id, entryId } of the SMALLEST entry or part rect that holds the view centre and fills
//                  sqrt((w * s / cw) * (h * s / ch)) >= 0.42 of the view (demo 7 focusItem, geometric mean); null when none.
//   familyWord(group, family)  the app word: FAMILY_WORD[family] when group.word is the default 'App', else group.word.
//   pack(items, opts)  THE packer of the IO view (also used by ioBoxes.js). items = [{ w, h }] in order, opts = { gap = 90, aspect = 1.6, extra = { w, h } }.
//                  Skyline (bottom-left) packing: each item, in order, goes to the lowest place where it fits under a width W; W is tried among
//                  the sums of runs of neighbouring widths; the best has |log(w / h / aspect)| + 1.5 * (1 - fill) smallest (tie: smaller area).
//                  Row rule: 2..4 boxes of about equal size stand in one row when its aspect is within a factor 12 / n of the target.
//                  opts.extra / opts.minW count in the aspect only. Measure-only (no ctx). -> { w, h, k, pos: [{ x, y }] }.
//   FAMILY_WORD    { screen: 'App', command: 'CLI', route: 'API', tool: 'MCP' }  (the one place of this map)
//
// Structure: one FRAME per nav group (always open, never a closed bubble). Inside a frame one BAND per entry family present, in the order
// screen, command, route, tool. One family: no band box, the frame is the app. Several families: each band is a sub-frame with a header
// "<app word> · <n> <kind words>" (n counts every entry of the family, subcommands included). Bands inside a frame and frames inside the
// root are placed by pack() (aspect 1.6, gap 90, padding 40 inside a frame below its header). In a frame with several bands the screens band has
// its own first row and the other bands are packed below it. b607: that row is scaled up (band.scale = k, the same k for x, y, w, h) so it
// spans the full width of the bands below, but never gets taller than they are: k = max(1, min((W - 2 * 20) / w, (H - band head - 20) / h)),
// W x H = the packed block of the other bands, w x h = the screens band; the row is centred. Header heights grow with the size of the whole
// view (max(44, 4.5% of the root row limit)) so a header stays about 14 px at Fit. Frame and band header texts move right past the HUD pill
// (#hud-tl) when it would cover them.
//
// FAMILY MODULE CONTRACT  (window.C4PM_IO_SCREENS for 'screen', window.C4PM_IO_BOXES for 'command' | 'route' | 'tool')
//   module = { families: string[], measure(band), draw(dc, band) }   (C4PM_IO_SCREENS also has geom, WORLD_PER_PX, TB: see ioScreens.js)
//   families       the entry kinds the module draws; the core picks the module whose `families` holds the band's family.
//   measure(band)  called once by layout(). Sets band.w, band.h (world units of the CONTENT, the band's own padding included) and
//                  band.local = { id: { x, y, w, h } } relative to the content origin, for EVERY entry and EVERY part (region, control,
//                  option group, flag, param ...) the module draws and wants to be hit. A subcommand's rect lies inside its parent's.
//                  No ctx, no text measurement, no reads of the viewer state: fixed constants and `band` only.
//   draw(dc, band) called every frame for a band whose outer rect is on screen. band.x / band.y = world origin of the content (the
//                  core sets them in layout(); a world point is band.x + local.x). Draws with dc only. b607: a band with band.scale = k
//                  (the screens row) lies at band.x + k * local.x in the world; its dc has a camera that already holds k (dc.cam.s, dc.toPx),
//                  so the module draws exactly as for k = 1.
//
//   band = {
//     family   string   the entry kind of this band ('screen' | 'command' | 'route' | 'tool')
//     group    NavGroup the nav group (frame) it belongs to: { fqn, title, technology, word, entries }
//     entries  NavEntry[]  EVERY entry of this family in the group, declaration order, subcommands included
//                          (NavEntry = { kind, fqn, uid, title, status, rank, order, parent, parts[], metadata? }; parent = fqn of the
//                          entry that holds it, null for a top-level entry; a module draws a subcommand INSIDE its parent's box)
//     io       object   { entryFqn: io } the navView io of every entry of the band ({ kind, device?, method?, design?, rows[] }, see dc.rows);
//                          the core fills it before measure, a module reads it here and never C4PM_DATA
//     edges    NavEdge[]   nav edges with BOTH ends in this band, self edges dropped ({ from, to, label, via, labelled?, ... })
//     word     string   the app word of the band (familyWord(group, family))
//     w, h     number   set by measure
//     local    object   set by measure
//     x, y     number   set by the core (world origin of the content), valid in draw only
//     wire     object   screen band only (W11): { screenFqn: measureAll result } for the screens that were measured:
//                          { ok: true, viewport: { w, h }, boxes: [{ ref, x, y, w, h, hidden, order }] } | { ok: false, reason, reasons }
//                          (viewport px; ref -> fqn only through entry.wireframe.refs, C1). The core sets it before measure.
//     mark     object   screen band only (W11): { screenFqn: 'none' | 'error' | 'not-drawn' | 'out-of-date' } the title-row badge (wireOf's
//                          state; 'none' only when some screen of the page has a wireframe, Q12 / K2; no key = no badge)
//     boxes    object   set by the screens module's measure (W11): { partFqn: [{ x, y, w, h, hidden }] } band-local, one per wireframe box
//   }
//
//   dc = {
//     ctx, cam { s, tx, ty }, cw, ch, now,
//     C            colours = RENDER.theme.readColors(): ink, muted, line, panel, panel2, accent, edge, screen, screenSoft, screenLine,
//                  control, method { GET, POST, PUT, PATCH, DELETE }, ... (all from CSS variables)
//     sel          selected id (an entry fqn, a frame fqn, or '(io)') or null
//     hi           Set of lit ids (map.hi, board / link highlight) or null. UI9 (b759, K 2026-11-15): with map.hi null and an s-item
//                  selected (map.sim, sim.js, view 'io'): the lit io ids of map.sim.ids plus the entries that hold them (and a lit
//                  subcommand's parent entries), so every other entry fades to 0.3 (entryBegin). An s-item that lights nothing
//                  in the io view fades nothing (hi stays map.hi)
//     ring        Set of the ids that get the amber mark (entryEnd's ring, a control's amber stroke): map.hi only, or null. The
//                  sim-lit ids get none here: sim-map.js drawSimIo draws their rings (one ring per target, the look of the demo)
//     simOn        true while the selected s-item lights something in the io view (map.sim with lit ids): the navigation arrows
//                  that do not glow dim to 0.16 (drawCross, ioScreens drawNav), as with a selection; false when it lights nothing
//     status       RENDER.theme.STATUS { key: [label, fg, bg] }
//     font         RENDER.theme.SANS (the font family string; set ctx.font = `500 ${px}px ${dc.font}`)
//     glow         { out, in, hi, arrow }  GLOW_OUT cyan, GLOW_IN magenta, BGLOW amber, ARROW head length in px
//     rr(x, y, w, h, r)        rounded-rect path (screen px), like render.js rr
//     toPx(worldRect)          -> screen rect { x, y, w, h }
//     offScreen(R)             true when a screen rect is fully outside the canvas
//     word(kind), tag(kind)    C4PM_MODE.word / tag of the io view, falling back to the kind
//     fit(text, maxW)          text cut with an ellipsis to measure <= maxW with the CURRENT ctx.font; '' when maxW < 36 (RENDER.edges.fitText)
//     rows(entryId)            the entry's navView node .io = { kind, device?, method?, design?, rows[] } (undefined for an unknown id);
//                              rows = flat, depth-first: { id, kind, title, status?, depth, word?, meta? { in, type, required }, nav? { to, label? } }
//                              (nest by depth; do not recompute; device = 'web' | 'phone' for a screen; method for a route)
//     statusOf(id)             status string ('planned' | 'in-progress' | 'done' ...) of an entry or part, or null
//     dash(id)                 [5, 3] when statusOf(id) is 'planned', else []  (ctx.setLineDash(dc.dash(id)) before the frame stroke; reset it after)
//     entryBegin(id)           ctx.save(); with dc.hi set, an entry not in it draws at alpha 0.3 (multiplied into ctx.globalAlpha)
//     entryEnd(id, R, rad)     draws, on the entry's screen rect R (corner radius rad px): an amber ring (BGLOW, width 3) when dc.ring holds id,
//                              a small dot in the status colour at the top right for a status other than 'planned'; then ctx.restore().
//                              Call entryBegin / entryEnd around the whole drawing of every entry (also of a subcommand inside its parent).
//     hits         array; push { id, R } (R = screen rect) for every entry / part / box that is a click target, in draw order (later =
//                  on top). Never mutate or reuse a pushed object. Only entries and parts that are drawn (not culled) need one.
//     labels       array; push { x, y, w, h, full } (screen rect of an edge label that was cut with an ellipsis, full = the whole text);
//                  the core hands it to map.edgeLabels (controls.js shows `full` as the hover title)
//     label(o)             draws an edge label pill (the ONE rule for every arrow label). o = { x, y, chord, text, col, alpha, clip, avoid?, avoidPaths?, along? }: (x, y) the middle
//                          of the curve in px, chord = its straight length in px, col = pill border, clip = screen rect the pill must stay in (or
//                          undefined). Max width = min(220, 0.9 * chord, clip.w); under 36 px nothing is drawn (zooming in brings it back); the pill (text + 12) is never wider than that max (dc.fit gives no text
//                          under 36 px, so in effect a chord under about 53 px draws nothing). A cut
//                          text is pushed to dc.labels by label itself. avoid = screen rects the pill must not cover (the screen frames),
//                          avoidPaths = paths it must not cover either (b607: the other arrows, cubic segments [p0, c, c, p1, ...] in px), along =
//                          its own path: when the pill at (x, y) would cover one, it moves to the nearest free place on `along` (full width);
//                          with none it shrinks to the free room on its row, or is skipped under 36 px. A module draws every arrow first,
//                          then the labels.
//     cover        screen rects of the HUD boxes over the map (b607: the level pill); header texts move right past them
//   }
//   A module reads nothing from ioCard.js. Colours only from dc.C (CSS variables). Text only when the font is >= 5 px; boxes always.
//
// Engine seams that call into this file (the only edits outside the new files): map.js draw() (draw), camera.js hitTest / maxS / focusNode
// (hit, focus), controls.js updateHud (hud) and dblclick (hit + rect), map.js flyTo / controls dblclick skip lockDepth in io.
(function () {
  const FAMILY_ORDER = ['screen', 'command', 'route', 'tool'];
  const FAMILY_WORD = { screen: 'App', command: 'CLI', route: 'API', tool: 'MCP' };
  const DEFAULT_WORD = 'App';

  // Layout constants (world units)
  const GAP = 90;          // between items and between shelf rows
  const PAD = 40;          // inside a frame, below its header and at the sides
  const BP = 20;           // inside a band sub-frame, at the sides and the bottom
  const HEAD_MIN = 44;     // frame header height at least
  const HEAD_FRAC = 0.045;  // ... and this fraction of the root row limit
  const BAND_HEAD_MIN = 30;
  const MARGIN = 60;       // root bounds beyond the frames
  const FOCUS_MIN = 0.42;   // demo 7 focusItem: the geometric mean of the two view fractions (a wide thin row does not count as big)

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let laidOut = false;
  let frames = [];         // { group, id, rect, head, multi, bands: [{ band, outer: world rect }] }
  let root = null;         // world rect of the root
  const RECT = {};         // id -> world rect (root, frames, entries, parts)
  const IDX = { entryOf: {}, kindOf: {}, statusOf: {}, node: {}, entry: {} };   // built once from nav / navView (entry: fqn -> NavEntry)
  let WIRE = {};           // W11 (b307): screen fqn -> measureAll result, only the screens that were measured (once, in layout)
  let wireGap = null;      // why nothing was measured (no measurer / no rules); null otherwise
  const WINFO = {};        // screen fqn -> the wireOf answer, built once in layout
  const BAND_OF = {};      // entry fqn -> band
  const frameOf = {};      // entry fqn -> its frame
  let cross = [];          // nav edges whose ends sit in different bands: [{ from, to, label }]
  let lastHits = [];
  const modules = () => [window.C4PM_IO_SCREENS, window.C4PM_IO_BOXES].filter(Boolean);
  const moduleOf = family => modules().find(m => Array.isArray(m.families) && m.families.indexOf(family) >= 0) || null;
  const familyWord = (group, family) => (group.word && group.word !== DEFAULT_WORD ? group.word : (FAMILY_WORD[family] || group.word || DEFAULT_WORD));
  const st = () => window.C4PM_STATE;   // created by state.js (loaded before this file); read at CALL time
  const modeWord = kind => (window.C4PM_MODE && window.C4PM_MODE.word(kind)) || kind;

  // ---- index of ids (entries, parts) -> owner entry, kind, status
  function index(nav, navView) {
    (function walk(n) { IDX.node[n.id] = n; (n.children || []).forEach(walk); })(navView.root);
    const part = (p, entry) => {
      IDX.entryOf[p.fqn] = entry; IDX.kindOf[p.fqn] = p.kind; IDX.statusOf[p.fqn] = p.status || null;
      p.parts.forEach(c => part(c, entry));
    };
    nav.groups.forEach(g => g.entries.forEach(e => {
      IDX.entryOf[e.fqn] = e.fqn; IDX.kindOf[e.fqn] = e.kind; IDX.statusOf[e.fqn] = e.status || null; IDX.entry[e.fqn] = e;
      e.parts.forEach(p => part(p, e.fqn));
    }));
  }

  // ---- W11 (b307, W12): the wireframes of all screens, measured ONCE (C6) before any band, and the wireOf answer of every screen.
  // A measuring problem is a reason on that screen only (C8): it is never caught here, measureAll reports it per screen.
  function measureWire(D, nav) {
    const items = [];
    nav.groups.forEach(g => g.entries.forEach(e => {
      const io = IDX.node[e.fqn] && IDX.node[e.fqn].io;
      if (e.kind === 'screen' && e.wireframe && e.wireframe.html !== undefined && io && io.viewport) items.push({ fqn: e.fqn, html: e.wireframe.html, viewport: { w: io.viewport.w, h: io.viewport.h } });
    }));
    if (!items.length) return;
    const M = window.C4PM_IO_WIREFRAME;
    if (!M || typeof M.measureAll !== 'function') wireGap = 'no wireframe measurer (C4PM_IO_WIREFRAME is missing)';
    else if (!D.wireframeRules) wireGap = 'no wireframe rules (C4PM_DATA.wireframeRules is missing)';
    if (wireGap) { console.debug('[C4PM_IOVIEW] wireframes not measured:', wireGap); return; }
    WIRE = M.measureAll(items, D.wireframeRules);
  }
  // Why a drawn wireframe is out of date: regions / controls with no box, refs that name nothing or two things. '' when none.
  function outOfDate(wf) {
    const ref = p => wf.refs.filter(r => r.problem === p).map(r => r.ref);
    return [['not placed', wf.missing], ['unknown ref', ref('unknown')], ['ambiguous ref', ref('ambiguous')]]
      .filter(([, l]) => l.length).map(([w, l]) => w + ': ' + l.join(', ')).join('; ');
  }
  function wireInfo(e) {
    const wf = e.wireframe, res = WIRE[e.fqn], io = IDX.node[e.fqn] && IDX.node[e.fqn].io;
    let o;
    if (!wf) o = { state: 'none' };
    else if (wf.error !== undefined) o = { state: 'error', reason: wf.error };
    else if (res && res.ok) { const why = outOfDate(wf); o = why ? { state: 'out-of-date', reason: why } : { state: 'ok' }; }
    else if (res) o = { state: 'not-drawn', reason: res.reason };
    else o = { state: 'not-drawn', reason: wireGap || (wf.html === undefined ? 'the wireframe has no html' : 'the screen has no viewport') };
    if (io && io.viewport) o.viewport = { w: io.viewport.w, h: io.viewport.h, source: io.viewport.source };
    return o;
  }

  // ---- the packer (the ONE packer of the IO view, also used by ioBoxes.js): skyline (bottom-left) packing. Items [{w,h}] in order; for a
  // given width W each item, in order, goes to the lowest place (then the leftmost) where it fits under W, so mixed widths fill the holes
  // and the reading order is kept as much as possible. Candidate widths W: the widest item up to the sum of all widths, taken from the sums of
  // runs of neighbouring items (plus gaps); the winner has the smallest score = |log(packed w / h / aspect)| + FILL_W * (1 - fill), fill =
  // sum of item areas / packed area; a tie goes to the smaller area. ROW RULE: 2..4 boxes of about equal size (w and h within 10 %) stand in
  // ONE row when that row's aspect is within a factor 12 / n of the target (demo 7 puts an app's few items side by side).
  // opts = { gap = GAP, aspect = 1.6, extra = { w, h }, minW = 0 }. extra = chrome that surrounds the block (frame header, padding), minW =
  // a block above that is at least this wide: both count in the aspect, not in the result. Measure-only (no ctx).
  // -> { w, h, k, pos: [{ x, y }] }  (k = number of distinct columns (x positions); pos in item order, relative to the top-left of the block)
  const FILL_W = 1.5, ROW_FACTOR = 12;   // row aspect may be off the target by a factor of up to ROW_FACTOR / n
  function skyline(items, W, gap) {
    let sky = [{ x: 0, w: W, y: 0 }];   // contiguous segments covering [0, W), each with the height of what stands on it
    const pos = [];
    items.forEach(it => {
      let best = null;
      sky.forEach((seg, si) => {
        if (seg.x + it.w > W + 1e-9) return;
        let y = 0;
        sky.forEach(q => { if (q.x < seg.x + it.w - 1e-9 && q.x + q.w > seg.x + 1e-9) y = Math.max(y, q.y); });
        if (!best || y < best.y - 1e-9) best = { x: seg.x, y };
      });
      if (!best) best = { x: 0, y: Math.max(...sky.map(q => q.y)) };   // wider than W: cannot happen (W >= widest)
      pos.push({ x: best.x, y: best.y });
      const top = best.y + it.h + gap, x0 = best.x, x1 = best.x + it.w + gap;   // the gap right of and below an item is part of what it occupies
      const next = [];
      sky.forEach(q => {
        if (q.x + q.w <= x0 + 1e-9 || q.x >= x1 - 1e-9) { next.push(q); return; }
        if (q.x < x0) next.push({ x: q.x, w: x0 - q.x, y: q.y });
        if (q.x + q.w > x1) next.push({ x: x1, w: q.x + q.w - x1, y: q.y });
      });
      next.push({ x: x0, w: Math.min(x1, W + gap) - x0, y: top });
      next.sort((a, b) => a.x - b.x);
      sky = next;
    });
    let w = 0, h = 0;
    pos.forEach((p, i) => { w = Math.max(w, p.x + items[i].w); h = Math.max(h, p.y + items[i].h); });
    return { w, h, pos };
  }
  function pack(items, opts) {
    const gap = opts && opts.gap !== undefined ? opts.gap : GAP, aspect = opts && opts.aspect ? opts.aspect : 1.6;
    const ex = (opts && opts.extra) || { w: 0, h: 0 }, minW = (opts && opts.minW) || 0;
    const n = items.length;
    if (!n) return { w: 0, h: 0, k: 0, pos: [] };
    const area = items.reduce((a, i) => a + i.w * i.h, 0), widest = Math.max(...items.map(i => i.w));
    const err = r => Math.abs(Math.log(((Math.max(r.w, minW) + ex.w) / Math.max(1, r.h + ex.h)) / aspect));
    const finish = r => ({ w: r.w, h: r.h, k: new Set(r.pos.map(p => Math.round(p.x * 1000))).size, pos: r.pos });
    // candidate widths: sums of runs of neighbouring items (i..j) with their gaps, from the widest item up to all in one row
    const cand = new Set([widest]);
    for (let i = 0; i < n; i++) { let s = -gap; for (let j = i; j < n; j++) { s += gap + items[j].w; if (s >= widest - 1e-9) cand.add(Math.round(s * 100) / 100); } }
    let ws = [...cand].sort((a, b) => a - b);
    if (ws.length > 120) ws = ws.filter((_, i) => i % Math.ceil(ws.length / 120) === 0 || i === ws.length - 1);
    let best = null;
    ws.forEach(W => {
      const r = skyline(items, W, gap), score = err(r) + FILL_W * (1 - area / Math.max(1, r.w * r.h));
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && r.w * r.h < best.w * best.h)) best = { score, w: r.w, h: r.h, pos: r.pos };
    });
    if (n >= 2 && n <= 4) {   // the row rule
      const like = (k, v) => Math.abs(items[k][v] - items[0][v]) <= 0.1 * Math.max(items[k][v], items[0][v]);
      if (items.every((_, k) => like(k, 'w') && like(k, 'h'))) {
        let x = 0; const row = { w: 0, h: Math.max(...items.map(i => i.h)), pos: items.map(it => { const p = { x, y: 0 }; x += it.w + gap; return p; }) };
        row.w = x - gap;
        if (err(row) <= Math.log(ROW_FACTOR / n)) return finish(row);
      }
    }
    return finish(best);
  }
  // The aspect (w / h) the layout aims at: the map area's. layout() runs at script load, before any canvas, so read #map-wrap (the script sits
  // after it in the page) when it has a size, else the window minus the two side panels (--left-w / --right-w of #root), else 1.0 (jest harness).
  function mapAspect() {
    try {
      const wrap = document.getElementById('map-wrap');
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0) return clamp(wrap.clientWidth / wrap.clientHeight, 0.6, 2);
      const iw = window.innerWidth, ih = window.innerHeight, rt = document.getElementById('root');
      if (iw > 0 && ih > 0 && rt) {
        const cs = window.getComputedStyle(rt), v = name => parseFloat(cs.getPropertyValue(name)) || 0;
        return clamp((iw - v('--left-w') - v('--right-w')) / ih, 0.6, 2);
      }
    } catch (e) { /* no DOM: fall through */ }
    return 1;
  }
  const rowLimit = items => Math.max(Math.max(...items.map(i => i.w)), 1.4 * Math.sqrt(items.reduce((a, i) => a + i.w * i.h, 0)));

  function layout() {
    if (laidOut) return;
    const D = window.C4PM_DATA;
    if (!D || !D.nav || !D.navView || !D.navView.root) return;
    const nav = D.nav;
    index(nav, D.navView);

    // 0. W11 (b307): measure the screen wireframes once; the badge of every screen (Q12: 'none' only when a screen of the page has a wireframe)
    measureWire(D, nav);
    const anyWire = nav.groups.some(g => g.entries.some(e => e.kind === 'screen' && e.wireframe));
    nav.groups.forEach(g => g.entries.forEach(e => { if (e.kind === 'screen') WINFO[e.fqn] = wireInfo(e); }));

    // 1. bands: one per family present, measured by the family module
    frames = nav.groups.map(group => {
      const kinds = [];
      FAMILY_ORDER.forEach(k => { if (group.entries.some(e => e.kind === k)) kinds.push(k); });
      group.entries.forEach(e => { if (kinds.indexOf(e.kind) < 0) kinds.push(e.kind); });
      const bands = kinds.map(family => {
        const entries = group.entries.filter(e => e.kind === family);
        const ids = new Set(entries.map(e => e.fqn));
        const io = {};
        entries.forEach(e => { if (IDX.node[e.fqn] && IDX.node[e.fqn].io) io[e.fqn] = IDX.node[e.fqn].io; });
        const band = { family, group, entries, io, edges: nav.edges.filter(e => !e.self && ids.has(e.from) && ids.has(e.to)),
          word: familyWord(group, family), w: 0, h: 0, local: {}, x: 0, y: 0 };
        if (family === 'screen') {   // W11: the measured wireframes and the badges of this band's screens
          band.wire = {}; band.mark = {};
          entries.forEach(e => {
            const st = WINFO[e.fqn].state;
            if (WIRE[e.fqn]) band.wire[e.fqn] = WIRE[e.fqn];
            if (st !== 'ok' && (st !== 'none' || anyWire)) band.mark[e.fqn] = st;
          });
        }
        const m = moduleOf(family);
        if (m) m.measure(band); else console.debug('[C4PM_IOVIEW] no family module for', family, '(its entries get no rect)');
        entries.forEach(e => { BAND_OF[e.fqn] = band; });
        return { band, outer: null };
      });
      const fr = { group, id: group.fqn, multi: bands.length > 1, bands, rect: null, head: 0 };
      group.entries.forEach(e => { frameOf[e.fqn] = fr; });
      return fr;
    });

    // 2. header sizes from the size of the whole view (so a header reads about the same at Fit)
    const raw = frames.flatMap(f => f.bands.map(b => ({ w: b.band.w, h: b.band.h })));
    const limit0 = raw.length ? rowLimit(raw) : 0;
    const head = Math.max(HEAD_MIN, HEAD_FRAC * limit0), bandHead = Math.max(BAND_HEAD_MIN, head * 0.55);

    // 3. frame content: a frame with several families gets a sub-frame (header + padding) around each band. The screens band has its own
    // first row (full width); the other bands are packed below it.
    frames.forEach(f => {
      f.head = head; f.bandHead = bandHead;
      const outer = (b, k) => (f.multi ? { w: k * b.band.w + 2 * BP, h: bandHead + k * b.band.h + BP } : { w: b.band.w, h: b.band.h });
      const items = f.bands.map(b => outer(b, 1));
      const first = f.multi && f.bands.length > 1 && f.bands[0].band.family === 'screen' ? 1 : 0;
      const rest = pack(items.slice(first), { aspect: mapAspect(), extra: { w: 2 * PAD, h: head + 2 * PAD + (first ? items[0].h + GAP : 0) } });
      if (first && rest.pos.length) {
        // b607: the screens row is scaled up (band.scale) to the full width of the bands below it, but never taller than they are
        const sb = f.bands[0].band;
        sb.scale = Math.max(1, Math.min((rest.w - 2 * BP) / sb.w, (rest.h - bandHead - BP) / sb.h));
        items[0] = outer(f.bands[0], sb.scale);
      }
      const pos = items.map(() => null);
      let w = rest.w, h = rest.h;
      if (first) { w = Math.max(rest.w, items[0].w); h = items[0].h + (rest.pos.length ? GAP + rest.h : 0); pos[0] = { x: (w - items[0].w) / 2, y: 0 }; }
      rest.pos.forEach((q, i) => { pos[i + first] = { x: q.x, y: q.y + (first ? items[0].h + GAP : 0) }; });
      f.bands.forEach((b, i) => { b.outer = { x: pos[i].x, y: pos[i].y, w: items[i].w, h: items[i].h }; });
      f.w = w + 2 * PAD; f.h = head + PAD + h + PAD;
    });

    // 4. frames packed in the root
    // Frames that hold screens come first, each alone in a full-width row (the web app on top); the other frames are packed below.
    const asp = mapAspect();
    const isScr = f => f.bands.some(b => b.band.family === 'screen');
    const top = frames.filter(isScr), others = frames.filter(f => !isScr(f));
    const rowsW = top.length ? Math.max(...top.map(f => f.w)) : 0;
    const topH = top.reduce((a, f) => a + f.h + GAP, 0) - (top.length ? GAP : 0);
    const op = pack(others.map(f => ({ w: f.w, h: f.h })), { aspect: asp, minW: rowsW, extra: { w: 2 * MARGIN, h: 2 * MARGIN + (top.length ? topH + GAP : 0) } });
    const fp = { w: Math.max(rowsW, op.w), h: topH + (top.length && others.length ? GAP : 0) + op.h, pos: new Map() };
    let ty = 0;
    top.forEach(f => { fp.pos.set(f, { x: 0, y: ty }); ty += f.h + GAP; });
    others.forEach((f, i) => fp.pos.set(f, { x: op.pos[i].x, y: ty + op.pos[i].y }));
    frames.forEach(f => {
      const q = fp.pos.get(f);
      f.rect = { x: q.x, y: q.y, w: f.w, h: f.h };
      const cx = f.rect.x + PAD, cy = f.rect.y + head + PAD;
      f.bands.forEach(b => {
        b.outer = { x: cx + b.outer.x, y: cy + b.outer.y, w: b.outer.w, h: b.outer.h };
        b.band.x = b.outer.x + (f.multi ? BP : 0);
        b.band.y = b.outer.y + (f.multi ? f.bandHead : 0);
      });
    });
    root = { x: -MARGIN, y: -MARGIN, w: fp.w + 2 * MARGIN, h: fp.h + 2 * MARGIN };

    // 5. rects of every id, and the write-back into the navView nodes
    RECT[D.navView.root.id] = root;
    frames.forEach(f => {
      RECT[f.id] = f.rect;
      f.bands.forEach(b => Object.keys(b.band.local).forEach(id => {
        const l = b.band.local[id], k = b.band.scale || 1;
        RECT[id] = { x: b.band.x + k * l.x, y: b.band.y + k * l.y, w: k * l.w, h: k * l.h };
      }));
    });
    // C9 (W11): a region / control of a screen drawn from its wireframe that has no box ("not placed") gets its screen's rect
    Object.keys(IDX.entryOf).forEach(id => {
      const e = IDX.entryOf[id], band = BAND_OF[e], res = band && band.wire && band.wire[e];
      if (id === e || RECT[id] || !RECT[e] || IDX.kindOf[id] === 'state' || !res || !res.ok) return;
      RECT[id] = { x: RECT[e].x, y: RECT[e].y, w: RECT[e].w, h: RECT[e].h };
    });
    Object.keys(RECT).forEach(id => {
      const n = IDX.node[id], r = RECT[id];
      if (!n) return;   // a frame of the layout with no node of its own
      n.x = r.x; n.y = r.y; n.w = r.w; n.h = r.h;
      if (n.bubble) n.bubble = { x: r.x, y: r.y, w: r.w, h: r.h };
    });

    // 6. edges between bands (the module draws the ones inside its band)
    const seen = new Map();
    nav.edges.forEach(e => {
      if (e.self || !RECT[e.from] || !RECT[e.to] || BAND_OF[e.from] === BAND_OF[e.to]) return;
      const k = e.from + '\u0000' + e.to;
      const v = seen.get(k) || { from: e.from, to: e.to, labels: [], vias: [] };
      if (!seen.has(k)) seen.set(k, v);
      if (e.via) v.vias.push(e.via);
      if (e.labelled && e.label && v.labels.indexOf(e.label) < 0) v.labels.push(e.label);
    });
    cross = [...seen.values()];
    laidOut = true;
    console.debug('[C4PM_IOVIEW] layout', { frames: frames.length, bands: frames.reduce((n, f) => n + f.bands.length, 0), cross: cross.length, root });
  }

  // ---- drawing
  // b607: points of a path of cubic segments [p0, c, c, p1, ...] (px), about every `step` px (at least 2 per segment)
  function pathPoints(P, step) {
    const out = [];
    for (let i = 0; i + 3 < P.length; i += 3) {
      const Q = P.slice(i, i + 4), len = Math.hypot(Q[1].x - Q[0].x, Q[1].y - Q[0].y) + Math.hypot(Q[2].x - Q[1].x, Q[2].y - Q[1].y) + Math.hypot(Q[3].x - Q[2].x, Q[3].y - Q[2].y);
      const n = clamp(Math.ceil(len / step), 2, 200);
      for (let j = 0; j <= n; j++) {
        const t = j / n, u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
        out.push({ x: k0 * Q[0].x + k1 * Q[1].x + k2 * Q[2].x + k3 * Q[3].x, y: k0 * Q[0].y + k1 * Q[1].y + k2 * Q[2].y + k3 * Q[3].y });
      }
    }
    return out;
  }
  // b607: the HUD boxes over the top-left of the map (the level pill), screen rects in map px; [] when the map has no canvas / HUD (harness)
  function coverRects(map) {
    const cv = map.canvas, el = document.getElementById('hud-tl');
    if (!cv || !el) return [];
    const o = cv.getBoundingClientRect();
    return Array.from(el.children).map(c => c.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)
      .map(r => ({ x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height }));
  }
  // b607: the left end of a header text [x, x + tw] on the row [y0, y1] (px), moved right past every cover rect it would run under
  function clearOfCover(dc, x, tw, y0, y1) {
    let nx = x;
    dc.cover.forEach(c => { if (c.y < y1 && c.y + c.h > y0 && c.x < nx + tw && c.x + c.w > nx) nx = c.x + c.w + 6; });
    return nx;
  }

  // UI9 (b759, K 2026-11-15): while an s-item is selected (map.sim of the io view, sim.js) the lit io ids plus the entries that
  // hold them, so dc.entryBegin fades every other entry to 0.3; null without one, and null when it lights nothing in this view
  // (with nothing lit, everything stays as without a sim).
  function simHi(sim) {
    if (!sim || sim.view !== 'io' || !sim.ids || !sim.ids.size) return null;   // nothing lit here: nothing fades
    const out = new Set();
    sim.ids.forEach((e, id) => {
      out.add(id);
      // its entry and, for a subcommand, the entries around it (drawn nested: a faded parent would fade it too)
      for (let x = IDX.entryOf[id]; x; x = IDX.entry[x] ? IDX.entry[x].parent : null) out.add(x);
    });
    return out;
  }

  function makeDc(map, C, now, camOf) {
    const R = window.C4PM_RENDER, ctx = map.ctx, cam = camOf || map.cam, mode = window.C4PM_MODE;
    const lit = simHi(map.sim), hi = map.hi || lit, ring = map.hi || null, sel = map.selectedId || null;
    const status = R.theme.STATUS;
    const dc = {
      ctx, cam, cw: map.cw, ch: map.ch, now, C, sel, hi, ring, simOn: !!lit, status, font: R.theme.SANS,
      glow: { out: R.theme.GLOW_OUT, in: R.theme.GLOW_IN, hi: R.theme.BGLOW, arrow: R.theme.ARROW },
      rr: R.text.rr,
      toPx: r => ({ x: r.x * cam.s + cam.tx, y: r.y * cam.s + cam.ty, w: r.w * cam.s, h: r.h * cam.s }),
      offScreen: window.C4PM_CAM.offScreen,
      word: kind => (mode && mode.word(kind)) || kind,
      tag: kind => (mode && mode.tag(kind)) || kind,
      fit: (text, maxW) => R.edges.fitText(ctx, String(text), maxW),
      rows: id => (IDX.node[id] ? IDX.node[id].io : undefined),
      kindOf: id => (IDX.kindOf[id] === undefined ? null : IDX.kindOf[id]),   // 'control', 'region', 'flag', 'command', ... of an entry / part id; null for a frame / the root
      statusOf: id => (IDX.statusOf[id] === undefined ? null : IDX.statusOf[id]),
      dash: id => (IDX.statusOf[id] === 'planned' ? [5, 3] : []),
      hits: [], labels: [], cover: [],
    };
    // edge label pill at (x, y) (screen px) for a curve whose chord is `chord` px long: max width = min(220, 0.9 * chord, clip width); under 36 px
    // no label (zooming in brings it back). The pill stays inside `clip` (screen rect) when given. o = { x, y, chord, text, col, alpha, clip,
    // avoid?, avoidPaths?, along? }.
    dc.label = o => {
      const maxW = Math.min(220, 0.9 * o.chord, o.clip ? o.clip.w : Infinity);
      if (!o.text || maxW < 36) return;
      ctx.save();
      ctx.font = `500 11px ${dc.font}`;
      let text = dc.fit(o.text, maxW - 12);
      if (text) {
        let lw = ctx.measureText(text).width + 12, c = o.clip;
        const inClip = q => ({ x: c ? clamp(q.x, c.x + lw / 2, c.x + c.w - lw / 2) : q.x, y: c ? clamp(q.y, c.y + 10, c.y + c.h - 10) : q.y });
        let { x, y } = inClip(o);
        // o.avoid (screen rects, e.g. the screen frames) and o.avoidPaths (b607: the paths of the other arrows, cubic segments in px): the pill
        // never covers one. If it would, it first moves along its own path (o.along, the nearest free place to (x, y) at its full width);
        // with no such place it shrinks to the free room left / right of what is on its row (the room that holds its middle), under 36 px it
        // is skipped (zooming in brings it back).
        const av = (o.avoid || []).concat(...(o.avoidPaths || []).map(P => pathPoints(P, 4).map(q => ({ x: q.x - 2, y: q.y - 2, w: 4, h: 4 }))));
        const hit = (x0, x1, yy = y) => av.filter(r => r.y < yy + 10 && r.y + r.h > yy - 10 && r.x < x1 && r.x + r.w > x0);
        if (av.length && hit(x - lw / 2, x + lw / 2).length && o.along) {
          const free = pathPoints(o.along, 12).map(inClip).sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y))
            .find(q => !hit(q.x - lw / 2, q.x + lw / 2, q.y).length);
          if (free) { x = free.x; y = free.y; }
        }
        if (av.length && hit(x - lw / 2, x + lw / 2).length) {
          const row = hit(-Infinity, Infinity);
          if (row.some(r => x > r.x && x < r.x + r.w)) { ctx.restore(); return; }
          const L = Math.max(-Infinity, ...row.filter(r => r.x + r.w <= x).map(r => r.x + r.w)), Rr = Math.min(Infinity, ...row.filter(r => r.x >= x).map(r => r.x));
          const lo = Math.max(L, c ? c.x : -Infinity) + 2, hi2 = Math.min(Rr, c ? c.x + c.w : Infinity) - 2;
          if (hi2 - lo < 36) { ctx.restore(); return; }
          text = dc.fit(o.text, hi2 - lo - 12);
          if (!text) { ctx.restore(); return; }
          lw = ctx.measureText(text).width + 12;
          x = clamp(x, lo + lw / 2, hi2 - lw / 2);
        }
        ctx.globalAlpha = o.alpha; ctx.fillStyle = C.panel; dc.rr(x - lw / 2, y - 10, lw, 20, 6); ctx.fill();
        ctx.strokeStyle = o.col; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
        if (text !== o.text) dc.labels.push({ x: x - lw / 2, y: y - 10, w: lw, h: 20, full: o.text });
      }
      ctx.restore();
    };
    dc.entryBegin = id => {
      ctx.save();
      if (hi && !hi.has(id)) ctx.globalAlpha *= 0.3;
    };
    dc.entryEnd = (id, Rc, rad) => {
      if (ring && ring.has(id)) {
        ctx.globalAlpha = 1; ctx.strokeStyle = R.theme.BGLOW; ctx.lineWidth = 3;
        dc.rr(Rc.x, Rc.y, Rc.w, Rc.h, rad || 0); ctx.stroke();
      }
      const stt = IDX.statusOf[id];
      if (stt && stt !== 'planned' && status[stt]) {
        const r = Math.max(2, Math.min(6, 4 * cam.s)), inset = r + 3;
        ctx.fillStyle = status[stt][1];
        ctx.beginPath(); ctx.arc(Rc.x + Rc.w - inset, Rc.y + inset, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    };
    return dc;
  }

  function drawFrame(dc, f) {
    const { ctx, C, cam } = dc, s = cam.s;
    const Rf = dc.toPx(f.rect);
    if (dc.offScreen(Rf)) return false;
    dc.hits.push({ id: f.id, R: Rf });
    const rad = Math.max(2, 10 * s), sel = dc.sel === f.id;
    ctx.save();
    ctx.fillStyle = C.screenSoft; ctx.globalAlpha = 0.55;
    dc.rr(Rf.x, Rf.y, Rf.w, Rf.h, rad); ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = sel ? 2.8 : 2; ctx.strokeStyle = sel ? C.accent : C.screen;
    dc.rr(Rf.x, Rf.y, Rf.w, Rf.h, rad); ctx.stroke();
    const hd = f.head * s, fs = Math.min(15, hd * 0.5);
    if (fs >= 5) {
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = C.screen; ctx.font = `700 ${fs}px ${dc.font}`;
      const x0 = Rf.x + 8 * s + 4, title = dc.fit(f.group.title, Rf.w * 0.55) || f.group.title;
      const tx = clearOfCover(dc, x0, ctx.measureText(title).width, Rf.y, Rf.y + hd);   // b607: never under the HUD pill
      if (tx === x0) ctx.fillText(title, x0, Rf.y + hd / 2);
      else { const t2 = dc.fit(f.group.title, x0 + Rf.w * 0.55 - tx); if (t2) ctx.fillText(t2, tx, Rf.y + hd / 2); }
      const word = f.multi ? f.group.word : f.bands[0].band.word;
      ctx.textAlign = 'right'; ctx.fillStyle = C.muted; ctx.font = `500 ${fs * 0.78}px ${dc.font}`;
      const tech = f.group.technology && f.group.technology.toLowerCase() !== word.toLowerCase() ? '  ·  ' + f.group.technology : '';
      ctx.fillText(word + tech, Rf.x + Rf.w - 8 * s - 4, Rf.y + hd / 2, Rf.w * 0.45);
    }
    ctx.restore();
    return true;
  }

  function drawBandBox(dc, f, b) {
    const { ctx, C, cam } = dc, s = cam.s, Rb = dc.toPx(b.outer);
    if (dc.offScreen(Rb)) return false;
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = C.screenLine;
    dc.rr(Rb.x, Rb.y, Rb.w, Rb.h, Math.max(2, 6 * s)); ctx.stroke();
    const hd = f.bandHead * s, fs = Math.min(12, hd * 0.5);
    if (fs >= 5) {
      const n = b.band.entries.length, w = dc.word(b.band.family).toLowerCase() + (n === 1 ? '' : 's');
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = C.muted; ctx.font = `700 ${fs}px ${dc.font}`;
      const text = b.band.word + '  ·  ' + n + ' ' + w, x0 = Rb.x + 8 * s + 2, room = Rb.w - 16 * s;
      const tx = clearOfCover(dc, x0, Math.min(room, ctx.measureText(text).width), Rb.y, Rb.y + hd);   // b607: never under the HUD pill
      if (tx === x0 || x0 + room - tx >= 36) ctx.fillText(text, tx, Rb.y + hd / 2, x0 + room - tx);
    }
    ctx.restore();
    return true;
  }

  // Arrows between two bands (a screen of one app to a screen of another): side to side curve, label pill at the middle. b607: every arrow
  // is drawn first, then the labels, each avoiding its two frames and the other arrows.
  function drawCross(dc) {
    const { ctx, C } = dc, G = dc.glow, todo = [];
    cross.forEach(e => {
      const a = dc.toPx(RECT[e.from]), b = dc.toPx(RECT[e.to]);
      if (dc.offScreen(a) && dc.offScreen(b) && (a.x + a.w < 0) === (b.x + b.w < 0) && (a.y + a.h < 0) === (b.y + b.h < 0)) return;
      const own = (dc.sel && IDX.entryOf[dc.sel]) || dc.sel;   // a selected part counts as its entry
      const selCtl = dc.sel && IDX.kindOf[dc.sel] === 'control';   // a selected control: only the arrow it starts glows
      const out = selCtl ? e.vias.indexOf(dc.sel) >= 0 : own === e.from, inn = !selCtl && own === e.to, dim = (!!dc.sel || dc.simOn) && !out && !inn;
      const right = b.x >= a.x + a.w || (b.x + b.w / 2) >= (a.x + a.w / 2);
      const p0 = { x: right ? a.x + a.w : a.x, y: a.y + a.h / 2 }, p3 = { x: right ? b.x : b.x + b.w, y: b.y + b.h / 2 };
      const d = Math.max(40, Math.abs(p3.x - p0.x) / 2) * (right ? 1 : -1);
      const p1 = { x: p0.x + d, y: p0.y }, p2 = { x: p3.x - d, y: p3.y };
      const col = out ? G.out : inn ? G.in : C.edge;
      ctx.save();
      ctx.globalAlpha = dim ? 0.16 : 1; ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = out || inn ? 2.4 : 1.6;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y); ctx.stroke();
      const ang = Math.atan2(p3.y - p2.y, p3.x - p2.x);
      ctx.beginPath(); ctx.moveTo(p3.x, p3.y);
      ctx.lineTo(p3.x - G.arrow * Math.cos(ang - 0.4), p3.y - G.arrow * Math.sin(ang - 0.4));
      ctx.lineTo(p3.x - G.arrow * Math.cos(ang + 0.4), p3.y - G.arrow * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.restore();
      todo.push({ e, a, b, P: [p0, p1, p2, p3], col, out, inn, dim });
    });
    todo.forEach(({ e, a, b, P, col, out, inn, dim }) => {
      const full = e.labels.join(', ');
      if (!full || dim) return;
      const fa = frameOf[e.from], clip = fa && fa === frameOf[e.to] ? dc.toPx(fa.rect) : null;   // inside the frame when both ends share one
      const p0 = P[0], p3 = P[3], others = todo.filter(t => t.P !== P).map(t => t.P);
      dc.label({ x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2, chord: Math.hypot(p3.x - p0.x, p3.y - p0.y), text: full, col: out || inn ? col : C.line, alpha: 1, clip, avoid: [a, b], avoidPaths: others, along: P });
    });
  }

  // b607: the dc a band is drawn with. A band with a scale (the screens row) gets a camera that maps its content (band.x + local) to
  // band.x + scale * local, so the module draws it bigger without knowing; hits, labels and cover are the shared ones.
  function bandDc(dc, band, map, C, now) {
    const k = band.scale || 1;
    if (k === 1) return dc;
    const c = dc.cam, d = makeDc(map, C, now, { s: c.s * k, tx: c.tx + band.x * c.s * (1 - k), ty: c.ty + band.y * c.s * (1 - k) });
    d.hits = dc.hits; d.labels = dc.labels; d.cover = dc.cover;
    return d;
  }

  function draw(map, C, now) {
    layout();
    if (!laidOut) return;
    const dc = makeDc(map, C, now);
    dc.cover = coverRects(map);
    dc.hits.push({ id: window.C4PM_DATA.navView.root.id, R: dc.toPx(root) });
    frames.forEach(f => {
      if (!drawFrame(dc, f)) return;
      f.bands.forEach(b => {
        if (f.multi && !drawBandBox(dc, f, b)) return;
        if (!f.multi && dc.offScreen(dc.toPx(b.outer))) return;
        const m = moduleOf(b.band.family);
        if (m) m.draw(bandDc(dc, b.band, map, C, now), b.band);
      });
    });
    drawCross(dc);
    lastHits = dc.hits;
    map.edgeLabels = dc.labels;
  }

  // ---- queries
  function hit(px, py) {
    for (let i = lastHits.length - 1; i >= 0; i--) {
      const h = lastHits[i], R = h.R;
      if (px >= R.x && px <= R.x + R.w && py >= R.y && py <= R.y + R.h) return { id: h.id, entryId: IDX.entryOf[h.id] || null };
    }
    return null;
  }
  const rect = id => (RECT[id] ? { x: RECT[id].x, y: RECT[id].y, w: RECT[id].w, h: RECT[id].h } : null);
  const bounds = () => rect(window.C4PM_DATA && window.C4PM_DATA.navView ? window.C4PM_DATA.navView.root.id : '(io)');
  // W11 (b307): see the CONTRACT. Copies, so a caller cannot change the layout's own data.
  function wireOf(id) {
    const w = WINFO[id];
    if (!w) return null;
    const o = { state: w.state };
    if (w.reason !== undefined) o.reason = w.reason;
    if (w.viewport) o.viewport = { w: w.viewport.w, h: w.viewport.h, source: w.viewport.source };
    return o;
  }
  function placed(id) {
    const e = IDX.entryOf[id], band = e && e !== id ? BAND_OF[e] : null, bx = band && band.boxes ? band.boxes[id] : null;
    return bx && bx.length ? { boxes: bx.length, hidden: bx.every(r => r.hidden) } : null;
  }

  function focus() {
    const { map } = st();
    if (!laidOut || !map.cam) return null;
    const { s, tx, ty } = map.cam, wx = (map.cw / 2 - tx) / s, wy = (map.ch / 2 - ty) / s;
    let best = null, bestA = Infinity;
    Object.keys(IDX.kindOf).forEach(id => {
      const r = RECT[id];
      if (!r || wx < r.x || wx > r.x + r.w || wy < r.y || wy > r.y + r.h) return;
      const area = r.w * r.h;
      if (Math.sqrt((r.w * s / map.cw) * (r.h * s / map.ch)) >= FOCUS_MIN && area < bestA) { best = id; bestA = area; }
    });
    return best ? { id: best, entryId: IDX.entryOf[best] } : null;
  }

  function hud() {
    const f = focus();
    if (f) return modeWord(IDX.kindOf[f.id]);
    const present = [];
    FAMILY_ORDER.forEach(k => { if (frames.some(fr => fr.group.entries.some(e => e.kind === k))) present.push(k); });
    frames.forEach(fr => fr.group.entries.forEach(e => { if (present.indexOf(e.kind) < 0) present.push(e.kind); }));
    return present.map(modeWord).join(' · ');
  }

  window.C4PM_IOVIEW = { layout, draw, hit, rect, bounds, hud, focus, familyWord, FAMILY_WORD, pack, mapAspect, wireOf, placed };
  window.C4PM_IO_BOXES.setPacker({ pack, mapAspect });   // LAY-12b: ioBoxes.js packs with the core's packer, handed over here
  layout();

  // VIEW-0 (b337): the IO view in the view registry (mode.js C4PM_VIEWS). chips = the header chips (P20-T5-F, b260: counts from
  // C4PM_DATA.nav), color = the HUD chip colour.
  window.C4PM_MODE.registerView('io', {
    label: 'IO view',
    short: 'IO',
    tree: d => (d.navView ? { root: d.navView.root, edges: d.navView.edges } : null),
    renderer: () => window.C4PM_IOVIEW,
    chips: d => {
      const nav = d.nav;
      const apps = nav.groups.length;
      const all = nav.groups.reduce((l, g) => l.concat(g.entries), []);   // p27: screens, commands, routes, tools
      const links = nav.edges.length;
      return apps + ' app' + (apps === 1 ? '' : 's') + ' · ' +
        window.C4PM_MODE.counts(all.map(e => e.kind)) + ' · ' + links + ' link' + (links === 1 ? '' : 's');
    },
    color: 'screen',
  });

  // Phase 30 SV9b (b642): the view-state part 'io' = { id }: the focused screen (focus(): the entry or part in the view centre).
  // The camera part of viewState.js brings the IO view back; this part acts only when that leaves another screen (or none) in
  // focus (a changed layout, a camera rebuilt from pixels): the camera then fits the kept screen. An id no longer laid out is
  // skipped. The value stays kept while another view is shown. viewState.js loads after this file, so the part is added at
  // DOMContentLoaded (or on the next timer in a loaded page).
  let keptFocus = null;
  const has = id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(RECT, id);
  const ioPart = {
    get: () => {
      if (!window.C4PM_MODE || window.C4PM_MODE.get() !== 'io') return keptFocus ? { id: keptFocus } : undefined;
      const f = focus();
      keptFocus = f ? f.id : null;
      return keptFocus ? { id: keptFocus } : undefined;
    },
    set: v => {
      if (!v || typeof v !== 'object' || !has(v.id)) return;
      keptFocus = v.id;
      const { map } = st(), CAM = window.C4PM_CAM;
      if (window.C4PM_MODE.get() !== 'io' || !CAM || !map.cam || !(map.cw > 0) || !(map.ch > 0)) return;
      const f = focus();
      if (f && f.id === v.id) return;   // the camera part shows it already
      cancelAnimationFrame(map.anim);
      map.cam = CAM.fitCam(rect(v.id));
      if (st().requestDraw) st().requestDraw();
    },
  };
  // C4PM_STATE.whenReady (state.js): a page without state.js has no viewState.js either.
  if (st()) st().whenReady(() => { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.part('io', ioPart); });
})();
