import type { BoardFile, BoardItem } from '../src/types';
import { addGroup, deleteBoard, expandBulk, groupSlug, isOpError, mintItemIds, moveItem, orderGroups, removeGroup, removeItem, renameBoard, setBoardArchived } from '../src/board/ops';
import type { OpOk, OpResult, BulkOk } from '../src/board/ops';

// P18-PB1: pure board operations, on a two-board fixture.

const TODAY = '2026-10-23';
const O = { today: TODAY };

const it1 = (id: string, over: Partial<BoardItem> = {}): BoardItem =>
  ({ id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...over });

function fixture(): BoardFile {
  return {
    schemaVersion: 1,
    boards: [
      {
        id: 'main', name: 'Main',
        groups: [{ id: 'planned', name: 'Planned', status: 'planned' }, { id: 'triage', name: 'Needs triage' }],
        items: [
          it1('b1', { kind: 'feature' }),
          it1('b2', { parent: 'b1' }),
          it1('b3', { parent: 'b2' }),
          it1('b4', { dependsOn: ['b3'] }),
          it1('b5', { group: 'triage' }),
          it1('b6'),
        ],
      },
      { id: 'other', name: 'Other', items: [it1('b7', { dependsOn: ['b6'] })] },
      { id: 'old', name: 'Old', archived: true, items: [] },
    ],
  };
}

const ok = (r: OpResult): OpOk => { if (isOpError(r)) throw new Error(`${r.error}\n${r.reasons.join('\n')}`); return r; };
const err = (r: OpResult) => { if (!isOpError(r)) throw new Error('expected a refusal'); return r; };
const ids = (f: BoardFile, board: string) => f.boards.find((b) => b.id === board)!.items.map((i) => i.id).sort();

describe('removeItem', () => {
  it('removes a free item and leaves the input alone', () => {
    const f = fixture();
    const r = ok(removeItem(f, 'b5', O));
    expect(ids(r.file, 'main')).not.toContain('b5');
    expect(ids(f, 'main')).toContain('b5');
  });
  it('is blocked by a dependent (also in another board) and by a child, listing them', () => {
    expect(err(removeItem(fixture(), 'b6', O)).reasons).toEqual(['b7 depends on b6']);
    expect(err(removeItem(fixture(), 'b1', O)).reasons).toEqual(['b2 is nested under b1']);
    expect(err(removeItem(fixture(), 'zz', O)).error).toContain("no item 'zz'");
  });
});

describe('renameBoard', () => {
  it('changes the id and the name, items keep their ids, input untouched', () => {
    const f = fixture();
    const r = ok(renameBoard(f, 'main', { id: 'core', name: 'Core' }, O));
    expect(r.file.boards[0].id).toBe('core');
    expect(r.file.boards[0].name).toBe('Core');
    expect(ids(r.file, 'core')).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    expect(r.lines.join('\n')).toContain("id 'main' -> 'core'");
    expect(f.boards[0].id).toBe('main');
  });
  it('changes only the name, and renames an archived board', () => {
    expect(ok(renameBoard(fixture(), 'other', { name: 'Elsewhere' }, O)).file.boards[1]).toMatchObject({ id: 'other', name: 'Elsewhere' });
    expect(ok(renameBoard(fixture(), 'old', { id: 'older' }, O)).file.boards[2]).toMatchObject({ id: 'older', archived: true });
  });
  it('refuses a missing board, nothing to change, a used or invalid id, an empty name, no difference', () => {
    expect(err(renameBoard(fixture(), 'nope', { name: 'X' }, O)).error).toContain("no board 'nope'");
    expect(err(renameBoard(fixture(), 'main', {}, O)).error).toContain('say what to change');
    expect(err(renameBoard(fixture(), 'main', { id: 'other' }, O)).error).toContain("'other' already exists");
    expect(err(renameBoard(fixture(), 'main', { id: '1 bad' }, O)).error).toContain('must match');
    expect(err(renameBoard(fixture(), 'main', { name: '  ' }, O)).error).toContain('must not be empty');
    expect(err(renameBoard(fixture(), 'main', { id: 'main', name: 'Main' }, O)).error).toContain('nothing changed');
  });
});

