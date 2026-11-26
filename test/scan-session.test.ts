import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/history/meta', () => {
  const actual = jest.requireActual('../src/history/meta');
  return { ...actual, readMeta: jest.fn(actual.readMeta) };
});

import { readMeta } from '../src/history/meta';
import { openScanSession } from '../src/scan/session';
import { runSnapshot } from '../src/pipeline';
import { Plan } from '../src/types';

const emptyPlan = (files: string[]): Plan => ({ files, elements: [], relations: [], issues: [] });

describe('ScanSession', () => {
  let repo: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-session-'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"sess"}');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'import { b } from "./b";\nexport const a = b;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => (readMeta as jest.Mock).mockClear());

  it('snapshotFor(a) then snapshotFor(b) builds the core once and reads meta once', () => {
    const s = openScanSession(repo, {});
    const a = s.snapshotFor(emptyPlan(['a.c4']));
    const core1 = s.core();
    const b = s.snapshotFor(emptyPlan(['b.c4']));
    expect(s.core()).toBe(core1);
    expect(readMeta).toHaveBeenCalledTimes(1);
    expect(a).not.toBe(b);
  });

  it('memoises per plan content and treats no plan as its own key', () => {
    const s = openScanSession(repo, {});
    expect(s.snapshotFor(emptyPlan(['a.c4']))).toBe(s.snapshotFor(emptyPlan(['a.c4'])));
    expect(s.snapshotFor()).toBe(s.snapshotFor(undefined));
  });

  it('is lazy and sessions do not share state', () => {
    const s1 = openScanSession(repo, {});
    expect(readMeta).not.toHaveBeenCalled();
    s1.core();
    openScanSession(repo, {}).core();
    expect(readMeta).toHaveBeenCalledTimes(2);
  });

  it('matches runSnapshot output', () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const viaRun = runSnapshot({ repo, write: false, quiet: true });
    const viaSession = openScanSession(repo, {}).snapshotFor();
    viaRun.meta.createdAt = viaSession.meta.createdAt = createdAt;
    expect(viaSession).toEqual(viaRun);
  });
});
