// b917 S3: scripts/media-record.js. makeSink, filmWindow and recordSim with a fake page (no browser).
// A real-browser run of the same code is made by scripts/release-media.js (test/release-media-chrome.test.ts).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rec = require('../scripts/media-record.js') as {
  makeSink(page: unknown, dir: string, fps: number): Sink;
  filmWindow(page: unknown, frames: Sink, seconds: number, activeMs: number): Promise<number>;
  recordSim(page: unknown, frames: Sink, opts?: { simId?: string; stepSec?: number; flyMs?: number; outroSec?: number }): Promise<{ steps: { i: number; from: number; frames: number }[] }>;
};
interface Sink { dir: string; fps: number; count(): number; hold(n: number): number; add(png: Buffer, repeat?: number): number; snap(repeat?: number): Promise<number> }

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media#record-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const png = (s: string) => Buffer.from(s);
const names = (dir: string) => fs.readdirSync(dir).sort();

describe('makeSink', () => {
  it('numbers frames f00001.png, f00002.png ... in one folder it creates', () => {
    const dir = path.join(tmp, 'a', 'b');
    const sink = rec.makeSink({}, dir, 10);
    sink.add(png('one'));
    sink.add(png('two'));
    expect(names(dir)).toEqual(['f00001.png', 'f00002.png']);
    expect(sink.count()).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'f00002.png'), 'utf8')).toBe('two');
  });

  it('a hold repeats the last frame as hard links (same inode, no extra data)', () => {
    const sink = rec.makeSink({}, tmp, 10);
    sink.add(png('first'), 3);   // written once, held twice more
    sink.add(png('next'));
    sink.hold(2);
    expect(names(tmp)).toEqual(['f00001.png', 'f00002.png', 'f00003.png', 'f00004.png', 'f00005.png', 'f00006.png']);
    const ino = (i: number) => fs.statSync(path.join(tmp, `f0000${i}.png`)).ino;
    expect([ino(2), ino(3)]).toEqual([ino(1), ino(1)]);
    expect([ino(5), ino(6)]).toEqual([ino(4), ino(4)]);
    expect(ino(4)).not.toBe(ino(1));
    expect(fs.statSync(path.join(tmp, 'f00001.png')).nlink).toBe(3);
    expect(fs.readFileSync(path.join(tmp, 'f00006.png'), 'utf8')).toBe('next');
  });

  it('hold before any frame throws; repeat below 1 adds nothing', () => {
    const sink = rec.makeSink({}, tmp, 10);
    expect(() => sink.hold(1)).toThrow(/before any frame/);
    expect(sink.add(png('x'), 0)).toBe(0);
    expect(names(tmp)).toEqual([]);
  });

  it('snap takes the shot of the page', async () => {
    let n = 0;
    const sink = rec.makeSink({ shot: async () => png('shot' + ++n) }, tmp, 10);
    await sink.snap();
    await sink.snap(2);
    expect(sink.count()).toBe(3);
    expect(fs.readFileSync(path.join(tmp, 'f00003.png'), 'utf8')).toBe('shot2');
  });
});

describe('recordSim', () => {
  const fakePage = (list: unknown, log: string[]) => ({
    shot: async () => png('p'),
    eval: async (expr: string) => {
      if (expr.includes('S.items()')) return list;
      log.push(expr);
      return undefined;
    },
  });

  it('presents the simulation, goes step by step, and shows each step stepSec seconds', async () => {
    const log: string[] = [];
    const sink = rec.makeSink(fakePage([{ id: 's-1', n: 3 }, { id: 's-2', n: 1 }], log), tmp, 4);
    const r = await rec.recordSim(fakePage([{ id: 's-1', n: 3 }, { id: 's-2', n: 1 }], log), sink, { stepSec: 1, flyMs: 0, outroSec: 0.5 });
    expect(log).toEqual(['window.C4PM_SIM.hooks.present("s-1", 0)', 'window.C4PM_SIM.hooks.presentGo(1)', 'window.C4PM_SIM.hooks.presentGo(2)']);
    expect(r.steps.map(s => s.frames)).toEqual([4, 4, 6]);   // 1 s at 4 fps; the last one 1.5 s
    expect(r.steps.map(s => s.from)).toEqual([1, 5, 9]);
    expect(sink.count()).toBe(14);
  });

  it('simId picks another simulation; an unknown one and a page without simulations throw', async () => {
    const log: string[] = [];
    const sink = rec.makeSink({}, tmp, 2);
    await rec.recordSim(fakePage([{ id: 's-1', n: 1 }, { id: 's-2', n: 1 }], log), sink, { simId: 's-2', stepSec: 1, flyMs: 0, outroSec: 0 });
    expect(log[0]).toBe('window.C4PM_SIM.hooks.present("s-2", 0)');
    await expect(rec.recordSim(fakePage([{ id: 's-1', n: 1 }], log), sink, { simId: 'x' })).rejects.toThrow(/no simulation x/);
    await expect(rec.recordSim(fakePage(null, log), sink)).rejects.toThrow(/no simulation/);
  });
});

describe('filmWindow', () => {
  it('fills exactly seconds * fps frames, holding each shot until the next', async () => {
    const sink = rec.makeSink({ shot: async () => png('x') }, tmp, 10);
    const page = { shot: async () => { await new Promise(r => setTimeout(r, 120)); return png('x'); } };
    const added = await rec.filmWindow(page, sink, 1.5, 300);
    expect(added).toBe(15);
    expect(sink.count()).toBe(15);
  });
});
