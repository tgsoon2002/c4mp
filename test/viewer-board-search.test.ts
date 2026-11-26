import { boardPage, sampleBoard } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import type { ViewBoard, ViewModel } from '../src/types';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B34: the search box also finds board items (fake DOM). Fixture: sampleBoard (b1..b6 on 'sprint', b5 on 'backlog', b9 on archived 'old').

let p: BoardPage;
let B: any;

const rows = (cls: string): FakeEl[] => p.h.searchResults.querySelectorAll('.' + cls);
const type = (q: string) => { p.h.search.value = q; p.h.search.dispatch('input', { target: p.h.search }); };
const key = (k: string) => p.h.search.dispatch('keydown', { key: k, target: p.h.search });
const boardIds = () => rows('bd-search-result').map(r => /\b(b\d+)\b/.exec(serializeText(r))![1]);

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
});

describe('P16-B34 search finds board items', () => {
  it('an id finds the item; a row shows kind, id, title, status and the board name; a label heads the rows', () => {
    type('b1');
    expect(boardIds()).toEqual(['b1']);
    const t = serializeText(rows('bd-search-result')[0]);
    expect(t).toContain('F');                // kind letter of a feature
    expect(t).toContain('b1');
    expect(t).toContain('Quiz generator');
    expect(t).toContain('in-progress');
    expect(t).toContain('Sprint S12');
    expect(rows('bd-search-label').map(l => l.textContent)).toEqual(['Board items']);
    expect(rows('pn-search-result').length).toBe(0);
  });

  it('a tag, an owner and a title word find the item (case does not matter)', () => {
    type('QUIZ');
    expect(boardIds()).toEqual(['b1', 'b3']);   // b1: tag 'quiz' and title; b3: "makeQuiz" in the title
    type('kim');
    expect(boardIds()).toEqual(['b1']);   // owner
    type('translate');
    expect(boardIds()).toEqual(['b5']);   // title on the other board
    type('zzzz');
    expect(boardIds()).toEqual([]);
    expect(rows('bd-search-label').length).toBe(0);
  });

  it('an item of an archived board is not offered; at most 10 rows', () => {
    type('b9');
    expect(boardIds()).toEqual([]);
    const many = boardPage({ board: manyItems });
    const q = many.h.search;
    q.value = 'item';
    q.dispatch('input', { target: q });
    expect(many.h.searchResults.querySelectorAll('.bd-search-result').length).toBe(10);
  });

  it('an empty query leaves no board rows; Escape (the panel clears the box) leaves none', () => {
    type('b1');
    expect(boardIds().length).toBe(1);
    type('');
    expect(boardIds()).toEqual([]);
    type('b1');
    key('Escape');
    expect(boardIds()).toEqual([]);
    expect(p.h.search.value).toBe('');
  });

  it('a click opens the board, selects the item and clears the box and the results', () => {
    expect(B.isOpen()).toBe(false);
    type('b3');
    rows('bd-search-result')[0].click();
    expect(B.isOpen()).toBe(true);
    expect(B.selectedId()).toBe('b3');
    expect(p.h.search.value).toBe('');
    expect(p.h.searchResults.children.length).toBe(0);
  });

  it('Enter on a query that matches only an item selects it', () => {
    type('batch');
    expect(rows('pn-search-result').length).toBe(0);
    key('Enter');
    expect(B.selectedId()).toBe('b5');
  });

  it('Enter with a map node and an item both matching goes to the map node and does not select the item', () => {
    type('routes');   // the map node "Routes"; no board item has that word
    expect(rows('pn-search-result').length).toBeGreaterThan(0);
    type('api');   // map nodes named api* AND the tag 'api' of b1
    expect(rows('pn-search-result').length).toBeGreaterThan(0);
    expect(boardIds()).toEqual(['b1']);
    key('Enter');
    expect(B.selectedId()).toBeNull();
    expect(p.h.searchResults.children.length).toBe(0);   // the panel took the first map result and cleared the list
  });

  it('the "No results" line of the panel is dropped when board rows follow, and kept when nothing matches', () => {
    type('batch');
    expect(serializeText(p.h.searchResults)).not.toContain('No results');
    type('zzzz');
    expect(serializeText(p.h.searchResults)).toContain('No results');
  });

  it('titles and owners are text, never markup', () => {
    type('onerror');
    expect(boardIds()).toEqual(['b6']);
    const row = rows('bd-search-result')[0];
    expect(serializeText(row)).toContain('<img src=x onerror=alert(1)>');
    const walk = (n: FakeEl): FakeEl[] => [n, ...(n.children || []).flatMap(walk)];
    expect(walk(row).filter(n => n.tagName === 'IMG').length).toBe(0);
    expect(row.innerHTML).toBe('');
  });

  it('a second provider with the id "board" throws', () => {
    const add = () => p.sandbox.C4PM_SEARCH.registerSearchProvider({ id: 'board', names: () => [], content: () => [] });
    expect(add).toThrow("search provider 'board' is already registered");
  });

  it('a page without a board: search is exactly the panel\'s', () => {
    const q = boardPage({ board: false });
    q.h.search.value = 'b1';
    q.h.search.dispatch('input', { target: q.h.search });
    expect(q.h.searchResults.querySelectorAll('.bd-search-result').length).toBe(0);
  });
});

