import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { watchRepo } from '../src/watch';
import { startProjectWatch, startWatch } from '../src/scan/watchSession';
import { openProject } from '../src/scan/project';
import { tryResolveProject } from '../src/outputs';
import type { SnapshotDiff } from '../src/types';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('startWatch', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-startwatch-')));
    fs.mkdirSync(path.join(repo, '.c4pm'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export function a() { return 1; }\n');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('takes the initial snapshot, then re-scans a changed file and hands back the diff', async () => {
    const starts: (string[] | undefined)[] = [];
    const diffs: SnapshotDiff[] = [];
    const errors: unknown[] = [];
    const stop = startWatch(repo, { languages: ['typescript'] }, {
      debounceMs: 100,
      onScanStart: (files) => starts.push(files),
      onSnapshot: (d) => diffs.push(d),
      onError: (e) => errors.push(e),
    });
    try {
      expect(starts).toEqual([undefined]);   // the initial scan ran before startWatch returned
      await sleep(200);
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export function a() { return 1; }\nexport function b() { return 2; }\n');
      await sleep(1000);
    } finally {
      stop();
    }
    expect(errors).toEqual([]);
    expect(starts).toEqual([undefined, ['src/a.ts']]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].summary.elementsAdded).toBe(1);
  }, 10000);

  it.each([
    ['an unreadable project config file', '.c4pm/config.json', '{ not json'],
    ['an unreadable legacy config file', '.c4pmrc.json', '{ not json'],
  ])('throws for %s before any scan', (_label, file, text) => {
    fs.writeFileSync(path.join(repo, file), text);
    const onScanStart = jest.fn();
    expect(() => startWatch(repo, {}, { debounceMs: 100, onScanStart, onSnapshot: jest.fn(), onError: jest.fn() }))
      .toThrow(path.join(repo, file));
    expect(onScanStart).not.toHaveBeenCalled();
  });
});