describe('moveItem', () => {
  it('moves the nest (descendants by parent), keeps ids, sets updated, input untouched', () => {
    const f = fixture();
    const r = ok(moveItem(f, 'b1', 'other', O));
    expect(ids(r.file, 'other')).toEqual(['b1', 'b2', 'b3', 'b7']);
    expect(ids(r.file, 'main')).toEqual(['b4', 'b5', 'b6']);
    expect(r.file.boards[1].items.find((i) => i.id === 'b3')!.updated).toBe(TODAY);
    expect(r.file.boards[1].items.find((i) => i.id === 'b7')!.updated).toBeUndefined();
    expect(r.lines.join('\n')).toContain('moves with it (2): b2, b3');
    expect(ids(f, 'main')).toContain('b1');
  });
  it('refuses a missing or archived board, the same board, an unknown item', () => {
    expect(err(moveItem(fixture(), 'b6', 'nope', O)).error).toContain("no board 'nope'");
    expect(err(moveItem(fixture(), 'b6', 'old', O)).error).toBe("board 'old' is archived; unarchive it first (c4mp board unarchive old)");   // b443
    expect(err(moveItem(fixture(), 'b6', 'main', O)).error).toContain('already in');
    expect(err(moveItem(fixture(), 'zz', 'other', O)).error).toContain("no item 'zz'");
  });
  it('refuses when the item keeps a group the target board lacks (new board-unknown-group)', () => {
    const r = err(moveItem(fixture(), 'b5', 'other', O));
    expect(r.reasons[0]).toContain("group 'triage' is not a group of board 'other'");
  });
  it('does not blame the move for a problem the file already had', () => {
    const f = fixture();
    f.boards[0].items.push(it1('b9', { dependsOn: ['ghost'] }));
    ok(moveItem(f, 'b6', 'other', O));
  });
  it('a nested item moves alone; both nest links become dependencies (b444)', () => {
    const f = fixture();
    const r = ok(moveItem(f, 'b2', 'other', O));
    expect(ids(r.file, 'other')).toEqual(['b2', 'b7']);
    expect(ids(r.file, 'main')).toEqual(['b1', 'b3', 'b4', 'b5', 'b6']);
    const all = r.file.boards.flatMap((b) => b.items);
    const get = (id: string) => all.find((i) => i.id === id)!;
    expect(get('b1').dependsOn).toEqual(['b2']);
    expect(get('b2').parent).toBeUndefined();
    expect(get('b2').dependsOn).toEqual(['b3']);
    expect(get('b3').parent).toBeUndefined();
    expect(all.filter((i) => i.updated === TODAY).map((i) => i.id).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(r.lines).toEqual([
      "move b2  T b2  from board 'main' to board 'other' (alone: it was nested under b1)",
      '  nest link b1 > b2 becomes a dependency: b1 depends on b2',
      '  nest link b2 > b3 becomes a dependency: b2 depends on b3',
      `  updated: ${TODAY} on 3 items`,
    ]);
    expect(f.boards[0].items.find((i) => i.id === 'b2')!.parent).toBe('b1');   // input untouched
  });
  it('a dependency that already exists is kept once', () => {
    const f = fixture();
    f.boards[0].items.find((i) => i.id === 'b1')!.dependsOn = ['b2'];
    const r = ok(moveItem(f, 'b2', 'other', O));
    expect(r.file.boards[0].items.find((i) => i.id === 'b1')!.dependsOn).toEqual(['b2']);
    expect(r.lines[1]).toBe('  nest link b1 > b2 becomes a dependency: b1 depends on b2 (already a dependency)');
  });
  it('a nested move that would close a dependency cycle is refused', () => {
    const f = fixture();
    f.boards[0].items.find((i) => i.id === 'b2')!.dependsOn = ['b1'];
    const r = err(moveItem(f, 'b2', 'other', O));
    expect(r.error).toContain('this would make the board worse');
    expect(r.reasons.join('\n')).toContain('dependsOn');
  });
  it('a nested item with 20000 children does not recurse', () => {
    const f: BoardFile = { schemaVersion: 1, boards: [{ id: 'a', name: 'A', items: [it1('b1'), it1('b2', { parent: 'b1' })] }, { id: 'b', name: 'B', items: [] }] };
    for (let n = 3; n <= 20002; n++) f.boards[0].items.push(it1(`b${n}`, { parent: 'b2' }));
    const r = ok(moveItem(f, 'b2', 'b', O));
    expect(r.file.boards[1].items.map((i) => i.id)).toEqual(['b2']);
    expect(r.file.boards[1].items[0].dependsOn).toHaveLength(20000);
    expect(r.lines).toContain('  ... and 19980 more');
    expect(r.lines[r.lines.length - 1]).toBe(`  updated: ${TODAY} on 20002 items`);
  });
  it('handles a 20000-deep nest without recursion', () => {
    const f: BoardFile = { schemaVersion: 1, boards: [{ id: 'a', name: 'A', items: [] }, { id: 'b', name: 'B', items: [] }] };
    for (let n = 1; n <= 20000; n++) f.boards[0].items.push(it1(`b${n}`, n > 1 ? { parent: `b${n - 1}` } : {}));
    const r = ok(moveItem(f, 'b1', 'b', O));
    expect(r.file.boards[1].items).toHaveLength(20000);
  });
});

describe('setBoardArchived / deleteBoard (b443)', () => {
  it('archive sets the flag, unarchive removes the key, items untouched, input untouched', () => {
    const f = fixture();
    const a = ok(setBoardArchived(f, 'other', true, O));
    expect(a.file.boards[1].archived).toBe(true);
    expect(a.file.boards[1].items).toEqual(f.boards[1].items);
    expect(a.lines[0]).toBe("archive board 'other' (Other): its 1 item stay; hidden from board list (see --all) and the page");
    expect(f.boards[1].archived).toBeUndefined();
    const u = ok(setBoardArchived(f, 'old', false, O));
    expect(u.file.boards[2]).not.toHaveProperty('archived');
    expect(u.lines[0]).toContain("unarchive board 'old' (Old)");
    expect(f.boards[2].archived).toBe(true);
  });
  it('archiving an archived board returns the same file', () => {
    const f = fixture();
    expect(ok(setBoardArchived(f, 'old', true, O)).file).toBe(f);
    expect(ok(setBoardArchived(f, 'main', false, O)).file).toBe(f);
  });
  it('refuses a missing board', () => {
    expect(err(setBoardArchived(fixture(), 'nope', true, O)).error).toContain("no board 'nope'");
    expect(err(deleteBoard(fixture(), 'nope', O)).error).toContain("no board 'nope'");
  });
  it('deleteBoard removes an empty board (also an archived one: old)', () => {
    const f = fixture();
    const r = ok(deleteBoard(f, 'old', O));
    expect(r.file.boards.map((b) => b.id)).toEqual(['main', 'other']);
    expect(r.lines).toEqual(["delete board 'old' (Old) (archived)"]);
    expect(f.boards).toHaveLength(3);
  });
  it('deleteBoard refuses a board with items and names them', () => {
    const r = err(deleteBoard(fixture(), 'other', O));
    expect(r.error).toBe("board 'other' still has 1 item; move them (c4mp board move <id> --board <other>) or remove them first");
    expect(r.reasons).toEqual(['b7  T b7']);
  });
});

describe('groups', () => {
  it('addGroup: slug id, appended, duplicates and bad names refused', () => {
    const r = ok(addGroup(fixture(), 'main', 'Blocked by QA', O));
    expect(r.file.boards[0].groups!.map((g) => g.id)).toEqual(['planned', 'triage', 'blocked-by-qa']);
    expect(err(addGroup(fixture(), 'main', 'needs TRIAGE', O)).error).toContain('already has');
    expect(err(addGroup(fixture(), 'main', 'a,b', O)).error).toContain('comma');
    expect(err(addGroup(fixture(), 'main', '  ', O)).error).toContain('empty');
    expect(err(addGroup(fixture(), 'nope', 'X', O)).error).toContain("no board 'nope'");
    expect(groupSlug('2nd')).toBe('g-2nd');
    expect(groupSlug('!!!')).toBe('group');
  });
  it('addGroup on a board without groups writes the three defaults first', () => {
    const r = ok(addGroup(fixture(), 'other', 'QA', O));
    expect(r.file.boards[1].groups!.map((g) => g.id)).toEqual(['planned', 'in-progress', 'done', 'qa']);
  });
  it('removeGroup: custom group with no item; refused with an item and for a status group', () => {
    const f = fixture();
    f.boards[0].groups!.push({ id: 'extra', name: 'Extra' });
    expect(ok(removeGroup(f, 'main', 'Extra', O)).file.boards[0].groups!.map((g) => g.id)).toEqual(['planned', 'triage']);
    expect(err(removeGroup(fixture(), 'main', 'triage', O)).reasons).toEqual(['b5 is in group triage']);
    expect(err(removeGroup(fixture(), 'main', 'Planned', O)).error).toContain('built in');
    expect(err(removeGroup(fixture(), 'other', 'Done', O)).error).toContain('built in');
    expect(err(removeGroup(fixture(), 'main', 'zzz', O)).error).toContain("no group 'zzz'");
  });
  it('orderGroups: only the order changes; missing, unknown and repeated names refused', () => {
    const f = fixture();
    const r = ok(orderGroups(f, 'main', ['needs triage', 'planned'], O));
    expect(r.file.boards[0].groups!.map((g) => g.id)).toEqual(['triage', 'planned']);
    expect(r.file.boards[0].items).toEqual(f.boards[0].items);
    expect(err(orderGroups(f, 'main', ['planned'], O)).reasons).toEqual(["group 'Needs triage' is missing from the list"]);
    expect(err(orderGroups(f, 'main', ['planned', 'triage', 'x'], O)).reasons).toEqual(["'x' is not a group of board 'main'"]);
    expect(err(orderGroups(f, 'main', ['planned', 'planned', 'triage'], O)).reasons).toEqual(["'planned' is listed twice"]);
  });
});

describe('expandBulk', () => {
  const spec = {
    items: [
      { ref: 'f', title: 'Quiz', kind: 'feature', owner: 'K', due: '2026-11-01', tags: ['Api'] },
      { title: 'Build', kind: 'task', parentRef: 'f' },
      { ref: 'c', title: 'Cover', kind: 'task', parentRef: 'f', dependsOnRefs: ['t'] },
      { ref: 't', title: 'Tests', kind: 'task', parentRef: 'f', dependsOn: ['b6'], status: 'done' },
    ],
  };

  it('mints ids after the max of ANY board and resolves refs (forward too)', () => {
    const f = fixture();
    expect(mintItemIds(f, 2)).toEqual(['b8', 'b9']);
    const r = expandBulk(f, spec, 'main', O) as BulkOk;
    expect(isOpError(r)).toBe(false);
    const items = r.file.boards[0].items.filter((i) => Number(i.id.slice(1)) >= 8);
    expect(items.map((i) => [i.id, i.parent, i.dependsOn])).toEqual([
      ['b8', undefined, []], ['b9', 'b8', []], ['b10', 'b8', ['b11']], ['b11', 'b8', ['b6']],
    ]);
    expect(items[0].tags).toEqual(['api']);
    expect(items[0].created).toBe(TODAY);
    expect(items[3].closed).toBe(TODAY);
    expect(r.minted).toEqual([{ index: 0, id: 'b8', ref: 'f' }, { index: 1, id: 'b9' }, { index: 2, id: 'b10', ref: 'c' }, { index: 3, id: 'b11', ref: 't' }]);
  });
  it('boardName names a NEW board only (b565)', () => {
    const one = { items: [{ title: 'A', kind: 'task' }] };
    const made = expandBulk(fixture(), one, 'night-x', { ...O, boardName: ' Night X ' }) as BulkOk;
    expect(made.file.boards.find((b) => b.id === 'night-x')?.name).toBe('Night X');
    expect((expandBulk(fixture(), one, 'night-y', O) as BulkOk).file.boards.find((b) => b.id === 'night-y')?.name).toBe('night-y');
    expect(err(expandBulk(fixture(), one, 'main', { ...O, boardName: 'X' })).error).toBe("--board-name only names a NEW board; board 'main' already exists");
  });
  it('one bad item refuses everything, with the item named', () => {
    const bad = { items: [{ title: 'ok', kind: 'task' }, { ref: 'x', title: 'bad', kind: 'epic', parentRef: 'nope', due: '2026-02-30', zzz: 1 }] };
    const r = err(expandBulk(fixture(), bad, 'main', O));
    expect(r.reasons.join('\n')).toContain("items[1] (ref x): kind 'epic'");
    expect(r.reasons.join('\n')).toContain("parentRef 'nope' matches no");
    expect(r.reasons.join('\n')).toContain('not a date');
    expect(r.reasons.join('\n')).toContain("unknown key 'zzz'");
  });
  it('an unknown key names the key it most likely meant (b219)', () => {
    const r = err(expandBulk(fixture(), { items: [{ title: 'A', kind: 'task', tag: ['x'], depends: ['b1'], zzz: 1 }] }, 'main', O));
    const text = r.reasons.join('\n');
    expect(text).toContain("unknown key 'tag', did you mean 'tags'? (allowed: ref, title,");
    expect(text).toContain("unknown key 'depends', did you mean 'dependsOn'?");
    expect(text).toContain("unknown key 'zzz' (allowed:");
    expect(err(expandBulk(fixture(), { item: [] } as unknown, 'main', O)).error).toBe('the file must be a JSON object {"items": [ ... ]}');
    expect(err(expandBulk(fixture(), { items: [{ title: 'A', kind: 'task' }], item: [] }, 'main', O)).error)
      .toBe(`unknown key 'item', did you mean 'items'? (only "items" is allowed)`);
  });
  it('refuses a cycle, an unknown parent, a parent of another board, duplicate refs, bad shapes', () => {
    const cyc = { items: [{ ref: 'a', title: 'A', kind: 'task', dependsOnRefs: ['b'] }, { ref: 'b', title: 'B', kind: 'task', dependsOnRefs: ['a'] }] };
    expect(err(expandBulk(fixture(), cyc, 'main', O)).reasons.join('\n')).toContain('dependsOn cycle');
    const nest = { items: [{ ref: 'a', title: 'A', kind: 'task', parentRef: 'b' }, { ref: 'b', title: 'B', kind: 'task', parentRef: 'a' }] };
    expect(err(expandBulk(fixture(), nest, 'main', O)).reasons.join('\n')).toContain('nesting');
    expect(err(expandBulk(fixture(), { items: [{ title: 'A', kind: 'task', parent: 'zz' }] }, 'main', O)).reasons[0]).toContain("parent 'zz' is not an item");
    expect(err(expandBulk(fixture(), { items: [{ title: 'A', kind: 'task', parent: 'b7' }] }, 'main', O)).reasons[0]).toContain("in board 'other'");
    expect(err(expandBulk(fixture(), { items: [{ ref: 'a', title: 'A', kind: 'task' }, { ref: 'a', title: 'B', kind: 'task' }] }, 'main', O)).reasons[0]).toContain('already used');
    expect(err(expandBulk(fixture(), { items: [] }, 'main', O)).error).toContain('empty');
    expect(err(expandBulk(fixture(), [], 'main', O)).error).toContain('JSON object');
    expect(err(expandBulk(fixture(), { items: [{ title: 'A', kind: 'task', group: 'nope' }] }, 'main', O)).reasons[0]).toContain("group 'nope'");
  });
  it('board choice: required when 2+ open boards, created when new, archived refused, only board by default', () => {
    const one = { items: [{ title: 'A', kind: 'task' }] };
    expect(err(expandBulk(fixture(), one, undefined, O)).error).toContain('2 open boards');   // b443: the archived old does not count
    expect(err(expandBulk(fixture(), one, 'old', O)).error).toContain('unarchive it first');
    const onlyArchived: BoardFile = { schemaVersion: 1, boards: [{ id: 'old', name: 'Old', archived: true, items: [] }] };
    expect(err(expandBulk(onlyArchived, one, undefined, O)).error).toContain('every board is archived');
    const oneOpen = fixture();
    oneOpen.boards = oneOpen.boards.filter((b) => b.id !== 'other');
    expect((expandBulk(oneOpen, one, undefined, O) as BulkOk).file.boards[0].items.map((i) => i.id)).toContain('b7');   // the only OPEN board (other, with b7, removed)
    const created = expandBulk(fixture(), one, 'fresh', O) as BulkOk;
    expect(created.file.boards.map((b) => b.id)).toContain('fresh');
    expect(created.lines[0]).toContain("create board 'fresh'");
    const empty: BoardFile = { schemaVersion: 1, boards: [] };
    expect((expandBulk(empty, one, undefined, O) as BulkOk).file.boards[0].id).toBe('main');
  });
  it('ids that are legal but odd (__proto__) do not break the lookups', () => {
    const f = fixture();
    f.boards[0].items.push(it1('__proto__'));
    const r = expandBulk(f, { items: [{ title: 'A', kind: 'task', parent: '__proto__' }] }, 'main', O) as BulkOk;
    expect(isOpError(r)).toBe(false);
    expect(r.file.boards[0].items.find((i) => i.id === 'b8')!.parent).toBe('__proto__');
  });
});
