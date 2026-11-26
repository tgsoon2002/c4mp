import { present, groupFindings, applyAcks } from '../src/findings';
import type { AckEntry } from '../src/findings';
import type { PlanFinding } from '../src/types';

const f = (severity: PlanFinding['severity'], rule: string, id: string): PlanFinding => ({ severity, rule, id, message: `${rule} ${id}` });
const ack = (a: Partial<AckEntry>): AckEntry => ({ rule: 'shared-auto', reason: 'on purpose', added: '2026-11-03', ...a });

const raw = [
  f('info', 'shared-auto', 'src/render/a.ts#x'),
  f('info', 'shared-auto', 'src/render/a.ts#y'),
  f('info', 'shared-auto', 'src/tags.ts#z'),
  f('info', 'split-file', 'src/render/a.ts#x'),
  f('warning', 'duplicate-fqn', 'shop.api'),
  f('warning', 'duplicate-fqn', 'shop.api'),
  f('critical', 'unassigned-code', 'src/c.ts#q'),
];

describe('groupFindings', () => {
  it('merges file#name ids per (severity, rule, file); other ids stay single rows', () => {
    const rows = groupFindings(raw);
    expect(rows.map((r) => [r.rule, r.key, r.count])).toEqual([
      ['shared-auto', 'src/render/a.ts', 2],
      ['shared-auto', 'src/tags.ts', 1],
      ['split-file', 'src/render/a.ts', 1],
      ['duplicate-fqn', 'shop.api', 1],
      ['duplicate-fqn', 'shop.api', 1],
      ['unassigned-code', 'src/c.ts', 1],
    ]);
    expect(rows[0].ids).toEqual(['src/render/a.ts#x', 'src/render/a.ts#y']);
    expect(rows[1].message).toBe('shared-auto src/tags.ts#z');
  });
});

describe('applyAcks', () => {
  it.each([
    ['exact id', ack({ id: 'src/tags.ts#z' }), 1],
    ['folder glob', ack({ glob: 'src/render' }), 2],
    ['wildcard glob', ack({ glob: 'src/**/*.ts' }), 3],
    ['file name', ack({ glob: 'src/tags.ts' }), 1],
    ['other rule', ack({ rule: 'split-file', glob: 'src/tags.ts' }), 0],
  ])('%s', (_name, a, n) => {
    const r = applyAcks(raw, [a]);
    expect(r.acknowledged.filter((x) => x.rule === 'shared-auto')).toHaveLength(n);
    expect(r.stale.length).toBe(n === 0 ? 1 : 0);
  });

  it('throws when an ack has neither or both of id and glob', () => {
    expect(() => applyAcks(raw, [ack({})])).toThrow(/exactly one/);
    expect(() => applyAcks(raw, [ack({ id: 'a', glob: 'b' })])).toThrow(/exactly one/);
  });
});

describe('present', () => {
  it('groups and counts hidden info', () => {
    const p = present(raw, { showInfo: false });
    expect(p.shown.map((r) => r.rule)).toEqual(['duplicate-fqn', 'duplicate-fqn', 'unassigned-code']);
    expect(p.hidden).toEqual([
      { severity: 'info', rule: 'shared-auto', count: 3, files: 2 },
      { severity: 'info', rule: 'split-file', count: 1, files: 1 },
    ]);
    expect(p.summary[0]).toBe('4 info hidden: shared-auto 3 in 2 files, split-file 1 in 1 file');
  });

  it('an ack glob hides and counts', () => {
    const p = present(raw, { acks: [ack({ glob: 'src/render/**' })] });
    expect(p.acknowledged).toBe(2);
    expect(p.shown.filter((r) => r.rule === 'shared-auto').map((r) => r.key)).toEqual(['src/tags.ts']);
    expect(p.summary).toContain('2 acknowledged');
  });

  it('reports a stale ack even under minSeverity critical', () => {
    const stale = ack({ glob: 'src/gone/**' });
    const p = present(raw, { minSeverity: 'critical', acks: [stale, ack({ glob: 'src/tags.ts' })] });
    expect(p.staleAcks).toEqual([stale]);
    expect(p.acknowledged).toBe(1);
    expect(p.shown.map((r) => r.rule)).toEqual(['unassigned-code']);
    expect(p.summary).toContain('stale ack: shared-auto src/gone/** matches nothing');
  });

  it('group:false gives one row per finding and does not change the input', () => {
    const copy = JSON.stringify(raw);
    expect(present(raw, { group: false }).shown).toHaveLength(raw.length);
    expect(JSON.stringify(raw)).toBe(copy);
  });
});

// Recorded `check --repo . --format json` of C4PM itself (run in Project/, 2026-11-03).
describe('C4PM own findings (recorded)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const recorded: PlanFinding[] = require('./findings-data/c4pm-check.json');
  const shared = recorded.filter((x) => x.rule === 'shared-auto');

  it('136 shared-auto findings group into 14 rows (one per file)', () => {
    expect(shared).toHaveLength(136);
    const rows = present(shared).shown;
    expect(rows).toHaveLength(14);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(136);
    expect(rows.find((r) => r.key === 'src/schema/sqlMigrations.ts')?.count).toBe(52);
  });

  it('an ack glob on src/schema hides and counts; a stale ack shows under minSeverity critical', () => {
    const stale = ack({ glob: 'src/nowhere/**' });
    const p = present(recorded, { minSeverity: 'critical', acks: [ack({ glob: 'src/schema/**' }), stale] });
    expect(p.acknowledged).toBe(5 + 5 + 7 + 52 + 8 + 7);
    expect(p.staleAcks).toEqual([stale]);
    expect(p.hidden.find((h) => h.rule === 'shared-auto')?.count).toBe(136 - p.acknowledged);
  });
});
