// render.js: all drawing. Moved unchanged from map.js (P14-G3a: theme, text and tags, beans; P14-G3b: regions). Edges follow in G3c.
(function() {
  const st = () => window.C4PM_STATE;        // created by state.js: { map, data, nodeById, origRects, overlays, requestDraw, draw }; read at CALL time only

  // ===== THEME =====
  const SANS = '"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif';
  const MONO = '"JetBrains Mono",ui-monospace,Consolas,monospace';
  let C = {}; // colors

  // Status-pill + dashed-border palette, ported verbatim from the mock's STATUS/COL tables
  // (Document/v0.3-viewer-mock.html). Not theme-aware (light/dark) in the mock either, so kept as
  // plain hex here rather than inventing new CSS variables this port doesn't need.
  const STATUS = {
    done: ['Done', '#5CC98C', '#15352A'],
    'in-progress': ['In progress', '#E7B24A', '#3A2E14'],
    planned: ['Planned', '#A3B0AD', '#243030'],
  };
  const AMBER_FG = '#E7B24A', AMBER_BG = '#3A2E14';
  const RED_FG = '#F07A6C', RED_BG = '#3E1C18';
  const GLOW_OUT = '#36E2C9';  // cyan: edges leaving the selected node
  const GLOW_IN = '#F05FD0';   // magenta: edges entering the selected node
  const BGLOW = '#FFB020';     // amber: c-items and arrows a selected board item touches (P16-B30b)
  const BGLOW_INK = '#2A1D00'; // Phase 25 (UI4, b754): text on amber (the step numbers of a lit s-item)
  const ARROW = 11;            // arrowhead length in px
  const FILE_ARROWS_ALL_MAX = 20;   // b896: a box with more file -> file arrows than this shows only the selected card's
  // b908: foundation components (plan role 'foundation'): option D tinted glass in their own hue
  const FOUND_TOKENS = ['--found-1', '--found-2', '--found-3'];   // style.css, per theme
  const FOUND_TINT = 0.09, FOUND_LINE = 0.75, FOUND_GLOW = 0.35;   // fill, 1 px border, inner glow (demo option D)
  const FOUND_EDGE_ALPHA = 0.45;                                   // an incoming arrow while the box is only hovered or focused

  // Read colors from CSS variables
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
    C = {
      system: v('--c1'), container: v('--c2'), component: v('--c3'), file: v('--file'),
      fn: v('--fn'), cls: v('--cls'),
      person: v('--person'), external: v('--external'),
      actorInk: v('--actor-ink'), externalLine: v('--external-line'),   // C1 C1 (b833): text on a person or an external, an external's dashed outline
      screen: v('--screen'),   // P20-T5-C (b257)
      // IO view (ioView.js and its family modules): soft fill, light line, control stroke, route method pill colours
      screenSoft: v('--screen-soft'), screenLine: v('--screen-line'), control: v('--control'),
      method: { GET: v('--method-get'), POST: v('--method-post'), PUT: v('--method-put'), PATCH: v('--method-put'), DELETE: v('--method-delete') },
      c3ink: v('--c3-ink'),
      ink: v('--ink'), muted: v('--muted'), line: v('--line'), panel: v('--panel'), panel2: v('--panel2'),
      accent: v('--accent'), bp: v('--bp'), bpline: v('--bpline'), edge: v('--edge'),
      drift_added: v('--drift-added'), drift_grew: v('--drift-grew'), drift_shrank: v('--drift-shrank'),
      drift_changed: v('--drift-changed'), drift_renamed: v('--drift-renamed'),
      findings: v('--findings'),
      tests: v('--tests'), testsSoft: v('--tests-soft'),   // Phase 26 (T26-10): the test count pill
      // Phase 25 (UI4, b754): simulation overlays (sim-map.js): teal path, new row, changed cell, unverified step
      flow: v('--flow'), added: v('--added'), changed: v('--changed'), unver: v('--unver'),
      found: FOUND_TOKENS.map(v),   // b908: one hue per foundation slot
    };
    // b142: every colour key of the kind table (mode.js) -> its CSS value, for getNodeColor
    C.vars = {};
    ['arch', 'io', 'storage'].forEach(view => {
      const t = ((window.C4PM_DATA && window.C4PM_DATA.kindWords) || {})[view] || {};
      Object.keys(t).forEach(k => { if (!(t[k].color in C.vars)) C.vars[t[k].color] = v('--' + t[k].color); });
    });
    return C;
  }

  // b142: the node colour comes from the kind table (C4PM_MODE.color = CSS variable name, mode.js); unknown kind reads as a component
  function getNodeColor(n) {
    const key = window.C4PM_MODE ? window.C4PM_MODE.color(n.kind) : undefined;
    if (key === 'unassigned') return RED_BG;      // distinct dark-red fill, per the mock's COL.unassigned
    if (key) return C.vars[key] || C.component;
    return C.component;
  }

  // A planned bean has no code behind it yet: a ghost node or a planned element with no real node
  // (builtState 'planned', set by P14-L4-4-i / 4-ii). Not origin.kind 'plan' alone: a built component
  // can carry origin 'plan' with no node.file (its code sits on its slice child), so that test would
  // dash real code.
  const isPlanned = n => n.builtState === 'planned';
  // A dashed bean: planned code only. C1 C1 (b833): an external (drawExternal) and a person (drawPerson) have their own shapes.
  const isDashed = n => isPlanned(n);
  const PLANNED_FILL_ALPHA = 0.08; // tint inside a planned bean's dashed outline

  // b908: a component the plan marks role 'foundation' (page data meta.role, model.ts attachFoundation)
  const isFoundation = n => !!(n && n.kind === 'component' && n.meta && n.meta.role === 'foundation');
  function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  // Slot of each foundation box of the current tree: FNV-1a of uid (else planId, else id) mod the slot count, the same every
  // build; boxes in key order, a clash takes the next free slot. Rebuilt when the tree changes (mode switch).
  let foundSlots = { root: null, slot: new Map() };
  function foundationSlots() {
    const { data, nodeById } = st();
    if (foundSlots.root !== data.root) {
      const key = x => String(x.uid || x.planId || x.id);
      const list = Object.keys(nodeById).map(id => nodeById[id]).filter(isFoundation).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      const slot = new Map(), taken = new Set(), N = FOUND_TOKENS.length;
      list.forEach(x => {
        let s = fnv1a(key(x)) % N;
        for (let k = 0; k < N && taken.has(s); k++) s = (s + 1) % N;
        taken.add(s);
        slot.set(x.id, s);
      });
      foundSlots = { root: data.root, slot };
    }
    return foundSlots.slot;
  }
  const foundationHue = n => (C.found && C.found[foundationSlots().get(n.id) || 0]) || C.accent;
  // The foundation box that is `id` or holds it (null: none, or an unknown id)
  function foundationOf(id) {
    for (let n = id ? st().nodeById[id] : null; n; n = n.parent) if (isFoundation(n)) return n;
    return null;
  }

  // Border / header colour of an open region: the kind colour, except 'unassigned' whose kind
  // colour (RED_BG) is a dark fill that would vanish on the blueprint, so it uses RED_FG.
  const regionColor = n => (n.kind === 'unassigned' ? RED_FG : getNodeColor(n));

  // ===== TEXT AND TAGS =====
  // Canvas drawing helpers
  // `add` (C1 C1, b833): add the rounded box to the current path instead of starting a new one (a person's head and body are one path)
  function rr(x, y, w, h, r, add) {
    const { map } = st();
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const ctx = map.ctx;
    if (!add) ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // A 'slice' node is a split file when check.ts's 'split-file' rule fired for its underlying
  // file. That finding's id is the bare file path (model.ts/overlay.ts never route it onto any
  // single slice node -- a split file legitimately has one slice node per owner, see
  // src/view/overlay.ts's ROUTABLE_KINDS comment), but it IS present in data.planFindings (the
  // whole ViewModel, including planFindings, reaches the browser as window.C4PM_DATA) and every
  // slice ViewNode carries the real `file` path it groups -- so cross-referencing the two here is
  // reading real data, not guessing a field that doesn't exist.
  function isSplitFile(n) {
    const { data } = st();
    return !!(n.file && data.planFindings && data.planFindings.some(f => f.rule === 'split-file' && f.id === n.file));
  }

  // Which small pills drawTags should render for a node, ported from the mock's `tagsFor`. Only
  // a status pill (from n.meta.status, claim-mode components) plus the three "needs attention"
  // tags (auto-shared / split-file / unassigned-function) are drawn on the map itself -- owner and
  // sprint show in the detail panel (T6), not as map pills, matching the mock's actual behavior.
  function tagsFor(n) {
    const t = [];
    if (n.meta && STATUS[n.meta.status]) {
      const [l, fg, bg] = STATUS[n.meta.status];
      t.push({ t: l, fg, bg });
    }
    if (n.kind === 'shared') t.push({ t: 'auto', fg: AMBER_FG, bg: AMBER_BG });
    if (n.kind === 'slice' && isSplitFile(n)) t.push({ t: 'split file', fg: AMBER_FG, bg: AMBER_BG });
    if ((n.kind === 'function' || n.kind === 'method') && n.findings && n.findings.some(f => f.severity === 'critical')) {
      t.push({ t: 'unassigned', fg: RED_FG, bg: RED_BG });
    }
    // Skip when the status pill above already says 'Planned', so a planned node does not show it twice.
    if (isPlanned(n) && !(n.meta && n.meta.status === 'planned')) {
      const [l, fg, bg] = STATUS.planned;
      t.push({ t: l, fg, bg });
    }
    return t;
  }

  // Draw a node's small status/attention pills, ported from the mock's `drawTags`. Returns the rect they cover (null: none).
  // `list` (C1 C1, b833): the pills to draw instead of tagsFor(n) (an external shows only its Planned pill).
  function drawTags(n, ax, cy, size, alpha, align, list) {
    const { map } = st();
    const ctx = map.ctx;
    const ps = list || tagsFor(n);
    if (!ps.length) return null;
    ctx.font = `500 ${size}px ${SANS}`;
    const ws = ps.map(p => ctx.measureText(p.t).width + size * 1.3);
    const gap = size * 0.4, h = size * 1.65;
    const tot = ws.reduce((a, b) => a + b, 0) + gap * (ps.length - 1);
    let x = align === 'center' ? ax - tot / 2 : ax - tot;
    const covered = { x, y: cy - h / 2, w: tot, h };
    ps.forEach((p, i) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.bg;
      rr(x, cy - h / 2, ws[i], h, h / 2);
      ctx.fill();
      ctx.fillStyle = p.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.t, x + ws[i] / 2, cy + 0.5);
      x += ws[i] + gap;
    });
    return covered;
  }

  // b909: a detail line fitted to maxWidth, never squeezed. `measure(s)` = the width of s in the font it will be drawn with.
  // Fits: as is. Else a ' + ' list keeps the leading parts that fit with ' + N more' (N = parts left out; at least the first
  // part, cut with '…' when even that does not fit); text without ' + ' is cut with '…'. '' when not even '…' fits.
  function fitDetail(measure, text, maxWidth) {
    if (!text || measure(text) <= maxWidth) return text || '';
    const cut = (s, room) => {
      for (let len = s.length - 1; len > 0; len--) {
        const c = s.slice(0, len).trimEnd() + '…';
        if (measure(c) <= room) return c;
      }
      return '';
    };
    const parts = text.split(' + ');
    if (parts.length < 2) return cut(text, maxWidth);
    for (let keep = parts.length - 1; keep >= 1; keep--) {
      const c = parts.slice(0, keep).join(' + ') + ' + ' + (parts.length - keep) + ' more';
      if (measure(c) <= maxWidth) return c;
    }
    const tail = ' + ' + (parts.length - 1) + ' more';
    const head = cut(parts[0], maxWidth - measure(tail));
    return head ? head + tail : cut(parts[0], maxWidth);
  }

  // The rect one line of text covers: drawn with the current ctx.font and textBaseline 'middle' at height cy, anchored
  // at ax by `align` ('center' or 'left'), at most maxW wide (fillText's maxWidth), one line of `size` px.
  function textRect(ctx, text, ax, cy, size, align, maxW) {
    const w = Math.min(ctx.measureText(text).width, maxW == null ? Infinity : maxW);
    return { x: align === 'center' ? ax - w / 2 : ax, y: cy - size * 0.6, w, h: size * 1.2 };
  }

  const stubLabel = n => n.name + (st().overlays.stubs && n.stub ? ' (stub)' : '');

  const BUBBLE_FS_MAX = 16;                     // font of the standard 170x64 bubble: min(16, 170/10, 64/3.2) = 16
  const LABEL_MIN_FS = BUBBLE_FS_MAX * 0.28125; // = 4.5: text hides below 28.125% of the standard font

  // Text inside a bubble: name (+ '(stub)'), the detail line, then the status/attention pills,
  // stacked and centred. Ported from the demo's drawBubble, plus the tag pills and '(stub)' label.
  // Returns the rects the text covers ([] when the box is too small for text), so the count pills can keep off them.
  // `opts` (C1 C1, b833; optional): { detail, tags, ink } instead of n.detail, tagsFor(n) and the kind's text colour (a person's body
  // says "person", an external's box "external system").
  function drawBubbleText(n, R, alpha, opts) {
    const { map } = st();
    const ctx = map.ctx;
    const o = opts || {};
    const fs = Math.min(BUBBLE_FS_MAX, R.w / 10, R.h / 3.2);
    if (fs < LABEL_MIN_FS) return [];
    const mw = R.w * 0.9;
    const cx = R.x + R.w / 2;
    const detail = o.detail !== undefined ? o.detail : n.detail;
    const tags = o.tags || tagsFor(n);
    const rows = fs * 1.2 + (detail ? fs * 1.05 : 0) + (tags.length ? fs * 1.5 : 0);
    let cy = R.y + R.h / 2 - rows / 2 + fs * 0.6;
    ctx.fillStyle = o.ink || (isDashed(n) ? C.ink : n.kind === 'component' ? C.c3ink : '#ffffff'); // hollow planned bean: dark text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${fs}px ${SANS}`;
    const label = stubLabel(n);
    ctx.fillText(label, cx, cy, mw);
    const covered = [textRect(ctx, label, cx, cy, fs, 'center', mw)];
    cy += fs * 1.2;
    if (detail) {
      ctx.globalAlpha = alpha * 0.8;
      ctx.font = `400 ${fs * 0.72}px ${SANS}`;
      const shown = fitDetail(s => ctx.measureText(s).width, detail, mw);   // b909: the links that fit + 'N more', never squeezed
      if (shown) {
        ctx.fillText(shown, cx, cy - fs * 0.15);
        covered.push(textRect(ctx, shown, cx, cy - fs * 0.15, fs * 0.72, 'center'));
      }
      cy += fs * 1.05;
    }
    const tagRect = tags.length ? drawTags(n, cx, cy - fs * 0.1 + fs * 0.3, fs * 0.72, alpha, 'center', tags) : null;
    if (tagRect) covered.push(tagRect);
    return covered;
  }

  // ===== BEANS (bubbles) =====
  // b908 option D on the canvas: the hue at 9% inside, a soft inner glow (the outline stroked wide and blurred, clipped to
  // the box so only its inner half shows), a 1 px border at 75%. Normal box shape and size; no drop shadow.
  function drawFoundationBox(n, R, a, rad) {
    const ctx = st().map.ctx;
    const hue = foundationHue(n);
    ctx.fillStyle = hue;
    ctx.globalAlpha = a * FOUND_TINT;
    rr(R.x, R.y, R.w, R.h, rad);
    ctx.fill();
    const g = Math.max(2, Math.min(18, Math.min(R.w, R.h) * 0.14));   // glow depth, px
    ctx.save();
    rr(R.x, R.y, R.w, R.h, rad);
    ctx.clip();
    ctx.globalAlpha = a * FOUND_GLOW;
    ctx.strokeStyle = hue;
    ctx.shadowColor = hue;
    ctx.shadowBlur = g;
    ctx.lineWidth = g;
    rr(R.x, R.y, R.w, R.h, rad);
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = a * FOUND_LINE;
    ctx.lineWidth = 1;
    ctx.strokeStyle = hue;
    rr(R.x, R.y, R.w, R.h, rad);
    ctx.stroke();
    ctx.globalAlpha = a;
  }

  // PASS 3: one bubble (rounded shape in the kind colour, shadow, name + detail), drawn on top of
  // the edges.
  function drawBubble({ n, R, a: a0 }) {
    const { map } = st();
    // P16-B30b: while a board item is selected (map.hi), c-items it does not touch fade.
    const hs = hiState(n);
    const a = map.hi && !hs ? a0 * 0.3 : a0;
    if (a < 0.01 || window.C4PM_CAM.offScreen(R)) return;
    const ctx = map.ctx;
    const rad = Math.min(R.h / 2, 14);
    ctx.save();
    ctx.globalAlpha = a;
    // C1 C1 (b833): a person and an external are drawn as the demo draws them, at every zoom (no count pills on them)
    if (n.kind === 'person') drawPerson(n, R, a);
    else if (n.kind === 'external') drawExternal(n, R, a);
    else {
      if (isDashed(n)) {
        // Planned: faint tint and a dashed outline, no shadow. The dash is reset right after the stroke.
        ctx.fillStyle = getNodeColor(n);
        ctx.globalAlpha = a * PLANNED_FILL_ALPHA;
        rr(R.x, R.y, R.w, R.h, rad);
        ctx.fill();
        ctx.globalAlpha = a;
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = getNodeColor(n);
        rr(R.x, R.y, R.w, R.h, rad);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (isFoundation(n)) {
        drawFoundationBox(n, R, a, rad);
      } else {
        ctx.shadowColor = 'rgba(0,0,0,.18)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = getNodeColor(n);
        rr(R.x, R.y, R.w, R.h, rad);
        ctx.fill();
        ctx.shadowColor = 'transparent';
      }
      drawOverlays(n, R, a, true);
      // b908: a foundation box's name is in the theme ink (c3ink would vanish on the dark glass)
      drawCountPills(n, R, a, drawBubbleText(n, R, a, isFoundation(n) ? { ink: C.ink } : undefined));
    }
    if (hs) {
      // Glowing ring: solid when the c-item itself is lit, dashed when it only contains a lit one. It follows the drawn shape.
      const glow = 6 + 6 * (0.5 + 0.5 * Math.sin(Date.now() / 220));
      ctx.globalAlpha = a;
      ctx.strokeStyle = BGLOW;
      ctx.shadowColor = BGLOW;
      ctx.shadowBlur = glow;
      ctx.lineWidth = 3;
      if (hs === 'contains') ctx.setLineDash([6, 4]);
      shapePath(n, R, 4, rad);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  // ===== PERSONS AND EXTERNALS (C1 C1, b833) =====
  // As the Phase 25 demo draws them (Document/Roadmap/Phase25/demo-lines-ref.html drawOutside). A person's rect holds the figure:
  // the head is a circle of radius PERSON_HEAD x the rect height at the top centre (a square of that half-side for a person whose
  // plan metadata has shape 'robot', C1 C2 b834), the body box starts at PERSON_BODY x the height.
  const PERSON_HEAD = 0.2, PERSON_BODY = 0.44;

  // The path of a closed node's drawn outline grown by d px (d = 0: the shape itself): a person's head and body as one path, any
  // other node the rounded box with corner `rad` (default the bubble's). Used for the fill, the selection ring, the board ring
  // (drawBubble) and the simulation ring (sim-map.js), so every ring follows the shape.
  function shapePath(n, R, d, rad) {
    const ctx = st().map.ctx;
    if (n.kind !== 'person') {
      rr(R.x - d, R.y - d, R.w + 2 * d, R.h + 2 * d, (rad == null ? Math.min(R.h / 2, 14) : rad) + d);
      return;
    }
    const hr = R.h * PERSON_HEAD, hx = R.x + R.w / 2, hy = R.y + hr, by = R.y + R.h * PERSON_BODY, bh = R.y + R.h - by;
    rr(R.x - d, by - d, R.w + 2 * d, bh + 2 * d, Math.min(bh * 0.35, 14) + d);
    // C1 C2 (b834): plan metadata shape 'robot' (an AI person): a square head of the same size, slightly rounded
    if (n.meta && n.meta.shape === 'robot') {
      rr(hx - hr - d, hy - hr - d, 2 * (hr + d), 2 * (hr + d), hr * 0.25 + d, true);
      return;
    }
    ctx.moveTo(hx + hr + d, hy);
    ctx.arc(hx, hy, hr + d, 0, Math.PI * 2);
  }

  // A closed person: the figure in the person colour with a shadow, the name and the word "person" in the body, no status pill
  // (K 2026-11-16, Q4). Too small for text: the name goes below the figure. Selected: the accent ring around the figure.
  function drawPerson(n, R, a) {
    const { map } = st();
    const ctx = map.ctx;
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = getNodeColor(n);
    shapePath(n, R, 0);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (map.selectedId === n.id) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = C.accent;
      shapePath(n, R, 3);
      ctx.stroke();
    }
    const by = R.y + R.h * PERSON_BODY;
    const body = { x: R.x, y: by, w: R.w, h: R.y + R.h - by };
    if (drawBubbleText(n, body, a, { detail: 'person', tags: [], ink: C.actorInk }).length) return;
    ctx.globalAlpha = a;
    ctx.fillStyle = C.ink;
    ctx.font = `600 11px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(n.name, R.x + R.w / 2, R.y + R.h + 4);
  }

  // A closed external: a box in the external colour with a shadow and a dashed outline, the name and its technology (C3 b838; "external system" when none), and only a
  // "Planned" pill when its plan status is planned (K 2026-11-16, Q4). An external that holds containers opens like any region.
  function drawExternal(n, R, a) {
    const ctx = st().map.ctx;
    const rad = Math.min(R.h / 2, 14);
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = getNodeColor(n);
    rr(R.x, R.y, R.w, R.h, rad);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.externalLine;
    ctx.setLineDash([5, 3]);
    rr(R.x, R.y, R.w, R.h, rad);
    ctx.stroke();
    ctx.setLineDash([]);
    drawOverlays(n, R, a, true);
    const planned = tagsFor(n).filter(t => t.t === STATUS.planned[0]);
    drawBubbleText(n, R, a, { detail: n.detail || 'external system', tags: planned, ink: C.actorInk }); // C3 (b838): the technology when set
  }

  // Board-item highlight (P16-B30b). map.hi = Set of lit c-item node ids, or null. 'direct' = this node
  // is lit or sits inside a lit node; 'contains' = a lit node sits inside this one (a closed container
  // rolls its children up); null = not involved or nothing lit.
  function hiState(n) {
    const { map } = st();
    if (!map.hi) return null;
    let contains = false;
    for (const l of map.hi) {
      if (n.id === l || within(n.id, l)) return 'direct';
      if (within(l, n.id)) contains = true;
    }
    return contains ? 'contains' : null;
  }

  // Is `id` a lit c-item or inside one? (tested on the un-rolled end of a data.edge)
  function inHi(id) {
    const { map } = st();
    if (!map.hi) return false;
    for (const l of map.hi) if (within(id, l)) return true;
    return false;
  }

  // Overlays drawn on top of a node's boxes, before its text: dashed attention border
  // (shared/unassigned/split-file slice), drift ring (selected only), critical-findings outline +
  // dot, stub hatch, selected accent outline. `rect` = the drawn screen rect (n._R); `alpha` = the
  // node's inherited alpha. Draw order and state handling are unchanged from when this lived inline
  // in the old single-pass drawNode; runs inside the save()/restore() of drawRegion / drawBubble.
  function drawOverlays(n, rect, alpha, closed) {
    const { map } = st();
    const ctx = map.ctx;
    const a = alpha;
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    const col = getNodeColor(n);
    const r = Math.min(10, Math.min(w, h) * 0.05);

    // Dashed-border treatment for nodes that need attention: auto-generated 'shared' code,
    // 'unassigned' code, and a 'slice' that groups a split file (ported from the mock's drawNode).
    if (n.kind === 'shared' || n.kind === 'unassigned' || (n.kind === 'slice' && isSplitFile(n))) {
      ctx.globalAlpha = a;
      ctx.setLineDash([10, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = n.kind === 'unassigned' ? RED_FG : AMBER_FG;
      rr(x, y, w, h, r);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw overlay: drift color
    if (st().overlays.drift && n.drift && map.selectedId === n.id) {
      const driftColor = C['drift_' + n.drift];
      if (driftColor) {
        ctx.globalAlpha = a;
        ctx.lineWidth = 2;
        ctx.strokeStyle = driftColor;
        rr(x - 3, y - 3, w + 6, h + 6, r + 3);
        ctx.stroke();
      }
    }

    // Draw overlay: findings (red dashed)
    if (st().overlays.findings && n.findings && n.findings.length > 0) {
      const hasCritical = n.findings.some(f => f.severity === 'critical');
      if (hasCritical) {
        ctx.globalAlpha = a;
        ctx.lineWidth = 2;
        ctx.strokeStyle = C.findings || '#FF0000';
        ctx.setLineDash([4, 4]);
        rr(x - 3, y - 3, w + 6, h + 6, r + 3);
        ctx.stroke();
        ctx.setLineDash([]);
        // Small red dot
        ctx.fillStyle = C.findings || '#FF0000';
        ctx.beginPath();
        ctx.arc(x + w - 6, y + 6, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw overlay: implemented components (b130). Thin ring in the screen colour on a component a screen calls (map.impl);
    // a closed container (`closed`: drawn as a bubble) rolls up its components. No dimming, nothing else changes.
    if (st().overlays.impl && map.impl && (map.impl.has(n.id) || (closed && map.implN[n.id]))) {
      ctx.globalAlpha = a;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = C.screen;
      if (!map.impl.has(n.id)) ctx.setLineDash([4, 3]);
      rr(x - 2, y - 2, w + 4, h + 4, r + 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw overlay: stubs (hatch)
    if (st().overlays.stubs && n.stub) {
      ctx.globalAlpha = a * 0.3;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      for (let i = 0; i < w; i += 8) {
        ctx.beginPath();
        ctx.moveTo(x + i, y);
        ctx.lineTo(x + i + h, y + h);
        ctx.stroke();
      }
      ctx.globalAlpha = a;
    }

    // Selected node accent outline
    if (map.selectedId === n.id) {
      ctx.globalAlpha = a;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = C.accent;
      rr(x - 3, y - 3, w + 6, h + 6, r + 3);
      ctx.stroke();
    }
  }

  const overlaps = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

  // b912: the width drawCountPills gives the pills of `n` at the top right of its box (same labels, fonts and 3 px gaps), for
  // a header subtitle to leave room. 0 when no pill is drawn.
  function countPillsWidth(n) {
    const ctx = st().map.ctx;
    const labels = [];
    if (isFoundation(n) && n.usedByCount > 0) labels.push([`400 10px ${MONO}`, 'used by ' + n.usedByCount]);
    if (st().overlays.board && n.boardCount > 0) labels.push([`700 10px ${SANS}`, String(n.boardCount)]);
    if (st().overlays.tests && n.tests && n.tests.count > 0) labels.push([`700 10px ${SANS}`, String(n.tests.count)]);
    const was = ctx.font;
    const total = labels.reduce((sum, [font, label]) => { ctx.font = font; return sum + Math.max(16, ctx.measureText(label).width + 8) + 3; }, 0);
    ctx.font = was;
    return total + (total ? 3 : 0);
  }

  // Count pills at the top right of a box, left of the findings dot when that is drawn. Right to left: board items
  // (P16-B29: ViewNode.boardCount, absent when 0 and on a page with no board), then tests (Phase 26 T26-10:
  // ViewNode.tests.count, the tests attached to the box or below it; outlined so the two never read as one).
  // T26-14c: drawn after the box's text; `text` = the rects that text covers (drawBubbleText, drawHeader). A pill that
  // would cover any of them is left out (a small box at container zoom), like other details of a small box: zoom in to
  // see it. A pill keeps its place (a hidden one keeps its slot), so nothing jumps while zooming.
  function drawCountPills(n, rect, alpha, text) {
    const showBoard = st().overlays.board && n.boardCount > 0;
    const showTests = st().overlays.tests && n.tests && n.tests.count > 0;
    const { x, y, w, h } = rect;
    const used = isFoundation(n) && n.usedByCount > 0 ? 'used by ' + n.usedByCount : '';   // b908
    if (!(used || showBoard || showTests) || w < 28 || h < 20) return;
    const ctx = st().map.ctx;
    const critical = st().overlays.findings && n.findings && n.findings.some(f => f.severity === 'critical');
    let right = x + w - 3 - (critical ? 14 : 0);
    ctx.globalAlpha = alpha;
    ctx.font = `700 10px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // one pill ending at `right`, drawn unless it covers text; the next pill goes left of its place either way
    const pill = (label, fill, ink, line) => {
      const pw = Math.max(16, ctx.measureText(label).width + 8), ph = 16;
      const box = { x: right - pw, y: y + 3, w: pw, h: ph };
      right = box.x - 3;
      if ((text || []).some(t => overlaps(box, t))) return;
      rr(box.x, box.y, pw, ph, ph / 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (line) { ctx.lineWidth = 1; ctx.strokeStyle = line; ctx.stroke(); }
      ctx.fillStyle = ink;
      ctx.fillText(label, box.x + pw / 2, box.y + ph / 2 + 0.5);
    };
    if (used) {   // b908: "used by N" in the box's hue, mono, no fill (K's option D badge)
      ctx.font = `400 10px ${MONO}`;
      pill(used, null, foundationHue(n), null);
      ctx.font = `700 10px ${SANS}`;
    }
    if (showBoard) pill(String(n.boardCount), C.accent, '#ffffff', null);
    if (showTests) pill(String(n.tests.count), C.testsSoft, C.tests, C.tests);
  }

  // ===== REGIONS =====
  // Header of an open region: name (+ '(stub)'), then "C-level tag · detail", with the pills on
  // the right. Header height comes from layout (n.headerH) scaled to screen units, so text never
  // overlaps the first child row; falls back to a fraction only for nodes never laid out.
  // Returns the rects the header text covers ([] when it is too small to draw).
  function drawHeader(n, x, y, w, h, alpha, col, k = 1) {
    const { map } = st();
    const ctx = map.ctx;
    const headH = typeof n.headerH === 'number'
      ? n.headerH * map.cam.s * k   // b858: k = the scale of the fill transform the region is drawn under (1: none)
      : h * (n.kind === 'component' ? 0.16 : 0.09);
    const pad = Math.min(w, h) * 0.04;
    const hs = Math.min(18, headH * 0.45);
    if (hs < 5) return [];
    const cy = y + headH * 0.62;
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${hs}px ${SANS}`;
    ctx.fillStyle = col;
    const label = stubLabel(n);
    ctx.fillText(label, x + pad, cy);
    const covered = [textRect(ctx, label, x + pad, cy, hs, 'left')];
    // b142: the region header word comes from the kind table (C4PM_MODE.region, mode.js)
    const levelTag = n.word ? n.word.toUpperCase() : window.C4PM_MODE && window.C4PM_MODE.region(n.kind);   // p27: an IO app carries its own word (CLI, API, MCP, App)
    const lead = levelTag ? levelTag + (n.detail ? '  ·  ' : '') : '';
    if (lead || n.detail) {
      const nw = covered[0].w;
      const sx = x + pad + nw + hs * 0.6;
      ctx.font = `500 ${hs * 0.7}px ${SANS}`;
      ctx.fillStyle = C.muted;
      // b912: the detail is fitted (b909) to the room left of the count pills, so the pills ("used by N", chips) are never covered by it
      const room = x + w - pad - sx - countPillsWidth(n) - ctx.measureText(lead).width;
      const sub = lead + (n.detail ? fitDetail(s => ctx.measureText(s).width, n.detail, room) : '');
      if (sub) {
        ctx.fillText(sub, sx, cy);
        covered.push(textRect(ctx, sub, sx, cy, hs * 0.7, 'left'));
      }
    }
    const tagRect = drawTags(n, x + w - pad, cy, hs * 0.72, alpha, 'right');
    if (tagRect) covered.push(tagRect);
    return covered;
  }

  // Ease a node's displayed openness toward its target and store the rect it is drawn at
  // (n._R, bubble -> region) and its alpha. Shared by the region pass. Demo: factor 0.25 per
  // frame, snap within 0.004.
  function stepNode(n, a, T) {
    const { map } = st();
    const CAM = window.C4PM_CAM;
    const target = CAM.openness(n);
    n._tv = n._tv == null ? target : n._tv + (target - n._tv) * 0.25;
    if (Math.abs(target - n._tv) < 0.004) n._tv = target; else map.animating = true;
    // b858: T = the fill transform of a following parent (camera.js followFill), null/undefined for every other box.
    // S2: a leaf of a following box gets its slot-sized card (camera.js leafCard) as the bubble end, before the transform.
    n._R = CAM.toScreen(CAM.xf(T, CAM.leafCard(n) || n.bubble || n), CAM.xf(T, n), n._tv);
    n._W = T ? CAM.xf(T, n) : null;   // b858: the world rect it is drawn at, when that is not its own
    map.alpha[n.id] = a;
    return n._R;
  }

  // PASS 1: open regions (blueprint fill, clipped grid, solid border, header), recursive. A node
  // that is closed or only partly open is queued in `bubbles` (drawn in pass 3, on top of edges).
  function drawRegion(n, a, bubbles, T) {
    const { map } = st();
    const ctx = map.ctx;
    const CAM = window.C4PM_CAM;
    const R = stepNode(n, a, T);
    const t = n._tv;
    // C1 A1 (b828): a holder (the C1 context) is never drawn: no fill, grid, border, header or bubble, and it is not an open
    // region (edit target). It still has its rect and alpha (stepNode), so rep() and the sim overlay walk through it.
    if (window.C4PM_MODE && window.C4PM_MODE.isHolder(n.kind)) {
      if (a >= 0.01 && n.children) n.children.forEach(c => drawRegion(c, a, bubbles, T));
      return;
    }
    // b786: a following code box (C4PM_CAM.follows) is drawn without its own fill, grid, border, header or bubble; its
    // children are drawn at its openness, inside the parent's region (same recursion guard as the open path below).
    // b858: when it is its parent's only child, its children fill the parent's body (C4PM_CAM.followFill): its drawn rect
    // (_R, _W) becomes the filled rect _D, culled there, and its children are drawn under the fill transform.
    if (CAM.follows(n)) {
      const ff = CAM.followFill(n, T, t);
      n._D = ff ? ff.D : null;
      if (ff) { n._R = CAM.toScreen(ff.D, ff.D, 1); n._W = ff.D; }
      if (a < 0.01 || CAM.offScreen(n._R)) return; // cull off-screen
      if (t > 0 && a * t > 0.02 && n.children) n.children.forEach(c => drawRegion(c, a * t, bubbles, ff ? ff.T : T));
      return;
    }
    if (a < 0.01 || CAM.offScreen(R)) return; // cull off-screen
    const x = R.x, y = R.y, w = R.w, h = R.h;
    const k = T ? T.k : 1;   // b858: the scale of the fill transform this region is drawn under

    if (t > 0) {
      const col = regionColor(n), rad = Math.min(16, w * 0.02);
      ctx.save();
      ctx.globalAlpha = a * t;
      ctx.fillStyle = C.bp;
      rr(x, y, w, h, rad);
      ctx.fill();
      // blueprint grid, clipped to the region; only the on-screen part is stroked
      ctx.save();
      rr(x, y, w, h, rad);
      ctx.clip();
      let step = 40 * map.cam.s * (n.scale || (n.w / 2000)) * k;
      while (step < 18) step *= 2;
      while (step > 40) step /= 2;
      ctx.strokeStyle = C.bpline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = x + Math.floor(Math.max(0, -x) / step) * step; gx < Math.min(x + w, map.cw); gx += step) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
      for (let gy = y + Math.floor(Math.max(0, -y) / step) * step; gy < Math.min(y + h, map.ch); gy += step) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = a * t;
      const lit = hiState(n);   // a selected board item touches this region or something inside it
      ctx.lineWidth = map.selectedId === n.id ? 3 : lit ? 2.6 : 1.6;
      ctx.strokeStyle = map.selectedId === n.id ? C.accent : lit ? BGLOW : isFoundation(n) ? foundationHue(n) : col;   // b908
      rr(x, y, w, h, rad);
      ctx.stroke();
      drawOverlays(n, R, a * t);
      const hdr = drawHeader(n, x, y, w, h, a * t, col, k);
      if (map.headerRects) map.headerRects.push(...hdr);   // b841: drawLabels keeps relation labels off the header text
      drawCountPills(n, R, a * t, hdr);
      ctx.restore();
      if (n.subregions) drawFrames(n, a * t);
      // open regions this frame, parents before children (edit targets). SR2: a drawn frame comes right after its container
      // and before the container's children, so it gets grips and edge-resize hits while an open child's edge still wins.
      if (t >= 0.5 && a >= 0.5) {
        map.opens.push(n);
        (n.subregions || []).forEach(l => { if (l._R && l.w > 0 && l.h > 0) map.opens.push(l); });
      }
      if (a * t > 0.02 && n.children) n.children.forEach(c => drawRegion(c, a * t, bubbles, T));
    }
    if (t < 1) bubbles.push({ n, R, a: a * (1 - t) });
  }

  // ===== SUBREGION FRAMES (Phase 28 LK-G) =====
  // A container's plan subregions (n.subregions) are notation, not a level: one frame per subregion around its components (an auto
  // frame gets its rect from edit.js placeFrames, so it follows an edit; a placed frame (SR2: saved layout, or moved/resized in edit
  // mode by its label band and its right/bottom edge) keeps its own rect), drawn on the open container's blueprint before its children, in the
  // subregion colour: a faint tint, a border, and in its label band the subregion title, then "SUBREGION · n components". Each
  // subregion gets a drawn rect (_R) and alpha like a node, so an edge that names a subregion ends on its frame (rep, scr) and a
  // click on the label band selects it (camera.js hitTest). Never a bubble, never opened, never a focus.
  const FRAME_TINT = 0.07;
  function drawFrames(n, a) {
    const { map } = st();
    const ctx = map.ctx;
    window.C4PM_EDIT.placeFrames(n);
    n.subregions.forEach(l => {
      if (!(l.w > 0 && l.h > 0)) return;
      const R = window.C4PM_CAM.toScreen(l, l, 1);
      l._R = R;
      map.alpha[l.id] = a;
      if (a < 0.01 || window.C4PM_CAM.offScreen(R)) return;
      const col = getNodeColor(l), lit = hiState(l), sel = map.selectedId === l.id;
      const rad = Math.min(12, R.w * 0.015);
      ctx.save();
      ctx.globalAlpha = a * FRAME_TINT;
      ctx.fillStyle = col;
      rr(R.x, R.y, R.w, R.h, rad);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.lineWidth = sel ? 3 : lit ? 2.6 : 1.6;
      ctx.strokeStyle = sel ? C.accent : lit ? BGLOW : col;
      rr(R.x, R.y, R.w, R.h, rad);
      ctx.stroke();
      const hd = (l.headerH || 0) * map.cam.s, fs = Math.min(16, hd * 0.55), pad = Math.min(R.w, hd) * 0.3;
      if (fs >= 5) {
        const cy = R.y + hd * 0.55;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${fs}px ${SANS}`;
        ctx.fillStyle = col;
        const label = stubLabel(l);
        ctx.fillText(label, R.x + pad, cy);
        const nw = ctx.measureText(label).width;
        const k = window.C4PM_EDIT.subregionMembers(n, l.id).length;
        const word = window.C4PM_MODE && window.C4PM_MODE.region(l.kind);
        const sub = (word ? word + '  ·  ' : '') + k + ' ' + (k === 1 ? 'component' : 'components') + (l.detail ? '  ·  ' + l.detail : '');
        ctx.font = `500 ${fs * 0.7}px ${SANS}`;
        ctx.fillStyle = C.muted;
        ctx.fillText(sub, R.x + pad + nw + fs * 0.6, cy);
        drawTags(l, R.x + R.w - pad, cy, fs * 0.72, a, 'right');
      }
      ctx.restore();
    });
  }

  // Edit mode: small grips on the right/bottom edge + corner of every open region (not the root).
  function drawHandles() {
    const { map } = st();
    const ctx = map.ctx;
    ctx.save();
    ctx.fillStyle = C.accent;
    ctx.globalAlpha = 0.9;
    map.opens.forEach(n => {
      if (window.C4PM_EDIT.isTop(n)) return; // a root or a holder's child (C1 B2 b832) has no grips
      const R = n._R, g = 5;
      // b925: all 4 edges (a bar at the middle) and all 4 corners (a square)
      [R.x, R.x + R.w].forEach(x => ctx.fillRect(x - g, R.y + R.h / 2 - 14, g * 2, 28));
      [R.y, R.y + R.h].forEach(y => ctx.fillRect(R.x + R.w / 2 - 14, y - g, 28, g * 2));
      [R.x, R.x + R.w].forEach(x => [R.y, R.y + R.h].forEach(y => ctx.fillRect(x - g, y - g, g * 2, g * 2)));
    });
    ctx.restore();
  }

  // ===== EDGES (arrows) =====
  // Roll up edges: find deepest visible box in family chain
  function rep(id) {
    const { map, nodeById } = st();
    let n = nodeById[id];
    if (!n) return null;
    const chain = [];
    for (let cur = n; cur; cur = cur.parent) chain.unshift(cur);
    let r = chain[0];
    for (const node of chain) {
      if ((map.alpha[node.id] || 0) >= 0.5) r = node;
      else break;
    }
    return r;
  }

  const isAnc = (a, b) => {
    if (!a || !b) return false;
    for (let n = b.parent; n; n = n.parent) if (n === a) return true;
    return false;
  };

  // Is `id` the node itself, or nested anywhere inside, `ancId`? Used to tell which end of an
  // edge sits inside the currently-selected node, so drawEdges can color it as outgoing/incoming.
  // Phase 28 LK-G: a component in a subregion (n.subregion) is within that subregion too, though the subregion is not its parent.
  function within(id, ancId) {
    const { nodeById } = st();
    for (let n = nodeById[id]; n; n = n.parent) if (n.id === ancId || n.subregion === ancId) return true;
    return false;
  }

  // b896: how many data.fileEdges a box (the parent of their cards) has, visible or not. Counted once per fileEdges array
  // and tree: the IO/storage views keep the same array (their data inherits it) but swap data.root and drop the card ids.
  let fileBox = { edges: null, root: null, count: new Map() };
  function fileBoxCount(box) {
    const { data, nodeById } = st();
    if (fileBox.edges !== data.fileEdges || fileBox.root !== data.root) {
      const count = new Map();
      (data.fileEdges || []).forEach(e => {
        const p = nodeById[e.from] && nodeById[e.from].parent;
        if (p) count.set(p.id, (count.get(p.id) || 0) + 1);
      });
      fileBox = { edges: data.fileEdges, root: data.root, count };
    }
    return box ? fileBox.count.get(box.id) || 0 : 0;
  }

  // Roll every data.edge up to the deepest currently-visible box on each end, de-duping by that
  // pair, and (when a node is selected) flag which rolled-up edges leave/enter it so drawEdges can
  // glow them. data.edges only ever has component ids (Decision §0.1: no function-level call graph exists yet).
  // b896: data.fileEdges (imports between file/slice cards of one box, flagged `file`) never roll up. A box with at most
  // FILE_ARROWS_ALL_MAX shows all; a bigger box only the arrows of the card holding the selection (it or a node inside).
  // b908: a foundation box shows the arrows into it while it is hovered, focused (camera focus) or selected: itself or a node inside it
  function foundationActive(F, focus) {
    const { map } = st();
    const holds = id => !!id && within(id, F.id);
    return holds(map.selectedId) || holds(map.hoverId) || (!!focus && holds(focus.id));
  }

  function visibleEdges() {
    const { map, data, nodeById } = st();
    const seen = new Map();
    if (!data.edges) return [];
    const anyF = foundationSlots().size > 0;   // b908
    const focus = anyF && window.C4PM_CAM.focusNode ? window.C4PM_CAM.focusNode() : null;
    data.edges.forEach(edge => {
      if (!nodeById[edge.from] || !nodeById[edge.to]) return;
      const A = rep(edge.from), B = rep(edge.to);
      if (!A || !B || A === B || isAnc(A, B) || isAnc(B, A)) return;
      const F = anyF && isFoundation(B) ? B : null;   // b908: the drawn end is a foundation box (its container closed: a normal arrow)
      if (F && !foundationActive(F, focus)) return;    // hidden until that box is hovered, focused or selected
      const k = A.id + '>' + B.id;
      if (!seen.has(k)) seen.set(k, { A, B, weights: [], labels: [], out: false, inn: false, rel: false, found: null });
      const v = seen.get(k);
      if (F) v.found = foundationHue(F);
      v.weights.push(edge.weight);
      // b234: a relation's own label (IO edges); C1 D1 (b835): an arch edge with a person or external end, all of its labels
      const own = edge.labels || (edge.labelled && edge.label ? [edge.label] : []);
      own.forEach(l => { if (v.labels.indexOf(l) < 0) v.labels.push(l); });
      if (map.hi && inHi(edge.from) && inHi(edge.to)) v.rel = true;   // both ends are lit c-items (P16-B30b)
      if (map.selectedId) {
        const fromIn = within(edge.from, map.selectedId);
        const toIn = within(edge.to, map.selectedId);
        if (fromIn && !toIn) v.out = true;
        if (toIn && !fromIn) v.inn = true;
      }
    });
    const sel = map.selectedId;
    (data.fileEdges || []).forEach(edge => {
      const A = nodeById[edge.from], B = nodeById[edge.to];   // IO/storage views use other trees: their nodeById drops these ids
      if (!A || !B || A === B || rep(edge.from) !== A || rep(edge.to) !== B) return;
      const k = 'f:' + A.id + '>' + B.id;
      if (seen.has(k)) return;
      const aHolds = !!sel && within(sel, A.id), bHolds = !!sel && within(sel, B.id);   // b896: the card or a node inside it is selected
      if (!aHolds && !bHolds && fileBoxCount(A.parent) > FILE_ARROWS_ALL_MAX) return;
      seen.set(k, { A, B, weights: [1], labels: [], out: aHolds && !bHolds, inn: bHolds && !aHolds, rel: false, file: true });
    });
    return [...seen.values()];
  }

  // Edge label box: height, longest width, and the two helpers that keep it between the cards.
  const LABEL_H = 20, LABEL_MAX_W = 220, LABEL_MIN_W = 36;
  // C1 D2 (b836): this frame's labels, filled by drawEdges and drawn by drawLabels: the labelled arrows ({ labels, p1, p2, hl }) and
  // the rects of the count labels drawEdges drew inline (a relation label keeps off them too).
  let queued = { labels: [], counts: [] };
  // Half-width available around (mx,my) for a box of half-height hh that must not touch any of the rects:
  // for each rect the box could meet vertically, the horizontal distance from mx to the rect's near side.
  function gapRoom(mx, my, hh, rects) {
    let room = Infinity;
    rects.forEach(r => {
      if (my + hh <= r.y || my - hh >= r.y + r.h) return;   // clear above or below: no limit from this rect
      const d = mx < r.x + r.w / 2 ? r.x - mx : mx - (r.x + r.w);
      room = Math.min(room, Math.max(0, d));
    });
    return room;
  }
  // `text` cut with an ellipsis to measure <= maxW; '' when even a short cut does not fit (the label is then left out).
  function fitText(ctx, text, maxW) {
    if (maxW < LABEL_MIN_W) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '';
  }

  // C1 D1 (b835): the text of a labelled arrow: the first label plus " +N" for the N other labels merged into it (K's Q1). The first
  // label is cut (fitText) so the whole text fits maxW; '' when even that does not fit. The hover title lists them all.
  function labelText(ctx, labels, maxW) {
    const more = labels.length > 1 ? ' +' + (labels.length - 1) : '';
    const first = fitText(ctx, labels[0], maxW - (more ? ctx.measureText(more).width : 0));
    return first ? first + more : '';
  }

  // Draw edges. `now` (an animation-frame timestamp) drives the glow pulse on edges touching the
  // selected node: cyan for edges leaving it, magenta for edges entering it (ported from the
  // mock's drawEdges); everything else dims once a selection exists, same as the mock.
  function drawEdges(now) {
    const { map } = st();
    const ctx = map.ctx;
    const glow = 7 + 6 * (0.5 + 0.5 * Math.sin((now || 0) / 220));
    const list = visibleEdges();
    map.edgeLabels = [];   // cut labels of this frame, for the hover title
    queued = { labels: [], counts: [] };   // C1 D2 (b836): this frame's labels for drawLabels

    ctx.save();
    // Dim edges first, highlighted ones drawn on top.
    list.sort((a, b) => (a.out || a.inn || a.rel ? 1 : 0) - (b.out || b.inn || b.rel ? 1 : 0)).forEach(({ A, B, weights, labels, out, inn, rel, file, found }) => {
      const ra = window.C4PM_CAM.scr(A), rb = window.C4PM_CAM.scr(B);
      const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
      const cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
      const dx = cb.x - ca.x, dy = cb.y - ca.y;
      const tA = Math.min(Math.abs(ra.w / 2 / (dx || 1)), Math.abs(ra.h / 2 / (dy || 1)));
      const tB = Math.min(Math.abs(rb.w / 2 / (dx || 1)), Math.abs(rb.h / 2 / (dy || 1)));
      if (!(tA + tB < 0.98)) return;

      const p1 = { x: ca.x + dx * tA, y: ca.y + dy * tA };
      const p2 = { x: cb.x - dx * tB, y: cb.y - dy * tB };
      const ang = Math.atan2(dy, dx);
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);

      const lit = rel ? BGLOW : out ? GLOW_OUT : inn ? GLOW_IN : null;
      const hl = found && inn ? found : lit;   // b908: the selected foundation box: its incoming arrows pulse in its hue (the GLOW_IN glow)
      const faint = !!found && !hl;            // only hovered or focused: faint, in the hue, no glow
      const dim = (map.selectedId || map.hi || map.sim) && !hl;   // Phase 25 (UI8): a selected s-item dims them too (labels hide)

      // b896: a file -> file import inside one box is thinner, finer-dashed, fainter, with a smaller head, no count
      ctx.globalAlpha = dim ? 0.25 : faint ? FOUND_EDGE_ALPHA : file ? 0.7 : 1;
      ctx.strokeStyle = ctx.fillStyle = hl || found || C.edge;  // C.edge: >=3:1 against --bp in both themes
      ctx.lineWidth = file ? (hl ? 2.2 : 1.4) : hl ? 2.6 : 2;
      ctx.shadowColor = hl || 'transparent';
      ctx.shadowBlur = hl ? glow : 0;
      if (file) ctx.setLineDash([3, 3]);
      else if (!hl) ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow
      const head = file ? ARROW * 0.7 : ARROW;
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - head * Math.cos(ang - 0.4), p2.y - head * Math.sin(ang - 0.4));
      ctx.lineTo(p2.x - head * Math.cos(ang + 0.4), p2.y - head * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      if (file) return;   // never a count or label box
      if (faint) return;  // b908: no count box on a faint foundation arrow (38 boxes on one hover)

      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (!(len > 90 && (totalWeight > 1 || labels.length) && !dim)) return;
      // C1 D2 (b836): a labelled arrow's label is drawn last, off every box (drawLabels, after the bubbles)
      if (labels.length) {
        queued.labels.push({ labels, p1, p2, hl });
        return;
      }
      // Count (weight > 1): the box sits on the middle of the visible edge and is cut (with an ellipsis) to the room between the
      // two rects (gapRoom), so it never covers a card; the full text is the canvas hover title (map.edgeLabels).
      const full = String(totalWeight);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      ctx.font = `400 11.5px ${SANS}`;
      const room = Math.min(LABEL_MAX_W, gapRoom(mx, my, LABEL_H / 2, [ra, rb]) * 2) - 12;
      const label = fitText(ctx, full, room);
      if (!label) return;
      const box = drawLabelBox(ctx, label, mx, my, hl);
      queued.counts.push(box);
      if (label !== full) map.edgeLabels.push({ ...box, full });
    });
    ctx.restore();
  }

  // One edge label box centred at (mx, my): the panel fill, a 1 px outline (the arrow's glow colour when lit), the text in the ink
  // colour. The caller sets ctx.font. Returns the box rect (screen px).
  function drawLabelBox(ctx, label, mx, my, hl) {
    const lw = ctx.measureText(label).width + 12;
    const box = { x: mx - lw / 2, y: my - LABEL_H / 2, w: lw, h: LABEL_H };
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.panel;
    rr(box.x, box.y, box.w, box.h, 5);
    ctx.fill();
    ctx.strokeStyle = hl || C.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my + 0.5);
    return box;
  }

  // C1 D2 (b836): the labels of the labelled arrows (queued by drawEdges), drawn last, after the bubbles (map.js pass 4), as the Phase
  // 25 demo does (demo-lines-ref.html drawLabels): each one is tried at LABEL_TS along its arrow and goes at the first spot that is
  // off every drawn box (`bubbles`: the closed boxes of this frame, persons and externals too), every count label and every earlier
  // label. A label with no free spot is left out. The full text (every label of the arrow) is the hover title (map.edgeLabels).
  const LABEL_TS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
  function drawLabels(bubbles) {
    const { map } = st();
    const ctx = map.ctx;
    const taken = bubbles.filter(b => b.a >= 0.01).map(b => b.R).concat(queued.counts, map.headerRects || []);   // b841: and the open regions' header text
    ctx.save();
    ctx.font = `400 11.5px ${SANS}`;
    queued.labels.forEach(({ labels, p1, p2, hl }) => {
      const label = labelText(ctx, labels, LABEL_MAX_W - 12);
      if (!label) return;
      const lw = ctx.measureText(label).width + 12, hh = LABEL_H / 2;
      const at = t => ({ x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t });
      const hit = (b, q) => q.x - lw / 2 < b.x + b.w && q.x + lw / 2 > b.x && q.y - hh < b.y + b.h && q.y + hh > b.y;
      const t = LABEL_TS.find(t => !taken.some(b => hit(b, at(t))));
      if (t === undefined) return;
      const q = at(t);
      const box = drawLabelBox(ctx, label, q.x, q.y, hl);
      taken.push(box);
      const full = labels.join('\n');
      if (label !== full) map.edgeLabels.push({ ...box, full });
    });
    ctx.restore();
  }

  window.C4PM_RENDER = {
    theme: { C: () => C, readColors, getNodeColor, regionColor, SANS, MONO, GLOW_OUT, GLOW_IN, BGLOW, BGLOW_INK, ARROW, STATUS },
    text: { rr, isSplitFile, tagsFor, drawTags, drawBubbleText, stubLabel, fitDetail },
    beans: { drawBubble, drawOverlays, drawCountPills, hiState, drawPerson, drawExternal, shapePath, isFoundation, foundationHue, foundationOf, drawFoundationBox },
    regions: { stepNode, drawRegion, drawHeader, drawFrames, drawHandles },
    edges: { rep, isAnc, within, inHi, foundationActive, visibleEdges, drawEdges, drawLabels, drawLabelBox, gapRoom, fitText, labelText },
  };
})();
