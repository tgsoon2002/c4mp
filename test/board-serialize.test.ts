import { serializeBoard } from '../src/board/serialize';
import { parseBoard } from '../src/board/parse';
import type { BoardFile, BoardItem } from '../src/types';

const it0 = (id: string, extra: Partial<BoardItem> = {}): BoardItem => ({
  id, title: `T ${id}`, kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], ...extra,
});

const FILES: Record<string, BoardFile> = {
  empty: { schemaVersion: 1, boards: [] },
  oneBoard: { schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items: [it0('b1'), it0('b2', { parent: 'b1', dependsOn: ['b1'] })] }] },
  twoBoards: {
    schemaVersion: 1,
    boards: [
      {
        id: 'sprint-s12', name: 'Sprint S12', archived: true,
        groups: [{ id: 'triage', name: 'Needs triage' }, { id: 'planned', name: 'Planned', status: 'planned' }],
        items: [it0('b1', { owner: 'kim', sprint: 'S12', priority: 'high', tags: ['api'], links: ['u1'], start: '2026-10-01', due: '2026-10-30', created: '2026-09-30', updated: '2026-10-02', closed: '2026-10-29', group: 'triage' })],
      },
      { id: 'backlog', name: 'Backlog', groups: [], items: [] },
    ],
  },
};

describe('serializeBoard', () => {
  it.each(Object.keys(FILES))('round trip: %s', name => {
    const text = serializeBoard(FILES[name]);
    const back = parseBoard(text);
    expect(back.issues).toEqual([]);
    expect(back.data).toEqual(FILES[name]);
  });

  it('is deterministic and ends with one newline', () => {
    const a = serializeBoard(FILES.twoBoards);
    expect(serializeBoard(parseBoard(a).data!)).toBe(a);
    expect(a.endsWith('}\n')).toBe(true);
  });

  it('sorts b<number> ids by number, then other ids by string; keeps board and group order', () => {
    const data: BoardFile = {
      schemaVersion: 1,
      boards: [
        { id: 'z', name: 'Z', groups: [{ id: 'g2', name: 'Two' }, { id: 'g1', name: 'One' }], items: [it0('b10'), it0('epic-1'), it0('b9'), it0('b2'), it0('alpha')] },
        { id: 'a', name: 'A', items: [] },
      ],
    };
    const out = JSON.parse(serializeBoard(data));
    expect(out.boards.map((b: { id: string }) => b.id)).toEqual(['z', 'a']);
    expect(out.boards[0].groups.map((g: { id: string }) => g.id)).toEqual(['g2', 'g1']);
    expect(out.boards[0].items.map((i: { id: string }) => i.id)).toEqual(['b2', 'b9', 'b10', 'alpha', 'epic-1']);
    expect(data.boards[0].items.map(i => i.id)).toEqual(['b10', 'epic-1', 'b9', 'b2', 'alpha']);   // input not mutated
  });

  it('writes list fields even when empty, omits absent optional scalars, uses interface key order', () => {
    const out = JSON.parse(serializeBoard(FILES.oneBoard));
    expect(Object.keys(out.boards[0].items[0])).toEqual(['id', 'title', 'kind', 'status', 'dependsOn', 'links', 'tags']);
    expect(Object.keys(JSON.parse(serializeBoard(FILES.twoBoards)).boards[0].items[0])).toEqual([
      'id', 'title', 'kind', 'status', 'owner', 'dependsOn', 'links', 'tags',
      'sprint', 'priority', 'start', 'due', 'created', 'updated', 'closed', 'group',
    ]);
    expect(serializeBoard(FILES.oneBoard)).toContain('\n  "boards": [');   // 2-space indent
  });
});