describe('watch', () => {
  it('debounces file changes and filters by extension', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-watch-'));

    try {
      // Create src/ subdirectory
      fs.mkdirSync(path.join(tempDir, 'src'));
      fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });

      // Track callbacks
      const callbacks: string[][] = [];

      // Start watching with debounce 300ms
      const stop = watchRepo(tempDir, {
        debounceMs: 300,
        ignore: [],
        extensions: ['.ts'],
        onChange: (files) => {
          callbacks.push([...files]);
        }
      });

      try {
        // Wait for watcher to warm up (~200ms)
        await new Promise(resolve => setTimeout(resolve, 200));

        // Write files quickly (within debounce window):
        // - src/a.ts (should be accepted)
        // - README.md (wrong extension, should be dropped)
        // - node_modules/x/index.ts (in IGNORE_DIRS, should be dropped)
        fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'const x = 1;');
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test');
        fs.mkdirSync(path.join(tempDir, 'node_modules/x'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'node_modules/x/index.ts'), 'export {};');

        // Wait for debounce to fire (1500ms should be plenty; 300ms debounce + margin)
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Should have exactly one callback with only src/a.ts
        expect(callbacks).toHaveLength(1);
        expect(callbacks[0]).toEqual(['src/a.ts']);

        // Now stop watching
        stop();

        // Write another file
        fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'const y = 2;');

        // Wait 800ms to ensure no additional callbacks
        await new Promise(resolve => setTimeout(resolve, 800));

        // Should still have only 1 callback (from before stop)
        expect(callbacks).toHaveLength(1);
      } finally {
        stop();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('drops the selected languages default build folders (C# bin/ and obj/) but keeps them for other languages (b161)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-watch-'));
    try {
      for (const d of ['src', 'bin', 'obj']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
      const run = async (languages: string[]): Promise<string[]> => {
        const callbacks: string[][] = [];
        const stop = watchRepo(tmp, { debounceMs: 100, ignore: [], languages, extensions: ['.cs'], onChange: f => callbacks.push([...f]) });
        try {
          await new Promise(r => setTimeout(r, 200));
          for (const f of ['src/A.cs', 'bin/B.cs', 'obj/C.cs']) fs.writeFileSync(path.join(tmp, f), 'class X {}' + callbacks.length);
          await new Promise(r => setTimeout(r, 1000));
        } finally {
          stop();
        }
        return callbacks.flat().sort();
      };
      expect(await run(['csharp'])).toEqual(['src/A.cs']);
      expect(await run(['rust'])).toEqual(['bin/B.cs', 'obj/C.cs', 'src/A.cs']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  it('drops events under the C4PM export folder at an anchor but keeps a nested C4PM folder', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-watch-'));
    try {
      fs.mkdirSync(path.join(tmp, '.c4pm'));
      for (const d of ['src', 'C4PM', 'src/C4PM']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
      const callbacks: string[][] = [];
      const stop = watchRepo(tmp, { debounceMs: 100, ignore: [], extensions: ['.ts'], onChange: f => callbacks.push([...f]) });
      try {
        await new Promise(r => setTimeout(r, 200));
        fs.writeFileSync(path.join(tmp, 'src/a.ts'), 'export {};');
        fs.writeFileSync(path.join(tmp, 'C4PM/x.ts'), 'export {};');
        fs.writeFileSync(path.join(tmp, 'src/C4PM/y.ts'), 'export {};');
        await new Promise(r => setTimeout(r, 1000));
        expect(callbacks.flat().sort()).toEqual(['src/C4PM/y.ts', 'src/a.ts']);
      } finally {
        stop();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 10000);
});

// b679 (SV3): one list of input folders (projectInputRoots) feeds the watcher: plan, wireframes, board and s-items
// inside `.c4pm/` are seen; data/ and .git/ are not. Real fs.watch events, so generous waits and timeouts.
describe('startProjectWatch (b679)', () => {
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const run = async (repo: string, change: () => void): Promise<string[]> => {
    const callbacks: string[][] = [];
    const { config } = openProject(repo, { languages: ['typescript'] });
    const stop = startProjectWatch(repo, config, { debounceMs: 100, onChange: f => callbacks.push([...f]) });
    try {
      // warm-up; macOS can deliver the setup writes (made before the watch started) late: drop what came in so far
      await sleep(500);
      callbacks.length = 0;
      change();
      await sleep(1500);
    } finally {
      stop();
    }
    return [...new Set(callbacks.flat())].sort();
  };
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-projwatch-'))); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reports plan, wireframe, board and s-item changes under .c4pm/, drops data/ and .git/', async () => {
    fs.mkdirSync(path.join(tmp, '.c4pm'));
    fs.mkdirSync(path.join(tmp, '.git'));
    const projectDir = tryResolveProject(tmp)!.projectDir;
    const rel = (f: string): string => path.relative(tmp, path.join(projectDir, f)).split(path.sep).join('/');
    for (const f of ['plan/arch.c4', 'plan/io/x.html', 'board/board.json', 'sim/s-1.json', 'data/x.json']) write(path.join(projectDir, f), 'x');
    write(path.join(tmp, '.git', 'HEAD'), 'ref: x');
    write(path.join(tmp, 'src', 'a.ts'), 'export {};');
    const seen = await run(tmp, () => {
      for (const f of ['board/board.json', 'sim/s-1.json', 'plan/io/x.html', 'plan/arch.c4', 'data/x.json']) write(path.join(projectDir, f), 'y');
      write(path.join(tmp, '.git', 'HEAD'), 'ref: y');
      write(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;');
    });
    expect(seen).toEqual([rel('board/board.json'), rel('plan/arch.c4'), rel('plan/io/x.html'), rel('sim/s-1.json'), 'src/a.ts']);
  }, 10000);

  it('anchor above the repo (plan outside the repo root, like C4PM): plan changes are absolute; a sim folder made later is seen', async () => {
    fs.mkdirSync(path.join(tmp, '.c4pm'));
    const repo = path.join(tmp, 'Project');
    write(path.join(repo, 'src', 'a.ts'), 'export {};');
    const projectDir = tryResolveProject(repo)!.projectDir;
    write(path.join(projectDir, 'plan', 'arch.c4'), 'x');
    write(path.join(projectDir, 'board', 'board.json'), 'x');
    const seen = await run(repo, () => {
      write(path.join(projectDir, 'plan', 'arch.c4'), 'y');
      write(path.join(projectDir, 'sim', 's-1.json'), '{}');   // sim/ did not exist when the watch started
      write(path.join(projectDir, 'history', 'h.json'), '{}');
    });
    expect(seen).toEqual([path.join(projectDir, 'plan', 'arch.c4'), path.join(projectDir, 'sim', 's-1.json')]);
  }, 10000);
});
