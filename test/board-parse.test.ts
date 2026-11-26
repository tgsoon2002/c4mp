import { parseBoard } from '../src/board/parse';

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, kind: 'task', status: 'planned', ...extra });
const file = (boards: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, boards, ...extra });
const board = (id: string, items: unknown[] = [], extra: Record<string, unknown> = {}) => ({ id, name: `Board ${id}`, items, ...extra });

describe('parseBoard: whole-file failures', () => {
  it.each([
    ['bad JSON', '{ nope', /not valid JSON/],
    ['empty text', '', /not valid JSON/],
    ['array at top', '[]', /must be a JSON object/],
    ['wrong schemaVersion', JSON.stringify({ schemaVersion: 2, boards: [] }), /schemaVersion/],
    ['missing schemaVersion', JSON.stringify({ boards: [] }), /schemaVersion/],
    ['boards not an array', JSON.stringify({ schemaVersion: 1, boards: {} }), /boards/],
  ])('%s -> data null and one issue', (_name, text, re) => {
    const r = parseBoard(text);
    expect(r.data).toBeNull();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(re);
    expect(r.issues[0]).toMatchObject({ file: '', line: 0 });
  });
});

describe('parseBoard: valid input', () => {
  it('minimal file: item gets list defaults and no issues', () => {
    const r = parseBoard(file([board('main', [item('b1')])]));
    expect(r.issues).toEqual([]);
    expect(r.data).toEqual({
      schemaVersion: 1,
      boards: [{ id: 'main', name: 'Board main', items: [{ id: 'b1', title: 'T b1', kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [] }] }],
    });
    expect(r.data!.boards[0].groups).toBeUndefined();
  });

  it('keeps every field, trims strings, keeps unknown kind/status as written', () => {
    const full = item('b2', {
      title: '  Build it  ', kind: 'epic', status: 'blocked', owner: ' kim ', parent: 'b1', sprint: 'S12', priority: 'high',
      dependsOn: ['b1'], links: ['u-1'], tags: ['api', ' billing '], group: 'triage',
      start: '2026-10-01', due: '2026-10-30', created: '2026-09-30', updated: '2026-10-02', closed: '2026-10-29',
    });
    const r = parseBoard(file([board('main', [item('b1'), full], { archived: true, groups: [{ id: 'triage', name: 'Needs triage' }, { id: 'planned', name: 'Planned', status: 'planned' }] })]));
    expect(r.issues).toEqual([]);
    const b = r.data!.boards[0];
    expect(b.archived).toBe(true);
    expect(b.groups).toEqual([{ id: 'triage', name: 'Needs triage' }, { id: 'planned', name: 'Planned', status: 'planned' }]);
    expect(b.items[1]).toEqual({
      id: 'b2', title: 'Build it', kind: 'epic', status: 'blocked', owner: 'kim', parent: 'b1', sprint: 'S12', priority: 'high',
      dependsOn: ['b1'], links: ['u-1'], tags: ['api', 'billing'], group: 'triage',
      start: '2026-10-01', due: '2026-10-30', created: '2026-09-30', updated: '2026-10-02', closed: '2026-10-29',
    });
  });
});

describe('parseBoard: structure issues (item or board dropped, rest kept)', () => {
  it('two boards with one id: the second is skipped', () => {
    const r = parseBoard(file([board('a', [item('b1')]), board('a', [item('b2')]), board('c')]));
    expect(r.data!.boards.map(b => b.id)).toEqual(['a', 'c']);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(/^boards\[1\]:.*already used/);
  });

  it('an item id repeated in ANOTHER board: the second is skipped', () => {
    const r = parseBoard(file([board('a', [item('b1')]), board('c', [item('b1'), item('b2')])]));
    expect(r.data!.boards[1].items.map(i => i.id)).toEqual(['b2']);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(/^boards\[1\]\.items\[0\]:.*unique across the file/);
  });

  it.each([
    ['missing item id', board('a', [{ title: 'x', kind: 'task', status: 'planned' }]), /boards\[0\]\.items\[0\]: item skipped: 'id'/],
    ['bad item id', board('a', [item('1bad')]), /'id' must match/],
    ['missing title', board('a', [{ id: 'b1' }]), /'title'/],
    ['bad board id', { id: 'a b', name: 'x', items: [] }, /boards\[0\]: board skipped/],
    ['empty board name', { id: 'a', name: ' ', items: [] }, /'name'/],
  ])('%s -> skipped with a path-prefixed issue', (_n, b, re) => {
    const r = parseBoard(file([b]));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(re);
    const items = r.data!.boards.flatMap(x => x.items);
    expect(items).toEqual([]);
  });

  it('bad group is dropped, duplicate group id is dropped', () => {
    const r = parseBoard(file([board('a', [], { groups: [{ id: 'g1', name: 'One' }, { id: 'g1', name: 'Again' }, { id: 'g2' }] })]));
    expect(r.data!.boards[0].groups).toEqual([{ id: 'g1', name: 'One' }]);
    expect(r.issues).toHaveLength(2);
  });
});

describe('parseBoard: field issues (field dropped, item kept)', () => {
  it.each([
    ['bad date dropped', { due: '2026-02-30' }, 'due', undefined, /'due'.*not a date/],
    ['non-array tags', { tags: 'a,b' }, 'tags', [], /'tags' must be an array/],
    ['non-string link entry', { links: ['u1', 7] }, 'links', ['u1'], /non-string entry/],
    ['non-string owner', { owner: 5 }, 'owner', undefined, /'owner' must be a string/],
  ])('%s', (_n, extra, key, expected, re) => {
    const r = parseBoard(file([board('a', [item('b1', extra)])]));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(new RegExp(`^boards\\[0\\]\\.items\\[0\\]: .*`));
    expect(r.issues[0].message).toMatch(re);
    expect((r.data!.boards[0].items[0] as unknown as Record<string, unknown>)[key]).toEqual(expected);
  });

  it('unknown key on the file and on a board', () => {
    const r = parseBoard(file([board('a', [], { wip: 3 })], { extra: 1 }));
    expect(r.issues.map(i => i.message).sort()).toEqual([
      "boards[0]: unknown key 'wip'",
      "unknown key 'extra'",
    ]);
    expect((r.data!.boards[0] as unknown as Record<string, unknown>).wip).toBeUndefined();
  });
});
