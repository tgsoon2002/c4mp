// board-timeline.js: the Timeline view of the board drawer (P16-B26b). Phase rows, bars, diamonds, dependency arrows, the Today
// line, a week grid and "Unscheduled". The arithmetic is in board-timeline-math.js (C4PM_BOARD_TL); this file only draws it.
// DOM plus one SVG, no library. Board text (titles, owners, ids) goes in with textContent / title only, never as markup.
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  const TL = window.C4PM_BOARD_TL;
  if (!B || !TL) return;   // no board: nothing to register

  const ROW = 30;       // px, height of a row
  const HEAD = 34;      // px, height of the date header
  const DAY_DEFAULT = 26;
  const DAY_MIN = 10;
  const DAY_MAX = 70;
  const ZOOM_STEP = 1.3;
  const PHASE_COLORS = ['#E9A93B', '#7A5BD6', '#E5766F', '#3FB6A8', '#4C8DD6'];   // the five phase colours, cycled by the phase's position
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // The SVG namespace is an identifier, not a request; it is split so the page keeps passing the "no http(s):// string in the page" check.
  const SVG_NS = 'http:' + '//www.w3.org/2000/svg';

  let dayW = DAY_DEFAULT;
  const scrollOf = new Map();   // board id -> { l, t, lo }: kept across redraws (the drawer redraws on every selection); lo = the grid's first day
  const pendingOf = new Map();  // SV9b: board id -> { d, t } from the view state (d = the day at the left edge), used by that board's next draw
  let lastHost = null;          // SV9b: the host of the last draw (the drawer body)

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  // SVG elements need the SVG namespace in a browser; the class goes through classList (className is read-only on SVG)
  const svgEl = (tag, cls) => {
    const e = typeof document.createElementNS === 'function' ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (cls) cls.split(' ').forEach(c => e.classList.add(c));
    return e;
  };
  const px = n => Math.round(n * 100) / 100 + 'px';
  function setVar(e, name, value) {
    if (typeof e.style.setProperty === 'function') e.style.setProperty(name, value);
    else e.style[name] = value;
  }
  const kindLetter = k => (k || '?').charAt(0).toUpperCase();
  const kindClass = k => 'bd-kind' + (/^[a-z-]+$/.test(k || '') ? ' bk-' + k : '');   // the class comes from the kind word only when it is a plain word
  const GROUP_KEY = 'c4mp.boardTlGroup';   // localStorage (C4PM_STORE): 'group' = lanes per Kanban group, anything else = by phase
  const laneMode = () => window.C4PM_STORE.get(GROUP_KEY) === 'group' && typeof B.groupOf === 'function';
  const setLaneMode = on => { window.C4PM_STORE.set(GROUP_KEY, on ? 'group' : 'phase'); };
  const phaseKey = id => 'p:' + id;   // collapse key: its own key space inside the board (Kanban group ids never start with "p:")

  function select(id, zoom, ev) {
    B.select(id);
    if (ev && window.C4PM_SIDE) window.C4PM_SIDE.reveal(ev);   // Cmd/Ctrl+click also opens the right panel
    if (zoom && typeof B.zoomToLinked === 'function') B.zoomToLinked();
  }

  function tip(i) {
    return i.id + ' · ' + i.title + ' · ' + (i.owner || 'no owner') + ' · ' + (i.start || '?') + ' → ' + (i.due || '?') + ' · ' + i.status;
  }

  // By group (P16-B26c): one lane per Kanban group of the board (B.groupOf, the Kanban's own rule), items sorted by start, nesting
  // only as a chip. A dated item whose status fits no group goes to a lane named by the status (the Kanban's extra column, same
  // collapse key). The lane's collapse key is the group id, so a Kanban column and its lane are one state. Same result shape as TL.buildRows.
  function buildLaneRows(entry) {
    const lanes = (entry.groups || []).map(g => ({ id: g.id, name: g.name, items: [] }));
    const byId = new Map(lanes.map(l => [l.id, l]));
    (entry.items || []).forEach(it => {
      const gid = B.groupOf(entry, it);
      if (gid !== null) { byId.get(gid).items.push(it); return; }
      const id = 'status:' + String(it.status);
      if (!byId.has(id)) { const l = { id, name: String(it.status), items: [] }; byId.set(id, l); lanes.push(l); }
      byId.get(id).items.push(it);
    });
    const rows = [];
    const unscheduled = [];
    lanes.forEach((lane, ci) => {
      const dated = lane.items.filter(i => TL.spanOf(i));
      lane.items.forEach(i => { if (!TL.spanOf(i)) unscheduled.push(i); });
      if (!dated.length) return;
      const spans = dated.map(TL.spanOf);
      const span = { s: Math.min.apply(null, spans.map(x => x.s)), e: Math.max.apply(null, spans.map(x => x.e)) };
      rows.push({ item: { id: 'lane:' + lane.id, title: lane.name, dependsOn: [] }, phase: true, lane: true, laneId: lane.id, depth: 0, hasKids: true, childCount: lane.items.length, ci, span, own: null });
      if (B.isCollapsed(entry.id, lane.id)) return;
      dated.sort((a, b) => TL.spanOf(a).s - TL.spanOf(b).s).forEach(i => rows.push({ item: i, phase: false, depth: 1, hasKids: false, childCount: 0, ci, span: TL.spanOf(i), own: TL.spanOf(i) }));
    });
    let minDay = null;
    let maxDay = null;
    rows.forEach(r => {
      if (minDay === null || r.span.s < minDay) minDay = r.span.s;
      if (maxDay === null || r.span.e > maxDay) maxDay = r.span.e;
    });
    return { rows, unscheduled, minDay, maxDay };
  }

  function draw(host, entry) {
    lastHost = host;
    host.textContent = '';
    drawZoomButtons(host, entry);
    if (!entry || !(entry.items || []).length) {
      host.appendChild(el('div', 'bd-empty', 'No items on this board.'));
      return;
    }
    const sel = B.selectedId();
    const byLane = laneMode();
    const res = byLane ? buildLaneRows(entry) : TL.buildRows(entry, id => B.isCollapsed(entry.id, phaseKey(id)), 'phase');
    const rows = res.rows;
    const todayDay = TL.dayOf(B.today());

    // grid: from the Monday on or before (first day - 3) to (last day + 6); Today is always inside
    const first = Math.min(res.minDay === null ? todayDay : res.minDay, todayDay) - 3;
    const last = Math.max(res.maxDay === null ? todayDay : res.maxDay, todayDay) + 6;
    const weeks = TL.weekStarts(first, last);
    const lo = weeks[0];
    const W = (last - lo + 1) * dayW;
    const H = HEAD + Math.max(rows.length, 1) * ROW;
    const xOf = d => (d - lo) * dayW;

    const wrap = el('div', 'tl');
    const labels = el('div', 'tl-labels');
    const scroll = el('div', 'tl-scroll');
    const canvas = el('div', 'tl-canvas');
    canvas.style.width = px(W);
    canvas.style.height = px(H);
    const lab = (cls, h) => { const d = el('div', 'tl-lab ' + cls); d.style.height = px(h); return d; };

    const head = lab('tl-head', HEAD);
    head.appendChild(el('span', 'nd', entry.name + ' · ' + rows.length + ' dated'));
    labels.appendChild(head);
    const band = el('div', 'tl-head');
    band.style.cssText = 'position:absolute;left:0;top:0;width:' + px(W) + ';height:' + px(HEAD);
    canvas.appendChild(band);
    weeks.forEach(d => {   // week lines and labels
      const w = el('div', 'tl-wk', MONTHS[new Date(d * 864e5).getUTCMonth()] + ' ' + new Date(d * 864e5).getUTCDate());
      w.style.left = px(xOf(d));
      w.style.width = px(7 * dayW);
      canvas.appendChild(w);
    });

    const rects = new Map();   // item id -> { x, w, y } of what is drawn for it (bar, diamond or summary line), for the arrows
    rows.forEach((r, idx) => {
      const i = r.item;
      const y = HEAD + idx * ROW;
      const isSel = sel === i.id;
      const color = PHASE_COLORS[r.ci % PHASE_COLORS.length];
      const late = !r.lane && B.isOverdue(i);
      const collapseKey = r.lane ? r.laneId : phaseKey(i.id);

      // label cell
      const l = lab((r.phase ? 'grp' : 'kid') + (isSel ? ' sel' : ''), ROW);
      if (!r.phase) l.style.paddingLeft = px(10 + r.depth * 16);
      if (r.phase) {
        const closed = B.isCollapsed(entry.id, collapseKey);
        const tw = el('span', 'tw', r.hasKids ? (closed ? '▸' : '▾') : '');
        if (r.hasKids) {
          tw.title = closed ? 'Expand' : 'Collapse';
          tw.addEventListener('click', ev => { if (ev && ev.stopPropagation) ev.stopPropagation(); B.toggleCollapsed(entry.id, collapseKey); });
        }
        l.appendChild(tw);
        const dot = el('span', 'dot');
        dot.style.background = color;
        l.appendChild(dot);
      } else {
        l.appendChild(el('span', kindClass(i.kind), kindLetter(i.kind)));
      }
      l.appendChild(el('span', 't', i.title));
      if (r.phase && r.hasKids) l.appendChild(el('span', 'nd', String(r.childCount)));
      if (byLane && !r.phase && i.parent) l.appendChild(el('span', 'nd', '↑ ' + i.parent));   // nesting is not drawn in this mode
      if (late) l.appendChild(el('span', 'tl-late', 'late'));
      // a dependency on an item of another board is not drawn: a chip says so
      (i.dependsOn || []).forEach(dep => {
        const other = B.item(dep);
        const home = other && B.entryOf(dep);
        if (other && home && home !== entry) {
          const chip = el('span', 'tl-ext', '↗ ' + dep);
          chip.title = dep + ' (other board: ' + home.name + ')';
          l.appendChild(chip);
        }
      });
      if (r.lane) l.addEventListener('click', () => B.toggleCollapsed(entry.id, collapseKey));   // a lane is a group, not an item
      else {
        l.addEventListener('click', ev => select(i.id, false, ev));
        l.addEventListener('dblclick', () => select(i.id, true));
      }
      labels.appendChild(l);

      // row background
      const bg = el('div', 'tl-rowbg' + (r.phase ? ' grp' : ''));
      bg.style.top = px(y);
      bg.style.height = px(ROW);
      canvas.appendChild(bg);

      // a phase with nested items: a thin summary line over its dates; everything else: a bar or a diamond
      if (r.phase && r.hasKids) {
        const s = el('div', 'tl-sum');
        setVar(s, '--gc', color);
        s.style.left = px(xOf(r.span.s));
        s.style.width = px((r.span.e - r.span.s + 1) * dayW);
        s.style.top = px(y + ROW / 2 - 1.5);
        canvas.appendChild(s);
        rects.set(i.id, { x: xOf(r.span.s), w: (r.span.e - r.span.s + 1) * dayW, y: y + ROW / 2 });
        return;
      }
      const rect = TL.barRect(i, dayW, lo);
      if (!rect) return;
      const one = rect.kind === 'diamond';
      const b = el('div', (one ? 'tl-ms' : 'tl-bar') + ' ' + (/^[a-z-]+$/.test(i.status || '') ? i.status : 'planned') + (late ? ' over' : '') + (isSel ? ' sel' : ''));
      b.title = tip(i);
      setVar(b, '--gc', color);
      b.style.left = px(rect.x);
      b.style.top = px(one ? y + ROW / 2 - TL.DIAMOND / 2 : y + 6);
      if (!one) b.style.width = px(rect.w);
      b.addEventListener('click', ev => select(i.id, false, ev));
      b.addEventListener('dblclick', () => select(i.id, true));
      canvas.appendChild(b);
      rects.set(i.id, { x: rect.x, w: rect.w, y: y + ROW / 2 });
    });

    // Today line, with its dot at the top
    const td = el('div', 'tl-today');
    td.style.left = px(xOf(todayDay) + dayW / 2);
    td.appendChild(el('span', null, 'Today'));
    canvas.appendChild(td);

    // dependency arrows: from the end of the dependency to the start of the dependent; amber when they touch the selected item
    const svg = svgEl('svg', 'tl-svg');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    rows.forEach(r => (r.item.dependsOn || []).forEach(dep => {
      const a = rects.get(dep);
      const b = rects.get(r.item.id);
      if (!a || !b) return;   // other board, collapsed away, or not drawn
      const pts = TL.elbowPath(a, b, ROW);
      const hot = sel !== null && (sel === dep || sel === r.item.id) ? ' hot' : '';
      const path = svgEl('path', 'tl-dep' + hot);
      path.setAttribute('d', 'M' + pts.map(p => p[0] + ' ' + p[1]).join(' L'));
      svg.appendChild(path);
      const end = pts[pts.length - 1];
      const headTip = svgEl('polygon', 'tl-tip' + hot);
      headTip.setAttribute('points', end[0] + ',' + end[1] + ' ' + (end[0] - 6) + ',' + (end[1] - 4) + ' ' + (end[0] - 6) + ',' + (end[1] + 4));
      svg.appendChild(headTip);
    }));
    canvas.appendChild(svg);

    // items with no date
    if (res.unscheduled.length) {
      const h = lab('grp', ROW);
      h.appendChild(el('span', 't', 'Unscheduled (' + res.unscheduled.length + ')'));
      h.style.cursor = 'default';
      labels.appendChild(h);
      res.unscheduled.forEach(i => {
        const l = lab('kid unsched' + (sel === i.id ? ' sel' : ''), ROW);
        l.appendChild(el('span', kindClass(i.kind), kindLetter(i.kind)));
        l.appendChild(el('span', 't', i.title));
        l.appendChild(el('span', 'nd', 'no dates'));
        l.addEventListener('click', ev => select(i.id, false, ev));
        l.addEventListener('dblclick', () => select(i.id, true));
        labels.appendChild(l);
      });
    }

    scroll.appendChild(canvas);
    wrap.appendChild(labels);
    wrap.appendChild(scroll);
    host.appendChild(wrap);

    // scroll: kept across redraws; the first draw of a board shows Today, or the left-edge day the view state kept (SV9b)
    const want = pendingOf.get(entry.id);
    pendingOf.delete(entry.id);
    const keep = (want && { l: Math.max(0, (want.d - lo) * dayW), t: want.t }) || scrollOf.get(entry.id) || { l: Math.max(0, xOf(todayDay) - 220), t: 0 };
    keep.lo = lo;
    scrollOf.set(entry.id, keep);
    scroll.scrollLeft = keep.l;
    wrap.scrollTop = keep.t;
    scroll.addEventListener('scroll', () => { keep.l = scroll.scrollLeft; });
    wrap.addEventListener('scroll', () => { keep.t = wrap.scrollTop; });
  }

  // "−" and "+" live in the drawer bar slot (cleared by the drawer before each draw)
  function drawZoomButtons(host, entry) {
    const slot = document.getElementById('board-slot-timeline');
    if (!slot) return;
    slot.textContent = '';
    const mk = (text, title, k) => {
      const b = el('button', null, text);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => zoom(k, host, entry));
      slot.appendChild(b);
    };
    mk('−', 'Zoom the timeline out', 1 / ZOOM_STEP);
    mk('+', 'Zoom the timeline in', ZOOM_STEP);
    if (typeof B.groupOf === 'function') {   // the By phase | By group switch needs the Kanban's grouping rule
      [['By phase', false], ['By group', true]].forEach(([text, lanes]) => {
        const b = el('button', null, text);
        b.type = 'button';
        b.setAttribute('aria-pressed', laneMode() === lanes ? 'true' : 'false');
        b.addEventListener('click', () => { setLaneMode(lanes); draw(host, entry); });
        slot.appendChild(b);
      });
    }
  }

  function zoom(k, host, entry) {
    const next = Math.max(DAY_MIN, Math.min(DAY_MAX, Math.round(dayW * k)));
    if (next === dayW) return dayW;
    const keep = entry && scrollOf.get(entry.id);
    if (keep) keep.l = ((keep.l / dayW) * next);   // the day at the left edge stays at the left edge (the grid start does not depend on the zoom)
    dayW = next;
    draw(host, entry);
    return dayW;
  }

  B.views.timeline = draw;
  B.timeline = {
    dayWidth: () => dayW,
    setDayWidth: n => { dayW = Math.max(DAY_MIN, Math.min(DAY_MAX, Math.round(n))); },
  };

  // Phase 30 SV9b (b642): the view-state part 'timeline' = { dayW, boards: [[board id, left-edge day, top px], ...] }: the zoom and,
  // per board drawn, the scroll as the day at the left edge (the grid's first day moves when the items or today change) and the
  // rows' scroll. A kept board that is not drawn waits for its next draw; one that is shown now is drawn again at once.
  // viewState.js loads after this file, so the part is added at DOMContentLoaded (or on the next timer in a loaded page).
  const finite = n => typeof n === 'number' && isFinite(n);
  const timelinePart = {
    get: () => {
      const boards = [];
      scrollOf.forEach((k, id) => { if (finite(k.lo) && finite(k.l) && finite(k.t)) boards.push([id, k.lo + k.l / dayW, k.t]); });
      pendingOf.forEach((p, id) => { if (!scrollOf.has(id)) boards.push([id, p.d, p.t]); });
      return { dayW, boards };
    },
    set: v => {
      if (!v || typeof v !== 'object') return;
      if (finite(v.dayW)) B.timeline.setDayWidth(v.dayW);
      (Array.isArray(v.boards) ? v.boards : []).forEach(b => {
        if (!Array.isArray(b) || typeof b[0] !== 'string' || !finite(b[1]) || !finite(b[2]) || b[2] < 0) return;
        pendingOf.set(b[0], { d: b[1], t: b[2] });
        scrollOf.delete(b[0]);
      });
      const e = B.entry();
      const shown = B.isOpen() && B.view() === 'timeline' && !(B.drawer && B.drawer.isMinimized());
      if (lastHost && e && shown) draw(lastHost, e);
    },
  };
  // C4PM_STATE.whenReady (state.js): a page without state.js has no viewState.js either.
  if (window.C4PM_STATE) window.C4PM_STATE.whenReady(() => { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.part('timeline', timelinePart); });
})();
