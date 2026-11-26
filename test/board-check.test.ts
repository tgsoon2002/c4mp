import { checkBoard, isOverdue } from '../src/board/check';
import { parseBoard } from '../src/board/parse';
import type { Board, BoardFile, BoardItem, Plan, PlanElement } from '../src/types';

const TODAY = '2026-10-21';
const UID = '00000000-0000-4000-8000-000000000001';

function item(id: string, extra: Partial<BoardItem> = {}): BoardItem {
  return { id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...extra };
}
function board(id: string, items: BoardItem[], extra: Partial<Board> = {}): Board {
  return { id, name: id, items, ...extra };
}
function file(...boards: Board[]): BoardFile {
  return { schemaVersion: 1, boards };
}
function el(id: string, kind: string, uid?: string): PlanElement {
  return { id, kind, title: id, description: null, technology: null, links: [], metadata: uid ? { uid } : {}, parent: null, source: { file: 'a.c4', line: 1 } };
}
const PLAN: Plan = { files: ['a.c4'], elements: [el('app', 'system', UID), el('app.p', 'function', '00000000-0000-4000-8000-0000000000ff')], relations: [], issues: [] };

const rules = (f: BoardFile, plan: Plan | null = PLAN, today = TODAY) => checkBoard(f, plan, { today }).map((x) => `${x.rule}:${x.id}`);

