import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { removeStaleExports } from '../src/scan/historyRun';

// b735: export dirs of a killed history run (c4pm-export-<pid>-XXXXXX) are removed by the next run's sweep.
describe('removeStaleExports (b735)', () => {
  // Inside a jest worker, process.env is the sandbox's copy: setting TMPDIR there does not reach os.tmpdir() (it
  // still gives the run root of test/globalSetup.js). So os.tmpdir() of the real module is pointed at a temp dir.
  const realOs: typeof os = jest.requireActual('os');
  let tmpdir: jest.SpyInstance<string, []>;
  let tmpRoot: string;
  let deadPid: number;
  beforeAll(() => {
    // A pid that just exited: the child ran and was waited for.
    deadPid = spawnSync(process.execPath, ['-e', '']).pid as number;
    expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'b735-tmp-')));
    tmpdir = jest.spyOn(realOs, 'tmpdir').mockReturnValue(tmpRoot);
    expect(os.tmpdir()).toBe(tmpRoot);
  });
  afterEach(() => {
    tmpdir.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const mkdir = (name: string, ageMs = 0): void => {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(dir, t, t);
    }
  };
  const names = (): string[] => fs.readdirSync(tmpRoot).sort();

  it('removes a fresh export dir whose run is dead', () => {
    mkdir(`c4pm-export-${deadPid}-abc`);
    removeStaleExports();
    expect(names()).toEqual([]);
  });

  it('keeps a fresh export dir of our own pid, of a live pid and of an old-style name', () => {
    // process.ppid is the jest parent (alive); pid 1 gives EPERM unless run as root: alive too.
    const kept = [
      `c4pm-export-${process.pid}-abc`,
      `c4pm-export-${process.ppid}-abc`,
      'c4pm-export-1-abc',
      'c4pm-export-abc123',
    ];
    for (const n of kept) mkdir(n);
    removeStaleExports();
    expect(names()).toEqual([...kept].sort());
  });

  it('still removes any export dir older than 24 h, with or without a pid, and leaves other names', () => {
    const day = 25 * 60 * 60 * 1000;
    mkdir('c4pm-export-abc123', day);
    mkdir(`c4pm-export-${process.ppid}-abc`, day);
    mkdir('c4pm-other-abc', day);
    fs.writeFileSync(path.join(tmpRoot, `c4pm-export-${deadPid}-file`), 'not a dir');
    removeStaleExports();
    expect(names()).toEqual([`c4pm-export-${deadPid}-file`, 'c4pm-other-abc']);
  });
});
