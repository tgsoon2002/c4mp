import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// b909: the component box subtitle is fitted (leading links + 'N more'), never squeezed by fillText's maxWidth.
// The harness measures 6 px per character.

const h = runViewerScripts(renderViewHtml(loadSample()));
const w = h.sandbox.window as any;
const fit: (m: (s: string) => number, t: string, max: number) => string = w.C4PM_RENDER.text.fitDetail;
const m = (s: string) => s.length * 6;

describe('b909 fitDetail', () => {
  it('fits: returned as is', () => {
    expect(fit(m, 'a + b', 100)).toBe('a + b');
    expect(fit(m, '', 100)).toBe('');
  });

  it("a ' + ' list: leading parts that fit, then ' + N more'", () => {
    const text = ['a/one', 'a/two', 'a/three', 'a/four', 'a/five', 'a/six', 'a/seven'].join(' + ');
    const out = fit(m, text, 150);
    expect(out).toMatch(/^a\/one( \+ a\/\w+)* \+ \d+ more$/);
    expect(m(out)).toBeLessThanOrEqual(150);
    const kept = out.split(' + ').length - 1;
    expect(out.endsWith(` + ${7 - kept} more`)).toBe(true);
    expect(kept).toBeGreaterThan(1);
  });

  it('first part too long: cut with an ellipsis, suffix kept', () => {
    const out = fit(m, 'a-very-long-path/to/some/file.ts + b + c', 120);
    expect(out).toMatch(/^a-very.*… \+ 2 more$|^a-very.*… \+ 2 more$/);
    expect(m(out)).toBeLessThanOrEqual(120);
  });

  it("no ' + ': cut with an ellipsis; '' when nothing fits", () => {
    const out = fit(m, 'abcdefghijklmnopqrstuvwxyz', 60);
    expect(out).toBe('abcdefghi…');
    expect(fit(m, 'abcdef', 3)).toBe('');
  });
});

describe('b909 box subtitle is drawn without maxWidth squeeze', () => {
  it('drawBubbleText: a long link list shows fitted, fillText gets no 4th argument', () => {
    const calls: unknown[][] = [];
    const ctx = w.C4PM_STATE.map.ctx;
    ctx.fillText = (...a: unknown[]) => { calls.push(a); };
    const n = { ...w.C4PM_STATE.nodeById['api/routes'], detail: Array.from({ length: 20 }, (_, i) => `src/api/file${i}.ts`).join(' + ') };
    w.C4PM_RENDER.text.drawBubbleText(n, { x: 0, y: 0, w: 240, h: 120 }, 1);
    const sub = calls.find((c) => String(c[0]).includes('more'))!;
    expect(sub).toBeDefined();
    expect(String(sub[0])).toMatch(/^src\/api\/file0\.ts.* \+ \d+ more$/);
    expect(sub.length).toBe(3);
    delete ctx.fillText;
  });
});
