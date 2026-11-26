import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';
import type { ViewModel } from '../src/types';

// IO view step 5: the box family module (viewer/ioBoxes.js). Geometry only: measureText is a fake in the harness and the module
// must not need it, so these are checks on band.local / band.w / band.h written by measure().

type Row = { id: string; kind: string; title: string; depth: number; word?: string; meta?: { type?: string } };
const row = (id: string, kind: string, title: string, depth: number, extra: Partial<Row> = {}): Row => ({ id, kind, title, depth, ...extra });
const entry = (kind: string, fqn: string, title: string, parent: string | null, rows: Row[], method?: string) =>
  ({ e: { kind, fqn, uid: null, title, status: null, rank: 0, order: 0, parent, parts: [] }, io: { kind, rows, ...(method ? { method } : {}) } });

const ENTRIES = [
  entry('command', 'c.plan', 'plan', null, [row('c.plan.o', 'options', 'Options', 0), row('c.plan.o.a', 'flag', '--file', 1, { meta: { type: 'path' } }), row('c.plan.o.b', 'flag', '--dry-run', 1), row('c.plan.x', 'arg', '<target>', 0)]),
  entry('command', 'c.plan.gen', 'plan generate', 'c.plan', [row('c.plan.gen.a', 'flag', '--view <view>', 0), row('c.plan.gen.b', 'flag', '--force', 0)]),
  entry('command', 'c.plan.ls', 'plan list', 'c.plan', [row('c.plan.ls.a', 'flag', '--json', 0)]),
  entry('command', 'c.plan.rm', 'plan remove', 'c.plan', []),
  entry('command', 'c.init', 'init', null, [row('c.init.a', 'flag', '--yes', 0)]),
  entry('command', 'c.check', 'check', null, [row('c.check.a', 'flag', '--json', 0), row('c.check.b', 'flag', '--sprint <s>', 0)]),
];

function setup(): { win: any; band: any; ids: string[] } {
  const m = loadSample() as ViewModel & any;
  m.nav.groups.push({ fqn: 'c', title: 'CLI', technology: 'commander', word: 'CLI', entries: ENTRIES.map(x => x.e) });
  m.navView.root.children.push({ id: 'c', kind: 'container', name: 'CLI', detail: '', weight: 1, x: 0, y: 0, w: 1, h: 1, children: ENTRIES.map(x => ({ id: x.e.fqn, kind: 'screen', name: x.e.title, detail: '', weight: 1, children: [], x: 0, y: 0, w: 1, h: 1, io: x.io })) });
  const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop'] });
  const win = h.sandbox.window as any;
  const band = { family: 'command', group: m.nav.groups[2], entries: ENTRIES.map(x => x.e), io: Object.fromEntries(ENTRIES.map(x => [x.e.fqn, x.io])), edges: [], word: 'CLI', w: 0, h: 0, local: {} as Record<string, any>, x: 0, y: 0 };
  win.C4PM_IO_BOXES.measure(band);
  return { win, band, ids: Object.keys(band.local) };
}

const inside = (a: any, b: any) => a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 && a.x + a.w <= b.x + b.w + 1e-6 && a.y + a.h <= b.y + b.h + 1e-6;
const overlap = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('C4PM_IO_BOXES.measure', () => {
  const { band, win } = setup();
  const L = band.local;

  it('claims the box families and gives every entry and every row a rect', () => {
    expect(win.C4PM_IO_BOXES.families).toEqual(['command', 'route', 'tool']);
    ENTRIES.forEach(x => { expect(L[x.e.fqn]).toBeTruthy(); x.io.rows.forEach(r => expect(L[r.id]).toBeTruthy()); });
  });

  it('every row has a rect inside its box (a nested row inside its group, a group inside its entry)', () => {
    ENTRIES.forEach(x => x.io.rows.forEach((r, i) => {
      let owner = x.e.fqn;
      for (let j = i - 1; j >= 0; j--) if (x.io.rows[j].depth < r.depth) { owner = x.io.rows[j].id; break; }
      expect(inside(L[r.id], L[owner])).toBe(true);
    }));
  });

  it('a subcommand is inside its parent and after the parent\'s own rows', () => {
    ['c.plan.gen', 'c.plan.ls', 'c.plan.rm'].forEach(id => {
      expect(inside(L[id], L['c.plan'])).toBe(true);
      ENTRIES[0].io.rows.forEach(r => expect(L[id].y).toBeGreaterThanOrEqual(L[r.id].y + L[r.id].h - 1e-6));
    });
  });

  it('sibling boxes do not overlap (top-level entries, subcommands of one parent, rows of one box)', () => {
    const sets = [['c.plan', 'c.init', 'c.check'], ['c.plan.gen', 'c.plan.ls', 'c.plan.rm'], ['c.plan.o', 'c.plan.x', 'c.plan.gen', 'c.plan.ls', 'c.plan.rm'], ['c.plan.o.a', 'c.plan.o.b']];
    sets.forEach(s => s.forEach((a, i) => s.slice(i + 1).forEach(b => expect(overlap(L[a], L[b])).toBe(false))));
  });

  it('band size covers all boxes, the top-level ones are packed in rows (not one line)', () => {
    Object.keys(L).forEach(id => { expect(L[id].x + L[id].w).toBeLessThanOrEqual(band.w + 1e-6); expect(L[id].y + L[id].h).toBeLessThanOrEqual(band.h + 1e-6); expect(L[id].x).toBeGreaterThanOrEqual(0); });
    expect(Math.max(...['c.plan', 'c.init', 'c.check'].map(id => L[id].x + L[id].w))).toBe(band.w);
  });

  it('the core lays the band out too: the rects reach the navView nodes', () => {
    const r = win.C4PM_IOVIEW.rect('c.plan.gen'), p = win.C4PM_IOVIEW.rect('c.plan');
    expect(r && p && inside(r, p)).toBe(true);
  });
});
