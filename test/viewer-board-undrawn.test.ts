import { boardPage, sampleBoard } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B17b: the b-item panel tells apart a uid whose plan element exists but is not drawn from a real dead link.

const all = (root: FakeEl, cls: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });
  walk(root);
  return out;
};

describe('P16-B17b undrawn link vs dead link', () => {
  const p = boardPage({
    board: m => {
      const b = sampleBoard(m);
      // b3: one valid-but-undrawn uid (no finding), one unknown uid (finding), one hostile uid text
      b.boards[0].items[2].deadLinks = ['plan-only-uid', 'unknown-uid', '<img src=x onerror=alert(1)>'];
      b.findings = [
        { severity: 'warning', rule: 'board-dead-link', id: 'b3', message: "b3: link 'unknown-uid' matches no plan element" },
        { severity: 'warning', rule: 'board-dead-link', id: 'b4', message: "b4: link 'plan-only-uid' matches no plan element" },   // other item: must not leak to b3
        { severity: 'info', rule: 'board-overdue', id: 'b3', message: "b3: link 'plan-only-uid' matches no plan element" },        // other rule: ignored
      ];
      return b;
    },
  });

  it('unknown uid keeps the dead marker; a valid undrawn uid gets its own marker and wording; text only', () => {
    p.sandbox.C4PM_BOARD.select('b3');
    const panel = serializeText(p.h.panel);
    expect(panel).toContain('○ plan-only-uid');
    expect(all(p.h.panel, 'bd-dead').map(d => d.textContent)).toEqual(['✗ unknown-uid']);
    const undrawn = all(p.h.panel, 'bd-undrawn');
    expect(undrawn.map(d => d.textContent)).toEqual(['○ plan-only-uid', '○ <img src=x onerror=alert(1)>']);
    expect((all(p.h.panel, 'bd-dead')[0] as any).title).toMatch(/^Unknown uid/);
    expect((undrawn[0] as any).title).toMatch(/^No node on the map/);
    expect(all(p.h.panel, 'bd-undrawn').every(d => !(d.children || []).some(c => c.tagName === 'IMG'))).toBe(true);
  });
});
