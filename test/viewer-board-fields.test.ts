import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B43: description, docs, outcome, size, and the kinds decision / question in the viewer (fake DOM).

let p: BoardPage;
let B: any;

const all = (root: FakeEl, cls: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const tag = (root: FakeEl, name: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.tagName === name) out.push(c); walk(c); });
  walk(root);
  return out;
};

beforeEach(() => {
  p = boardPage({
    board: (m) => {
      const b = sampleBoard(m);
      const items = b.boards[0].items;
      Object.assign(items[0], {
        description: 'First line\nSecond <b>line</b>',
        outcome: 'verified by <i>test</i>',
        size: 'L',
        docs: [
          { label: 'Design', path: 'docs/design.md' },
          { url: 'https://example.com/spec' },
          { label: 'Evil', url: 'javascript:alert(1)' },
        ],
      });
      Object.assign(items[1], { kind: 'decision' });
      Object.assign(items[2], { kind: 'question', size: 'XL', description: 'needle in a haystack' });
      return b;
    },
    extraIds: ['search-mode', 'search-hint'],   // SRCH-1: the Names / Content switch
  });
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
});

describe('P16-B43 detail panel', () => {
  it('shows description (text, not markup), outcome, docs and the size pill', () => {
    B.select('b1');
    const panel = p.h.panel;
    expect(all(panel, 'bd-size-pill')[0].textContent).toBe('Size: L');
    const desc = all(panel, 'bd-desc');
    expect(desc.map(d => d.textContent)).toEqual(['First line\nSecond <b>line</b>', 'verified by <i>test</i>']);
    expect(tag(panel, 'B').length).toBe(0);   // never parsed as markup
    expect(tag(panel, 'I').length).toBe(0);
    expect(serializeText(panel)).toContain('Documents (3)');
  });

  it('docs: http(s) url is a safe link; javascript: is plain text; a path has a Copy path button', () => {
    B.select('b1');
    const links = tag(p.h.panel, 'A') as any[];
    expect(links.length).toBe(1);
    expect(links[0].href).toBe('https://example.com/spec');
    expect(links[0].target).toBe('_blank');
    expect(links[0].rel).toBe('noopener noreferrer');
    expect(serializeText(p.h.panel)).toContain('javascript:alert(1)');
    const copy = all(p.h.panel, 'bd-copy');
    expect(copy.length).toBe(1);
    expect(copy[0].textContent).toBe('Copy path');
    expect(all(p.h.panel, 'bd-doc-path').map(x => x.textContent)).toEqual(['docs/design.md', 'javascript:alert(1)']);
  });

  it('an item without the new fields shows none of the new sections', () => {
    B.select('b5');
    const t = serializeText(p.h.panel);
    expect(t).not.toContain('Description');
    expect(t).not.toContain('Documents');
    expect(t).not.toContain('Outcome');
    expect(all(p.h.panel, 'bd-size-pill').length).toBe(0);
  });
});

describe('P16-B43 kinds, size chip, search', () => {
  const search = (q: string) => {
    p.h.search.value = q;
    p.h.search.dispatch('input', { target: p.h.search });
    p.h.flushTimers();
    return p.h.searchResults.querySelectorAll('.bd-search-result').map(r => /\b(b\d+)\b/.exec(serializeText(r))![1]);
  };

  it('search matches description text under Content, not under Names (SRCH-1, b235)', () => {
    expect(search('haystack')).toEqual([]);
    (p.sandbox.document as any).getElementById('search-mode').children.find((b: FakeEl) => b.textContent === 'Content').click();
    expect(search('haystack')).toEqual(['b3']);
  });

  it('decision and question get their own chip class and letter in the search row', () => {
    search('b3');
    const chip = p.h.searchResults.querySelectorAll('.bd-kind')[0];
    expect(chip.classList.contains('bk-question')).toBe(true);
    expect(chip.textContent).toBe('Q');
  });
});
