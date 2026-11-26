// board-timeline-math.js: the pure arithmetic of the Timeline view (P16-B26a). No DOM, no state: dates to days,
// weeks, rows, bar rectangles and the elbow of a dependency arrow. board-timeline.js (B26b) draws what this returns.
// Attached as window.C4PM_BOARD_TL, and only when the board exists (the page of a repo with no board is unchanged).
(function () {
  'use strict';
  if (!window.C4PM_BOARD) return;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MS_DAY = 864e5;

  // Whole days since 1970-01-01, UTC arithmetic (no local time, no daylight saving). NaN for anything that is not a real date.
  function dayOf(iso) {
    if (typeof iso !== 'string' || !DATE_RE.test(iso)) return NaN;
    const t = Date.parse(iso + 'T00:00:00Z');
    if (Number.isNaN(t)) return NaN;
    const day = Math.round(t / MS_DAY);
    return isoOf(day) === iso ? day : NaN;   // 2026-02-31 parses in some engines; the round trip rejects it
  }

  // Inverse of dayOf: 'YYYY-MM-DD'.
  function isoOf(day) {
    return new Date(day * MS_DAY).toISOString().slice(0, 10);
  }

  // 1970-01-01 was a Thursday, so day d is a Monday exactly when (d + 3) % 7 === 0.
  const isMonday = d => (((d + 3) % 7) + 7) % 7 === 0;

  // The Mondays that cover fromDay..toDay: the first is the Monday on or before fromDay (so the grid starts on a week line).
  function weekStarts(fromDay, toDay) {
    let d = fromDay;
    while (!isMonday(d)) d--;
    const out = [];
    for (; d <= toDay; d += 7) out.push(d);
    return out;
  }

  // The days an item covers: {s, e} (both inclusive) or null. One date only is a one-day item; due before start is read as one day.
  function spanOf(item) {
    if (!item) return null;
    const a = dayOf(item.start);
    const b = dayOf(item.due);
    const s = Number.isNaN(a) ? b : a;
    const e = Number.isNaN(b) ? a : b;
    if (Number.isNaN(s)) return null;
    return { s, e: e < s ? s : e };
  }

  // Is `collapsed` (a function of the item id, or a Set/Map of item ids) set for this phase?
  function isClosed(collapsed, id) {
    if (!collapsed) return false;
    if (typeof collapsed === 'function') return !!collapsed(id);
    if (typeof collapsed.has === 'function') return collapsed.has(id);
    return false;
  }

  // The ordered rows of one board (entry = a ViewBoardEntry).
  // mode 'phase' (the only one so far): every top-level item (no parent in this board) is a phase row, followed by its
  // nested items that have dates, in file order, depth-first. A phase with nested items draws a summary line over the dates of
  // the whole subtree; a phase without any draws its own bar. A collapsed phase has no child rows.
  // Returns { rows, unscheduled, minDay, maxDay }:
  //   rows: { item, phase, depth, hasKids, childCount, ci, span, own }   (ci = colour index of the phase, stable; span = what is drawn; own = the item's own span or null)
  //   unscheduled: items with neither start nor due (listed whether or not their phase is collapsed), except a top-level item
  //     whose subtree has dates (that one is a row)
  //   minDay / maxDay: the first and last day any row covers; null when there are no rows
  function buildRows(entry, collapsed, mode) {
    const items = (entry && entry.items) || [];
    const ids = new Set(items.map(i => i.id));
    const kids = new Map();   // item id -> [child item]; Map: '__proto__' is a legal id
    const tops = [];
    items.forEach(it => {
      if (it.parent && ids.has(it.parent) && it.parent !== it.id) {
        if (!kids.has(it.parent)) kids.set(it.parent, []);
        kids.get(it.parent).push(it);
      } else tops.push(it);   // no parent, a parent that is not on this board, or its own parent
    });
    const kidsOf = it => kids.get(it.id) || [];
    // the item plus all its descendants; `seen` stops a nest cycle in a broken file
    function subtree(it, seen) {
      const out = [it];
      seen.add(it.id);
      kidsOf(it).forEach(k => { if (!seen.has(k.id)) subtree(k, seen).forEach(x => out.push(x)); });
      return out;
    }

    const rows = [];
    const unscheduled = [];
    void mode;   // 'phase' is the only grouping; B26c adds the lanes
    tops.forEach((top, ci) => {
      const all = subtree(top, new Set());
      const spans = all.map(spanOf).filter(Boolean);
      if (!spans.length) { all.forEach(i => unscheduled.push(i)); return; }
      const hasKids = kidsOf(top).length > 0;
      const own = spanOf(top);
      const span = hasKids || !own
        ? { s: Math.min.apply(null, spans.map(x => x.s)), e: Math.max.apply(null, spans.map(x => x.e)) }
        : own;
      rows.push({ item: top, phase: true, depth: 0, hasKids, childCount: kidsOf(top).length, ci, span, own });
      const closed = isClosed(collapsed, top.id);
      const seen = new Set([top.id]);
      (function walk(parent, depth) {
        kidsOf(parent).forEach(k => {
          if (seen.has(k.id)) return;
          seen.add(k.id);
          const sp = spanOf(k);
          if (sp && !closed) rows.push({ item: k, phase: false, depth, hasKids: kidsOf(k).length > 0, childCount: kidsOf(k).length, ci, span: sp, own: sp });
          else if (!sp) unscheduled.push(k);
          walk(k, depth + 1);
        });
      })(top, 1);
    });

    let minDay = null;
    let maxDay = null;
    rows.forEach(r => {
      if (minDay === null || r.span.s < minDay) minDay = r.span.s;
      if (maxDay === null || r.span.e > maxDay) maxDay = r.span.e;
    });
    return { rows, unscheduled, minDay, maxDay };
  }

  const DIAMOND = 14;   // px, width of a one-day marker

  // The rectangle of an item in px: { x, w, kind }. The due day is inclusive, so 2026-10-12..2026-10-15 is 4 days wide.
  // A one-day item (one date, or start = due) is a diamond of 14px centred on its day. null for an item with no date.
  function barRect(item, dayW, originDay) {
    const sp = spanOf(item);
    if (!sp) return null;
    const x0 = (sp.s - originDay) * dayW;
    if (sp.s === sp.e) return { x: x0 + dayW / 2 - DIAMOND / 2, w: DIAMOND, kind: 'diamond' };
    return { x: x0, w: (sp.e - sp.s + 1) * dayW, kind: 'bar' };
  }

  // The dependency arrow as a list of [x, y] points, from the end of the dependency's rectangle to the start of the dependent's.
  // Rectangles are { x, w, y } with y = the centre of the row. With room (>= 16px between them): right 8px, down (or up), right into
  // the start. Without room: right 8px, vertical to the gap between the two rows, back left of the start, then down and right in.
  function elbowPath(fromRect, toRect, rowH) {
    const ax = fromRect.x + fromRect.w;
    const ay = fromRect.y;
    const bx = toRect.x;
    const by = toRect.y;
    if (bx - ax >= 16) return [[ax, ay], [ax + 8, ay], [ax + 8, by], [bx, by]];
    const gap = by > ay ? ay + rowH / 2 : ay - rowH / 2;
    return [[ax, ay], [ax + 8, ay], [ax + 8, gap], [bx - 8, gap], [bx - 8, by], [bx, by]];
  }

  window.C4PM_BOARD_TL = { dayOf, isoOf, weekStarts, buildRows, barRect, elbowPath, spanOf, isMonday, DIAMOND };
})();
