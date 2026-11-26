import * as fs from 'fs';
import { makeBoardRepo, runBoardCli } from './helpers/boardHarness';
import { runBoardOps } from '../src/services/boardEdit';
import type { BoardPageOp } from '../src/services/boardEdit';
import { textStamp } from '../src/util/stamp';

const set = (id: string, fields: Record<string, string>): BoardPageOp => ({ op: 'set', id, fields });

describe('runBoardOps (b645, SV11a)', () => {
  it.each([
    ['status', 'done', 'b5'], ['title', 'New', 'b5'], ['priority', 'high', 'b5'], ['owner', 'Ann', 'b5'],
    ['start', '2026-12-01', 'b5'], ['due', '2026-12-09', 'b5'], ['size', 'M', 'b5'], ['sprint', 'S20', 'b5'],
    ['tags', 'ui,live', 'b5'], ['group', 'triage', 'b5'], ['group', 'none', 'b4'],
  ])('set %s=%s writes what the CLI writes', async (field, value, id) => {
    const a = makeBoardRepo('ops-a');
    const b = makeBoardRepo('ops-b');
    await runBoardCli(['set', id, '--repo', a.root, `--${field}`, value, '--yes']);
    const r = runBoardOps(b.root, [set(id, { [field]: value })], { yes: true });
    expect(r.ok).toBe(true);
    expect(r.results[0]).toMatchObject({ ok: true, written: true });
    expect((r.results[0] as { changes: string[] }).changes[0]).toMatch(new RegExp(`^set ${id} \\(board 'main'\\):`));
    expect(b.text()).toBe(a.text());
  });

  it('group ops write what the CLI writes', async () => {
    const a = makeBoardRepo('ops-g1');
    const b = makeBoardRepo('ops-g2');
    await runBoardCli(['group', 'add', 'Review', '--board', 'main', '--yes', '--repo', a.root]);
    await runBoardCli(['group', 'order', 'Review,Needs triage,Planned', '--board', 'main', '--yes', '--repo', a.root]);
    await runBoardCli(['group', 'add', 'X', '--board', 'main', '--yes', '--repo', a.root]);
    await runBoardCli(['group', 'remove', 'X', '--board', 'main', '--yes', '--repo', a.root]);
    const r = runBoardOps(b.root, [
      { op: 'group-add', board: 'main', name: 'Review' },
      { op: 'group-order', board: 'main', names: ['Review', 'Needs triage', 'Planned'] },
      { op: 'group-add', board: 'main', name: 'X' },
      { op: 'group-remove', board: 'main', name: 'X' },
    ], { yes: true });
    expect(r.ok).toBe(true);
    expect(b.text()).toBe(a.text());
  });

  it('stops at the first refusal; earlier ops stay written', () => {
    const b = makeBoardRepo('ops-stop');
    const r = runBoardOps(b.root, [set('b5', { status: 'done' }), set('b5', { status: 'bogus' }), set('b1', { owner: 'X' })], { yes: true });
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(1);
    expect(r.results).toHaveLength(2);
    expect(r.results[1]).toMatchObject({ ok: false });
    expect((r.results[1] as { error: { message: string } }).error.message).toMatch(/^--status 'bogus' should be one of/);
    const data = JSON.parse(b.text()) as { boards: { items: { id: string; status: string; owner?: string }[] }[] };
    const items = data.boards[0].items;
    expect(items.find((i) => i.id === 'b5')?.status).toBe('done');
    expect(items.find((i) => i.id === 'b1')?.owner).toBe('K');
  });

  it('an unknown item is not-found', () => {
    const r = runBoardOps(makeBoardRepo('ops-nf').root, [set('zz', { status: 'done' })], { yes: true });
    expect(r.results[0]).toMatchObject({ ok: false, error: { code: 'not-found', message: "no item 'zz'" } });
  });

  it('a refused group remove (group has items) stops at 0', () => {
    const b = makeBoardRepo('ops-gr');
    const before = b.text();
    const r = runBoardOps(b.root, [{ op: 'group-remove', board: 'main', name: 'triage' }], { yes: true });
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(b.text()).toBe(before);
  });

  it('refuses all when the stamp differs, runs when it matches', () => {
    const b = makeBoardRepo('ops-st');
    const before = b.text();
    const bad = runBoardOps(b.root, [set('b5', { status: 'done' })], { yes: true, expectStamp: 'x' });
    expect(bad.error?.code).toBe('changed');
    expect(bad.results).toEqual([]);
    expect(bad.stoppedAt).toBeNull();
    expect(b.text()).toBe(before);
    const good = runBoardOps(b.root, [set('b5', { status: 'done' })], { yes: true, expectStamp: textStamp([['board', before]]) });
    expect(good.ok).toBe(true);
    expect(good.stamp).toBe(textStamp([['board', b.text()]]));
  });

  it('nothing to change is ok and not written', () => {
    const r = runBoardOps(makeBoardRepo('ops-nc').root, [set('b5', { status: 'planned' })], { yes: true });
    expect(r.ok).toBe(true);
    expect(r.results[0]).toMatchObject({ ok: true, written: false });
    expect((r.results[0] as { changes: string[] }).changes.slice(-1)).toEqual(['nothing to change']);
  });

  it('a dry run leaves the file alone', () => {
    const b = makeBoardRepo('ops-dry');
    const before = b.text();
    const r = runBoardOps(b.root, [set('b5', { status: 'done' })], { yes: false });
    expect(r.results[0]).toMatchObject({ ok: true, dryRun: true, written: false });
    expect(b.text()).toBe(before);
  });

  it('refuses a field outside the page list', () => {
    const r = runBoardOps(makeBoardRepo('ops-fg').root, [set('b5', { kind: 'bug' })], { yes: true });
    expect(r.results[0]).toMatchObject({ ok: false, error: { message: "field 'kind' cannot be set from the page" } });
  });

  it('edge cases: empty ops, no board file', () => {
    const b = makeBoardRepo('ops-e1');
    expect(runBoardOps(b.root, [], { yes: true })).toMatchObject({ ok: true, results: [], stoppedAt: null });
    const none = makeBoardRepo('ops-e2', null);
    expect(fs.existsSync(none.file)).toBe(false);
    const r = runBoardOps(none.root, [set('b1', { status: 'done' })], { yes: true });
    expect(r.results[0]).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(r.stamp).toBe(textStamp([['board', null]]));
  });
});
