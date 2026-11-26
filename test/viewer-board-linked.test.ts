import { boardPage, sampleBoard } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B31: a c-item's panel lists the b-items that touch it (fake DOM).

let p: BoardPage;
let B: any;
let M: any;

const all = (root: FakeEl, cls: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });   // text nodes have no children
  walk(root);
  return out;
};
const section = () => all(p.h.panel, 'pn-section').find(s => serializeText(s.children[0]).startsWith('Board items'));
const rows = () => all(section()!, 'bd-row');

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  M = p.sandbox.C4PM_MAP;
});

describe('P16-B31 board items in a c-item panel', () => {
  it('a component linked by 2 items shows 2 rows (kind letter, id, title, status), in board order', () => {
    M.select('api/payments');   // b2 (sprint) and b5 (backlog)
    expect(serializeText(section()!.children[0]).trim()).toBe('Board items (2)');
    expect(rows().map(r => r.children.map(c => c.textContent))).toEqual([
      ['T', 'b2', 'Define format', 'done'],
      ['F', 'b5', 'Batch translate', 'planned'],
    ]);
  });

  it('the section comes after what panel.js drew, which is still there', () => {
    M.select('api/payments');
    const kids = p.h.panel.children;
    expect(kids[kids.length - 1]).toBe(section());
    expect(kids.length).toBeGreaterThan(2);
  });

  it('a file node, a node with no board items and null show no section', () => {
    M.select('api/src/routes/orders.ts');
    expect(section()).toBeUndefined();
    M.select('api/utils');   // a component, but nothing links it
    expect(section()).toBeUndefined();
    M.select(null);
    expect(section()).toBeUndefined();
  });

  it('items of an archived board are not listed', () => {
    M.select('api/routes');   // b1 and the archived b9
    expect(rows().map(r => r.children[1].textContent)).toEqual(['b1']);
  });

  it('clicking a row selects the b-item and opens the drawer; the panel then shows the b-item', () => {
    M.select('api/payments');
    rows()[1].click();
    expect(B.selectedId()).toBe('b5');
    expect(B.isOpen()).toBe(true);
    expect(M.selectedId()).toBeNull();
    expect(serializeText(p.h.panel)).toContain('Batch translate');
    expect(section()).toBeUndefined();   // the b-item panel replaced the c-item panel
  });

  it('selecting a b-item does not add a section (the map select(null) has no node)', () => {
    B.select('b2');
    expect(section()).toBeUndefined();
  });

  it('text only: a title or kind with markup is not parsed', () => {
    const q = boardPage({ board: m => {
      const b = sampleBoard(m);
      b.boards[0].items[4].linked = b.boards[0].items[0].linked;
      b.boards[0].items[4].links = b.boards[0].items[0].links;
      b.boards[0].items[4].kind = '<b>';
      return b;
    } });
    (q.sandbox.C4PM_MAP as any).select('api/routes');
    const sec = all(q.h.panel, 'pn-section').find(s => serializeText(s.children[0]).startsWith('Board items'))!;
    const rs = all(sec, 'bd-row');
    expect(rs.length).toBe(2);
    expect(serializeText(sec)).toContain('<img src=x onerror=alert(1)>');
    const walk = (n: FakeEl): FakeEl[] => [n, ...(n.children || []).flatMap(walk)];
    expect(walk(sec).some(n => n.tagName === 'IMG' || n.tagName === 'B')).toBe(false);
    expect(walk(sec).every(n => !n._html)).toBe(true);
    expect(rs[1].children[0].className).toBe('bd-kind');   // '<b>' is not a plain word: no bk- class
  });

  it('a page without a board has no such section (board-panel.js does nothing)', () => {
    const none = boardPage({ board: false });
    (none.sandbox.C4PM_MAP as any).select('api/payments');
    expect(serializeText(none.h.panel)).not.toContain('Board items');
  });
});
