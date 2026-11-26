// b917 S2: scripts/media-frames.js, pure camera curve, frame names, ffmpeg argument lists and limits.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mf = require('../scripts/media-frames.js') as {
  easeInOut(p: number): number;
  camAt(from: Cam, to: Cam, p: number, cw: number, ch: number): Cam;
  legCount(seconds: number, fps: number): number;
  frameName(n: number): string;
  mp4Args(dir: string, fps: number, out: string, o?: { crf?: number; padSec?: number }): string[];
  gifArgs(dir: string, fps: number, out: string, rung: Rung, o?: { padSec?: number }): string[];
  GIF_LADDER: { hero: Rung[]; sim: Rung[] };
  MP4_CRF_LADDER: number[];
  LIMITS: { heroMp4: number; simMp4: number; gif: number; png: number };
};
interface Cam { s: number; tx: number; ty: number }
interface Rung { width: number; gifFps: number; colors: number }

const A: Cam = { s: 1, tx: 10, ty: 20 };
const B: Cam = { s: 4, tx: -300, ty: -90 };
const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1];

describe('scripts/media-frames.js', () => {
  it('easeInOut hits its fixed points', () => {
    expect([0, 0.25, 0.5, 1].map(mf.easeInOut)).toEqual([0, 0.125, 0.5, 1]);
  });

  it('camAt starts at from, ends at to, clamps p, and zooms on a log scale', () => {
    const at = (c: Cam, p: number) => mf.camAt(c, B, p, 1280, 800);
    for (const [got, want] of [[at(A, 0), A], [at(A, 1), B], [at(A, -1), A], [at(A, 2), B]] as [Cam, Cam][]) {
      expect(got.s).toBeCloseTo(want.s, 9);
      expect(got.tx).toBeCloseTo(want.tx, 9);
      expect(got.ty).toBeCloseTo(want.ty, 9);
    }
    expect(mf.camAt({ s: 1, tx: 0, ty: 0 }, { s: 4, tx: 0, ty: 0 }, 0.5, 1280, 800).s).toBeCloseTo(2, 9);
  });

  it('legCount rounds but never gives 0; frameName pads to 5 digits', () => {
    expect(mf.legCount(1.6, 30)).toBe(48);
    expect(mf.legCount(0.001, 30)).toBe(1);
    expect(mf.frameName(7)).toBe('f00007.png');
  });

  it('mp4Args builds the exact list, with tpad only when padSec > 0', () => {
    const a = mf.mp4Args('/d', 30, '/o/h.mp4', { padSec: 2 });
    expect(after(a, '-crf')).toBe('23');
    expect(a).toContain('+faststart');
    expect(after(a, '-vf')).toBe('tpad=stop_mode=clone:stop_duration=2,format=yuv420p');
    expect(after(a, '-i')).toBe('/d/f%05d.png');
    expect(a[a.length - 1]).toBe('/o/h.mp4');
    expect(after(mf.mp4Args('/d', 30, '/o/h.mp4'), '-vf')).toBe('format=yuv420p');
    expect(after(mf.mp4Args('/d', 30, '/o/h.mp4', { crf: 26 }), '-crf')).toBe('26');
  });

  it('gifArgs scales and limits colours from the rung and loops forever', () => {
    const a = mf.gifArgs('/d', 30, '/o/h.gif', mf.GIF_LADDER.hero[0]);
    expect(after(a, '-vf')).toContain('scale=720:-1');
    expect(after(a, '-vf')).toContain('max_colors=128');
    expect(after(a, '-vf')).toContain('fps=12');
    expect(after(a, '-vf')).not.toContain('tpad');
    expect(a.slice(-3)).toEqual(['-loop', '0', '/o/h.gif']);
    expect(after(mf.gifArgs('/d', 30, '/o/h.gif', mf.GIF_LADDER.sim[0], { padSec: 1 }), '-vf')).toMatch(/^tpad=stop_mode=clone:stop_duration=1,fps=10,/);
  });

  it('ladders step down and the GIF limit stays under 10 MiB', () => {
    for (const rungs of [mf.GIF_LADDER.hero, mf.GIF_LADDER.sim]) {
      const widths = rungs.map(r => r.width);
      expect(widths).toEqual([...widths].sort((x, y) => y - x));
    }
    expect(mf.MP4_CRF_LADDER).toEqual([23, 26, 29]);
    expect(mf.LIMITS.gif).toBeLessThan(10 * 1048576);
  });
});
