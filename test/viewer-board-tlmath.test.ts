import { boardPage } from './helpers/viewer-board-fixture';

// P16-B26a: the pure timeline math (window.C4PM_BOARD_TL).

const p = boardPage();
const TL: any = p.sandbox.C4PM_BOARD_TL;
const mk = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: 'T' + id, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], linked: [], deadLinks: [], ...extra });
const entry = (items: any[]) => ({ id: 'e', name: 'E', groups: [], items });
const ids = (rows: any[]) => rows.map(r => r.item.id);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('P16-B26a timeline math', () => {
  it('is absent on a page with no board', () => {
    expect(boardPage({ board: false }).sandbox.C4PM_BOARD_TL).toBeUndefined();
    expect(typeof TL.buildRows).toBe('function');
  });

  it.each([
    ['1970-01-01', 0],
    ['1970-01-02', 1],
    ['1969-12-31', -1],
    ['2026-10-12', 20738],
    ['2024-02-29', 19782],
  ])('dayOf/isoOf %s = day %i and back', (iso, day) => {
    expect(TL.dayOf(iso)).toBe(day);
    expect(TL.isoOf(day)).toBe(iso);
  });

  it.each(['', 'x', '2026-13-01', '2026-02-31', '2026-1-1', null, undefined, 20])('dayOf(%p) is NaN', v => {
    expect(Number.isNaN(TL.dayOf(v))).toBe(true);
  });

  it('weeks start on Monday: 2026-10-12 is one, 2026-10-11 and 10-13 are not', () => {
    expect(TL.isMonday(TL.dayOf('2026-10-12'))).toBe(true);
    expect(TL.isMonday(TL.dayOf('2026-10-11'))).toBe(false);
    expect(TL.isMonday(TL.dayOf('2026-10-13'))).toBe(false);
    expect(TL.isMonday(TL.dayOf('1969-12-29'))).toBe(true);   // a Monday before 1970
    const weeks = TL.weekStarts(TL.dayOf('2026-10-14'), TL.dayOf('2026-10-27'));
    expect(weeks.map(TL.isoOf)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);   // the first is on or before `from`
    expect(TL.weekStarts(TL.dayOf('2026-10-12'), TL.dayOf('2026-10-12')).map(TL.isoOf)).toEqual(['2026-10-12']);
  });

  it.each([
    // item dates, dayW, expected rect
    [{ start: '2026-10-12', due: '2026-10-15' }, 10, { x: 0, w: 40, kind: 'bar' }],          // due day inclusive: 4 days
    [{ start: '2026-10-14', due: '2026-10-14' }, 26, { x: 2 * 26 + 13 - 7, w: 14, kind: 'diamond' }],   // start = due
    [{ due: '2026-10-13' }, 20, { x: 20 + 10 - 7, w: 14, kind: 'diamond' }],                 // one date only
    [{ start: '2026-10-13' }, 20, { x: 20 + 10 - 7, w: 14, kind: 'diamond' }],
    [{ start: '2026-10-15', due: '2026-10-12' }, 20, { x: 3 * 20 + 10 - 7, w: 14, kind: 'diamond' }],   // due before start: one day
    [{ start: '2026-10-10', due: '2026-10-11' }, 30, { x: -2 * 30, w: 60, kind: 'bar' }],    // before the origin: negative x
  ])('barRect %j at %ipx a day', (dates, dayW, want) => {
    expect(plain(TL.barRect(mk('a', dates), dayW, TL.dayOf('2026-10-12')))).toEqual(want);
  });

  it('barRect of an item with no date is null', () => {
    expect(TL.barRect(mk('a'), 26, 0)).toBeNull();
    expect(TL.barRect(mk('a', { start: 'soon' }), 26, 0)).toBeNull();
  });

  it('elbowPath with room goes right, vertical, right; without room it goes through the gap between the rows', () => {
    const from = { x: 100, w: 50, y: 45 };
    expect(plain(TL.elbowPath(from, { x: 166, w: 40, y: 75 }, 30))).toEqual([[150, 45], [158, 45], [158, 75], [166, 75]]);   // 16px = room
    expect(plain(TL.elbowPath(from, { x: 165, w: 40, y: 75 }, 30))).toEqual([[150, 45], [158, 45], [158, 60], [157, 60], [157, 75], [165, 75]]);   // 15px: no room, gap below
    expect(plain(TL.elbowPath({ x: 100, w: 50, y: 75 }, { x: 120, w: 40, y: 45 }, 30))).toEqual([[150, 75], [158, 75], [158, 60], [112, 60], [112, 45], [120, 45]]);   // dependent above: gap above
  });

  describe('buildRows', () => {
    const items = [
      mk('p1', { start: '2026-10-12', due: '2026-10-14' }),
      mk('c1', { parent: 'p1', start: '2026-10-15', due: '2026-10-20' }),
      mk('c2', { parent: 'p1', due: '2026-10-22' }),          // one date: a diamond row
      mk('c3', { parent: 'p1' }),                              // undated child
      mk('g1', { parent: 'c1', start: '2026-10-16', due: '2026-10-17' }),   // grandchild
      mk('p2', { start: '2026-11-02', due: '2026-11-04' }),   // phase without children: its own bar
      mk('p3'),                                                 // undated phase, no dated children
      mk('p3k', { parent: 'p3' }),
      mk('p4'),                                                 // undated phase with a dated child: phase row, summary of the child
      mk('p4k', { parent: 'p4', start: '2026-10-01', due: '2026-10-02' }),
      mk('orphan', { parent: 'not-on-this-board', start: '2026-10-05', due: '2026-10-06' }),   // parent elsewhere: treated as top level
    ];

    it('orders phases and their dated children depth-first, with the summary span, colours and the unscheduled list', () => {
      const r = TL.buildRows(entry(items), null, 'phase');
      expect(ids(r.rows)).toEqual(['p1', 'c1', 'g1', 'c2', 'p2', 'p4', 'p4k', 'orphan']);
      expect(plain(r.rows.map((x: any) => [x.item.id, x.phase, x.depth, x.hasKids, x.ci]))).toEqual([
        ['p1', true, 0, true, 0], ['c1', false, 1, true, 0], ['g1', false, 2, false, 0], ['c2', false, 1, false, 0],
        ['p2', true, 0, false, 1], ['p4', true, 0, true, 3], ['p4k', false, 1, false, 3], ['orphan', true, 0, false, 4],   // ci = index among ALL top-level items, so undated p3 keeps its colour slot
      ]);
      const span = (id: string) => plain(r.rows.find((x: any) => x.item.id === id).span);
      expect(span('p1')).toEqual({ s: TL.dayOf('2026-10-12'), e: TL.dayOf('2026-10-22') });   // min start .. max due of the subtree
      expect(span('p2')).toEqual({ s: TL.dayOf('2026-11-02'), e: TL.dayOf('2026-11-04') });   // own bar
      expect(span('p4')).toEqual({ s: TL.dayOf('2026-10-01'), e: TL.dayOf('2026-10-02') });
      expect(r.rows.find((x: any) => x.item.id === 'p4').own).toBeNull();
      expect(r.unscheduled.map((i: any) => i.id)).toEqual(['c3', 'p3', 'p3k']);
      expect(r.minDay).toBe(TL.dayOf('2026-10-01'));
      expect(r.maxDay).toBe(TL.dayOf('2026-11-04'));
    });

    it('a collapsed phase drops its child rows but keeps undated children in Unscheduled; Set and function both work', () => {
      const viaSet = TL.buildRows(entry(items), new p.sandbox.Set(['p1']), 'phase');
      const viaFn = TL.buildRows(entry(items), (id: string) => id === 'p1', 'phase');
      for (const r of [viaSet, viaFn]) {
        expect(ids(r.rows)).toEqual(['p1', 'p2', 'p4', 'p4k', 'orphan']);
        expect(r.rows[0].hasKids).toBe(true);
        expect(r.rows[0].childCount).toBe(3);
        expect(plain(r.rows[0].span)).toEqual({ s: TL.dayOf('2026-10-12'), e: TL.dayOf('2026-10-22') });   // the summary is unchanged
        expect(r.unscheduled.map((i: any) => i.id)).toEqual(['c3', 'p3', 'p3k']);
      }
    });

    it('no dated item: no rows, null range, everything unscheduled; empty board and missing entry do not throw', () => {
      const r = TL.buildRows(entry([mk('a'), mk('b', { parent: 'a' })]), null, 'phase');
      expect(r.rows).toEqual([]);
      expect(r.minDay).toBeNull();
      expect(r.maxDay).toBeNull();
      expect(r.unscheduled.map((i: any) => i.id)).toEqual(['a', 'b']);
      expect(TL.buildRows(entry([]), null, 'phase').rows).toEqual([]);
      expect(TL.buildRows(null, null, 'phase').rows).toEqual([]);
    });

    it('ids like __proto__ and a nest cycle in a broken file do not break or loop', () => {
      const r = TL.buildRows(entry([
        mk('__proto__', { start: '2026-10-12', due: '2026-10-13' }),
        mk('k', { parent: '__proto__', start: '2026-10-14', due: '2026-10-15' }),
        mk('x', { parent: 'y', start: '2026-10-12' }),   // x and y nest each other: never reached from a top level
        mk('y', { parent: 'x', start: '2026-10-12' }),
        mk('self', { parent: 'self', start: '2026-10-12' }),
      ]), null, 'phase');
      expect(ids(r.rows)).toEqual(['__proto__', 'k', 'self']);
    });
  });
});
