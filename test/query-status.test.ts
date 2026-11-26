import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStatus, formatStatusLines } from '../src/query/status';
import type { StatusResult } from '../src/query/status';
import * as planParser from '../src/plan/parser';
import { initProject } from '../src/init';
import { takeSnapshot } from '../src/scan/snapshots';

const FIX = path.join(__dirname, 'fixtures');

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function copyFixture(name: string): string {
  const dir = tmp('c4pm-status-');
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  return dir;
}

function plainRepo(): string {
  const dir = tmp('c4pm-status-plain-');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  return dir;
}

describe('runStatus', () => {
  it('with a plan: snapshot sizes, plan finding counts, config', () => {
    const r = runStatus(copyFixture('phofast'), {});
    expect(r.snapshot).not.toBeNull();
    expect(r.snapshot!.files).toBeGreaterThan(0);
    expect(r.plan).not.toBeNull();
    expect(r.plan).not.toBe('error');
    const plan = r.plan as { files: number; critical: number; warning: number; info: number };
    expect(plan.files).toBeGreaterThan(0);
    expect(plan.critical + plan.warning + plan.info).toBeGreaterThan(0);
    expect(r.config.languages.length).toBeGreaterThan(0);
  });

  it('without a plan: plan is null', () => {
    const r = runStatus(plainRepo(), {});
    expect(r.snapshot).not.toBeNull();
    expect(r.plan).toBeNull();
  });

  it('no history and no anchor: count 0, not anchored; with an anchor: anchored', () => {
    const dir = plainRepo();
    expect(runStatus(dir, {}).history).toEqual({ count: 0, latest: null, anchored: false, error: null });
    initProject(dir);
    expect(runStatus(dir, {}).history).toEqual({ count: 0, latest: null, anchored: true, error: null });
  });

  it.each([
    ['the anchor\'s store', (dir: string) => { initProject(dir); return {}; }, true],
    ['a --store folder, no anchor', () => ({ store: tmp('c4pm-status-store-') }), false],
  ])('one stored snapshot in %s: count 1, latest without a commit', (_where, setup, anchored) => {
    const dir = plainRepo();
    const cli = setup(dir);
    const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      takeSnapshot(dir, cli, { out: tmp('c4pm-status-out-'), save: true });
    } finally {
      quiet.mockRestore();
    }
    expect(runStatus(dir, cli).history).toEqual({
      count: 1,
      latest: { commit: null, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      anchored,
      error: null,
    });
  });

  it('a corrupt history manifest is reported as unreadable (path and reason), not as 0 snapshots', () => {
    const dir = plainRepo();
    const store = tmp('c4pm-status-store-');
    const cli = { store };
    const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      takeSnapshot(dir, cli, { out: tmp('c4pm-status-out-'), save: true });
    } finally {
      quiet.mockRestore();
    }
    const [repoId] = fs.readdirSync(store);
    const manifest = path.join(store, repoId, 'history', 'manifest.json');
    fs.writeFileSync(manifest, '{"entries": [');
    const r = runStatus(dir, cli);
    expect(r.history.count).toBe(0);
    expect(r.history.error).toContain(manifest);
    expect(r.history.error).toContain('not valid JSON');
    expect(formatStatusLines(r)[1]).toBe(`History: unreadable: ${r.history.error}`);
  });

  it('a plan that cannot be read is reported as "error", not thrown', () => {
    const dir = copyFixture('phofast');
    jest.spyOn(planParser, 'parsePlan').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const r = runStatus(dir, {});
    expect(r.plan).toBe('error');
    expect(formatStatusLines(r)[2]).toBe('Plan: error reading');
  });

  it('config reflects languages and ignore overrides', () => {
    const r = runStatus(plainRepo(), { languages: ['typescript'], ignore: ['dist'] });
    expect(r.config.languages).toEqual(['typescript']);
    expect(r.config.ignore).toEqual(['dist']);
    expect(formatStatusLines(r)[3]).toBe('Config: languages=typescript, ignore=dist');
  });
});

describe('formatStatusLines', () => {
  const base: StatusResult = {
    snapshot: { name: 'demo', containers: 1, components: 2, files: 3, codeElements: 4, componentEdges: 5, unresolvedImports: 6, parseFailures: [] },
    history: { count: 2, latest: { commit: 'abcdef1234567', date: '2026-01-02' }, anchored: true, error: null },
    plan: { files: 2, critical: 1, warning: 2, info: 3 },
    config: { languages: ['typescript', 'python'], ignore: [] },
  };

  it('prints the four lines', () => {
    expect(formatStatusLines(base)).toEqual([
      'Snapshot: demo — 1 containers, 2 components, 3 files, 4 code elements, 5 component edges, 6 unresolved imports',
      'History: 2 stored (latest abcdef1 2026-01-02)',
      'Plan: 2 .c4 files, 1 critical, 2 warning, 3 info',
      'Config: languages=typescript,python, ignore=(none)',
    ]);
  });

  it('lists the files that did not parse', () => {
    const lines = formatStatusLines({ ...base, snapshot: { ...base.snapshot!, parseFailures: ['a.ts', 'b/c.ts'] } });
    expect(lines.slice(4)).toEqual(['Parse errors: 2 files did not parse', '  a.ts', '  b/c.ts']);
  });

  it('failure and empty cases keep their wording', () => {
    const failed = formatStatusLines({
      ...base,
      snapshot: null,
      history: { count: 0, latest: null, anchored: false, error: null },
      plan: { files: 2, critical: 0, warning: 0, info: 0 },
    });
    expect(failed[0]).toBe('Snapshot: failed to generate');
    expect(failed[1]).toBe('History: none (no .c4mp found; run c4mp init)');
    expect(failed[2]).toBe('Plan: 2 .c4 files, unable to check (snapshot failed)');
    const none = formatStatusLines({ ...base, history: { count: 0, latest: null, anchored: true, error: null }, plan: null });
    expect(none[1]).toBe('History: none (run c4mp history)');
    expect(none[2]).toBe('Plan: none');
    const nogit = formatStatusLines({ ...base, history: { count: 1, latest: { commit: null, date: '2026-01-02' }, anchored: true, error: null } });
    expect(nogit[1]).toBe('History: 1 stored (latest nogit 2026-01-02)');
  });
});