describe('checkBoard', () => {
  it('a clean file has no findings', () => {
    const f = file(board('main', [item('b1', { links: [UID], start: '2026-10-01', due: '2026-10-30' }), item('b2', { parent: 'b1', dependsOn: ['b1'] })]));
    expect(checkBoard(f, PLAN, { today: TODAY })).toEqual([]);
  });

  it.each<[string, BoardFile, Plan | null, string[]]>([
    ['dead link', file(board('m', [item('b1', { links: ['nope'] })])), PLAN, ['board-dead-link:b1']],
    ['link to planned code is dead (not an element kind)', file(board('m', [item('b1', { links: ['00000000-0000-4000-8000-0000000000ff'] })])), PLAN, ['board-dead-link:b1']],
    ['unknown parent', file(board('m', [item('b1', { parent: 'zz' })])), PLAN, ['board-unknown-parent:b1']],
    ['parent in another board', file(board('m', [item('b1', { parent: 'b2' })]), board('n', [item('b2')])), PLAN, ['board-unknown-parent:b1']],
    ['unknown dependency', file(board('m', [item('b1', { dependsOn: ['zz'] })])), PLAN, ['board-unknown-dependency:b1']],
    ['dependency on another board is fine', file(board('m', [item('b1', { dependsOn: ['b2'] })]), board('n', [item('b2')])), PLAN, []],
    ['bad kind', file(board('m', [item('b1', { kind: 'epic' })])), PLAN, ['board-invalid-field:b1']],
    ['bad tag', file(board('m', [item('b1', { tags: ['api', 'Bad Tag'] })])), PLAN, ['board-invalid-field:b1']],
    ['good tags', file(board('m', [item('b1', { tags: ['api', 'v2-x', '3d'] })])), PLAN, []],
    ['bad status',file(board('m', [item('b1', { status: 'todo' })])), PLAN, ['board-invalid-field:b1']],
    ['unknown group', file(board('m', [item('b1', { group: 'x' })], { groups: [{ id: 'triage', name: 'Triage' }] })), PLAN, ['board-unknown-group:b1']],
    ['known custom group', file(board('m', [item('b1', { group: 'triage' })], { groups: [{ id: 'triage', name: 'Triage' }] })), PLAN, []],
    ['default group id without groups', file(board('m', [item('b1', { group: 'done' })])), PLAN, []],
    ['group with bad status', file(board('m', [], { groups: [{ id: 'g', name: 'G', status: 'blocked' }] })), PLAN, ['board-unknown-group:m']],
    ['due before start', file(board('m', [item('b1', { start: '2026-11-10', due: '2026-11-09' })])), PLAN, ['board-dates-reversed:b1']],
    ['due equal to start is fine', file(board('m', [item('b1', { start: '2026-11-10', due: '2026-11-10' })])), PLAN, []],
    ['overdue (past due, still open)', file(board('m', [item('b1', { due: '2026-10-20' })])), PLAN, ['board-overdue:b1']],
    ['due equal to today is not overdue', file(board('m', [item('b1', { due: TODAY })])), PLAN, []],
    ['done past due is not overdue', file(board('m', [item('b1', { due: '2026-10-01', status: 'done' })])), PLAN, []],
    ['plan null: one info, dead-link rule skipped', file(board('m', [item('b1', { links: ['a', 'b'] }), item('b2', { links: ['c'] })])), null, ['board-links-unchecked:board.json']],
    ['plan null and no links: nothing', file(board('m', [item('b1')])), null, []],
  ])('%s', (_name, f, plan, expected) => {
    expect(rules(f, plan)).toEqual(expected);
  });

  it('severity: overdue and unchecked are info, the rest warning', () => {
    const f = file(board('m', [item('b1', { due: '2026-10-01', links: ['x'] })]));
    const sev = (plan: Plan | null) => checkBoard(f, plan, { today: TODAY }).map((x) => `${x.rule}=${x.severity}`);
    expect(sev(PLAN)).toEqual(['board-dead-link=warning', 'board-overdue=info']);
    expect(sev(null)).toEqual(['board-links-unchecked=info', 'board-overdue=info']);
  });

  it('nesting cycle (including self parent) and dependsOn cycle, each reported once', () => {
    const f = file(board('m', [item('a', { parent: 'b' }), item('b', { parent: 'a' }), item('c', { parent: 'c' }), item('d', { dependsOn: ['e'] }), item('e', { dependsOn: ['d'] })]));
    expect(rules(f)).toEqual(['board-depends-cycle:d', 'board-nest-cycle:a', 'board-nest-cycle:c']);
  });

  it('a cross-board dependsOn cycle is found', () => {
    const f = file(board('m', [item('a', { dependsOn: ['b'] })]), board('n', [item('b', { dependsOn: ['a'] })]));
    expect(rules(f)).toEqual(['board-depends-cycle:a']);
  });

  it('a huge dependsOn cycle set reports ONE truncated finding', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const f = file(board('m', ids.map((id) => item(id, { dependsOn: ids.filter((x) => x !== id) }))));
    const out = checkBoard(f, PLAN, { today: TODAY });
    expect(out.filter((x) => x.rule === 'board-depends-cycle')).toHaveLength(100);
    const trunc = out.filter((x) => x.rule === 'board-cycles-truncated');
    expect(trunc).toHaveLength(1);
    expect(trunc[0].severity).toBe('info');
  });

  it('findings are sorted by severity, rule, id', () => {
    const f = file(board('m', [item('b2', { due: '2026-10-01' }), item('b1', { links: ['x'], due: '2026-10-01' }), item('b0', { kind: 'epic' })]));
    expect(rules(f)).toEqual(['board-dead-link:b1', 'board-invalid-field:b0', 'board-overdue:b1', 'board-overdue:b2']);
  });

  it('ids like __proto__ and constructor are ordinary ids', () => {
    const f = file(board('m', [
      item('__proto__', { dependsOn: ['constructor'], links: [UID] }),
      item('constructor', { parent: '__proto__', dependsOn: ['__proto__'] }),
      item('toString', { parent: 'hasOwnProperty' }),
    ]));
    // __proto__ <-> constructor is a depends cycle; 'hasOwnProperty' is not an item (must not be found on Object.prototype).
    expect(rules(f)).toEqual(['board-depends-cycle:__proto__', 'board-unknown-parent:toString']);
  });

  it('the same __proto__ ids survive parseBoard', () => {
    const text = JSON.stringify({ schemaVersion: 1, boards: [{ id: 'm', name: 'M', items: [{ id: '__proto__', title: 't', kind: 'task', status: 'planned' }, { id: 'x', title: 't', kind: 'task', status: 'planned', parent: 'constructor' }] }] });
    const p = parseBoard(text);
    expect(p.issues).toEqual([]);
    expect(rules(p.data!)).toEqual(['board-unknown-parent:x']);
  });
});

describe('isOverdue', () => {
  it('needs a due date before today and an unfinished status', () => {
    expect(isOverdue(item('a', { due: '2026-10-20' }), TODAY)).toBe(true);
    expect(isOverdue(item('a'), TODAY)).toBe(false);
    expect(isOverdue(item('a', { due: '2026-10-20', status: 'abandoned' }), TODAY)).toBe(false);
  });
});
