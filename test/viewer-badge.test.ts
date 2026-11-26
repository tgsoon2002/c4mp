import { boardPage, sampleBoard } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import type { ViewModel, ViewNode } from '../src/types';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B29: the count badge on map boxes that board items link to (fake canvas). Container boxes are drawn at the first zoom.

const walk = (n: ViewNode, fn: (n: ViewNode) => void) => { fn(n); n.children.forEach(c => walk(c, fn)); };

// sets boardCount the way attachBoard would: 2 on the api container, 12 on the web container, none on worker
function withCounts(m: ViewModel) {
  walk(m.root, n => { if (n.id === 'api') n.boardCount = 2; if (n.id === 'web') n.boardCount = 12; });
  return sampleBoard(m);
}

function drawn(p: BoardPage): string[] {
  p.h.fillTextLog.length = 0;
  p.sandbox.C4PM_MAP.draw();
  return p.h.fillTextLog.slice();
}

describe('P16-B29 board count badge', () => {
  it('a box with boardCount 2 gets one extra fillText("2"); 12 gets "12"; a box with no count gets none', () => {
    const p = boardPage({ board: withCounts });
    const on = drawn(p);
    expect(on.filter(t => t === '2').length).toBe(1);
    expect(on.filter(t => t === '12').length).toBe(1);
    p.sandbox.C4PM_MAP.setOverlay('board', false);
    const off = drawn(p);
    expect(off.filter(t => t === '2').length).toBe(0);
    expect(off.filter(t => t === '12').length).toBe(0);
    expect(on.length - off.length).toBe(2);   // the two badges, nothing else changed
    p.sandbox.C4PM_MAP.setOverlay('board', true);
    expect(drawn(p)).toEqual(on);
  });

  it('a page whose nodes have no boardCount draws exactly what it drew before', () => {
    const p = boardPage();   // sampleBoard sets no boardCount
    const on = drawn(p);
    p.sandbox.C4PM_MAP.setOverlay('board', false);
    expect(drawn(p)).toEqual(on);
  });

  it('a page without a board has no badge and the same default overlays', () => {
    const p = boardPage({ board: false });
    walk(p.model.root, n => { expect('boardCount' in n).toBe(false); });
    expect(p.sandbox.C4PM_MAP.overlays.board).toBe(true);
    expect(drawn(p).length).toBeGreaterThan(0);
  });

  it('the legend lists a "Board" toggle only on a page with a board, and it switches the overlay', () => {
    const labels = (p: BoardPage) => {
      const out: string[] = [];
      const walkEl = (e: FakeEl) => (e.children || []).forEach(c => { if (c.tagName === 'LABEL') out.push(c.children.map(x => (x as any).textContent || '').join('')); walkEl(c); });
      walkEl((p.sandbox.document as any).getElementById('legend'));
      return out;
    };
    const withBoard = boardPage();
    expect(labels(withBoard)).toContain('Board');
    expect(labels(withBoard).filter(t => t === 'Drift' || t === 'Findings' || t === 'Stubs').length).toBe(3);
    expect(labels(boardPage({ board: false }))).not.toContain('Board');
    const box = (() => {
      let found: FakeEl | null = null;
      const walkEl = (e: FakeEl) => (e.children || []).forEach(c => { if (c.tagName === 'LABEL' && (c.children[1] as any).textContent === 'Board') found = c.children[0]; walkEl(c); });
      walkEl((withBoard.sandbox.document as any).getElementById('legend'));
      return found as unknown as FakeEl;
    })();
    (box as any).checked = false;
    box.dispatch('change');
    expect(withBoard.sandbox.C4PM_MAP.overlays.board).toBe(false);
  });
});
