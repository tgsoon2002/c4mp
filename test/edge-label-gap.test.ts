import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// Edge labels stay in the gap between two rects (render.js gapRoom, fitText).

describe('edge labels stay in the gap between cards', () => {
  const edges = () => (runViewerScripts(renderViewHtml(loadSample()), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: { href: 'file:///x.html', hash: '' } } }).sandbox.window as any).C4PM_RENDER.edges;
  const ctx: any = { measureText: (s: string) => ({ width: String(s).length * 6 }) };
  const A = { x: 0, y: 0, w: 100, h: 100 }, B = { x: 180, y: 0, w: 100, h: 100 };

  it('gapRoom: free half-width to the nearer card; unlimited when the box is clear of a card vertically', () => {
    const { gapRoom } = edges();
    expect(gapRoom(140, 50, 10, [A, B])).toBe(40);
    expect(gapRoom(120, 50, 10, [A, B])).toBe(20);
    expect(gapRoom(140, 300, 10, [A, B])).toBe(Infinity);
  });

  it('fitText: whole when it fits, cut with an ellipsis within the width, empty when there is no room', () => {
    const { fitText } = edges();
    expect(fitText(ctx, 'short', 100)).toBe('short');
    const cut = fitText(ctx, 'Open IO view in a new window (setting: This window)', 100);
    expect(cut.endsWith('…')).toBe(true);
    expect(ctx.measureText(cut).width).toBeLessThanOrEqual(100);
    expect(fitText(ctx, 'anything', 20)).toBe('');
  });
});