// SRCH-1 (b235): Names = what an item is called (id, title, owner, tags); Content = what it says (description, outcome).
describe('SRCH-1 board rows: Names finds names, Content finds what an item says', () => {
  let c: BoardPage;
  const modeBtn = (label: string): FakeEl => (c.sandbox.document as any).getElementById('search-mode').children.find((b: FakeEl) => b.textContent === label);
  const find = (q: string): string[] => {
    c.h.search.value = q;
    c.h.search.dispatch('input', { target: c.h.search });
    c.h.flushTimers();
    return c.h.searchResults.querySelectorAll('.bd-search-result').map(r => /\b(b\d+)\b/.exec(serializeText(r))![1]);
  };
  beforeEach(() => { c = boardPage({ board: describedBoard, extraIds: ['search-mode', 'search-hint'] }); });

  it('a word only in a description or an outcome: Content finds it after the debounce, Names does not', () => {
    expect(find('quokka')).toEqual([]);
    expect(find('verifiedby')).toEqual([]);
    modeBtn('Content').click();
    c.h.search.value = 'quokka';
    c.h.search.dispatch('input', { target: c.h.search });
    expect(c.h.searchResults.querySelectorAll('.bd-search-result').length).toBe(0);   // debounce not yet fired
    c.h.flushTimers();
    expect(find('quokka')).toEqual(['b1']);
    expect(c.h.searchResults.querySelectorAll('.bd-search-label').map(l => l.textContent)).toEqual(['Board items']);
    expect(find('verifiedby')).toEqual(['b4']);
  });

  it('a word in the title, id, owner or a tag: Names finds it, Content does not', () => {
    expect(find('generator')).toEqual(['b1']);   // title
    expect(find('b3')).toEqual(['b3']);          // id
    expect(find('kim')).toEqual(['b1']);         // owner
    expect(find('quiz')).toEqual(['b1', 'b3']);  // tag of b1, title of b3
    modeBtn('Content').click();
    expect(find('generator')).toEqual([]);
    expect(find('kim')).toEqual([]);
    expect(find('quiz')).toEqual([]);
    expect(serializeText(c.h.searchResults)).toContain('No results');
  });

  // Phase 25 UI6 (b756): a `first: true` provider (the s-items) lists its rows before the map rows and the source hits; the others stay after.
  it('a first provider: its rows come before the map rows (Names) and the source hits (Content); the board rows stay last', () => {
    const lead = (text: string) => { const e = (c.sandbox.document as any).createElement('div'); e.className = 'lead-row'; e.textContent = text; return { el: e }; };
    c.sandbox.C4PM_SEARCH.registerSearchProvider({ id: 'lead', first: true, names: (q: string) => [lead('N ' + q)], content: (q: string) => [lead('C ' + q)] });
    const order = () => c.h.searchResults.children.map((r: FakeEl) => r._classes.has('lead-row') ? 'lead' : r._classes.has('bd-search-label') || r._classes.has('bd-search-result') ? 'board' : 'map');
    find('quiz');
    expect(order()[0]).toBe('lead');
    expect(order().slice(1).includes('lead')).toBe(false);
    expect(order()[order().length - 1]).toBe('board');
    modeBtn('Content').click();
    find('quokka');
    expect(c.h.searchResults.children[0].textContent).toBe('C quokka');
    expect(order()[order().length - 1]).toBe('board');
  });

  it('a Content row picks like a Names row: opens the board, selects the item, clears the box', () => {
    modeBtn('Content').click();
    find('quokka');
    c.h.search.dispatch('keydown', { key: 'Enter', target: c.h.search });
    expect(c.sandbox.C4PM_BOARD.selectedId()).toBe('b1');
    expect(c.h.search.value).toBe('');
    expect(c.h.searchResults.children.length).toBe(0);
  });
});

// the sample board with a description on b1 and an outcome on b4 (words no name, id, owner or tag holds)
function describedBoard(m: ViewModel): ViewBoard {
  const b = sampleBoard(m);
  const items = b.boards[0].items;
  items[0].description = 'Asks a Quokka question per page.';
  items[3].outcome = 'fixed in abc123, verifiedBy the refund test';
  return b;
}

// 12 items whose title contains "item", all on one board
function manyItems(_m: ViewModel): ViewBoard {
  const base = { kind: 'task', status: 'planned', dependsOn: [], links: [], tags: [], linked: [], deadLinks: [] };
  const items = Array.from({ length: 12 }, (_, i) => ({ ...base, id: 'x' + i, title: 'item number ' + i }));
  return { statuses: ['planned'], kinds: ['task'], findings: [], boards: [{ id: 'many', name: 'Many', groups: [], items }] };
}
