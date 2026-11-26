import { boardPage, sampleBoard } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';

// P16-B30c: the map note and "Zoom to these c-items" in the fake DOM.

let p: BoardPage;
let B: any;
let M: any;
let flown: string[];

const note = () => (p.sandbox.document as any).getElementById('map-wrap').children.find((c: any) => c.id === 'bd-note');
const noteText = () => note().children[0].textContent;

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  M = p.sandbox.C4PM_MAP;
  flown = [];
  M.flyTo = (id: string) => { flown.push(id); };
});

describe('P16-B30c zoomToLinked', () => {
  it('two siblings give their parent as the target', () => {
    // b1 lights api/routes and api/payments (both components of the api container)
    B.select('b1');
    expect(B.zoomToLinked()).toBe(true);
    expect(flown).toEqual(['api']);
  });

  it('one id gives itself', () => {
    B.select('b5');   // api/payments only
    B.zoomToLinked();
    expect(flown).toEqual(['api/payments']);
  });

  it('ids in different containers give the common container or the root', () => {
    // b3 has no links in the fixture: give it one component of api and one of web
    const q = boardPage({ board: m => {
      const b = sampleBoard(m);
      const mk = (nodeId: string) => ({ uid: 'uid-' + nodeId, nodeId, name: nodeId, kind: 'component' as const, state: 'has-code' as const, findingCount: 0 });
      b.boards[0].items[2].linked = [mk('api/routes'), mk('web/_root')];
      b.boards[0].items[4].linked = [mk('api/routes'), mk('api/utils'), mk('api/models')];   // b6: three siblings
      return b;
    } });
    const f: string[] = [];
    (q.sandbox.C4PM_MAP as any).flyTo = (id: string) => { f.push(id); };
    const QB = q.sandbox.C4PM_BOARD as any;
    QB.select('b3');
    QB.zoomToLinked();
    QB.select('b6');
    QB.zoomToLinked();
    expect(f).toEqual(['sample-shop', 'api']);   // different containers: the system; three components of api: api
  });

  it('nothing selected, or no linked c-items: false and no flight', () => {
    expect(B.zoomToLinked()).toBe(false);
    B.select('b3');
    expect(B.zoomToLinked()).toBe(false);
    expect(flown).toEqual([]);
  });
});

describe('P16-B30c note', () => {
  it('lives in #map-wrap, hidden until a b-item is selected, hidden again after Esc', () => {
    expect(note().hidden).toBe(true);
    B.select('b1');
    expect(note().hidden).toBe(false);
    B.select(null);
    expect(note().hidden).toBe(true);
  });

  it('text for 2 lit c-items and 1 arrow, 1 lit c-item and 0 arrows, none lit', () => {
    B.select('b1');   // api/routes -> api/payments is the only edge between the two
    expect(noteText()).toBe('b1 · Quiz generator — 2 c-items lit, 1 arrow between them (Esc to clear)');
    B.select('b5');
    expect(noteText()).toBe('b5 · Batch translate — 1 c-item lit, 0 arrows between them (Esc to clear)');
    B.select('b3');
    expect(noteText()).toBe('b3 · Build makeQuiz — no c-items linked');
    expect(note().children[1].hidden).toBe(true);
  });

  it('links that exist only in the other view are counted as such, not as "no c-items linked" (b130)', () => {
    const q = boardPage({ board: m => {
      const b = sampleBoard(m);
      b.boards[0].items[2].linked = [{ uid: 'u-cart', nodeId: 'shop.web.cart', name: 'Cart', kind: 'screen' as any, state: 'has-code', findingCount: 0 }];
      return b;
    } });
    (q.sandbox.C4PM_BOARD as any).select('b3');
    const n = (q.sandbox.document as any).getElementById('map-wrap').children.find((c: any) => c.id === 'bd-note');
    expect(n.children[0].textContent).toBe('b3 · Build makeQuiz — 1 linked in the other view');
  });

  it('plural form for several arrows', () => {
    const q = boardPage({ board: m => {
      const b = sampleBoard(m);
      const mk = (nodeId: string) => ({ uid: 'uid-' + nodeId, nodeId, name: nodeId, kind: 'component' as const, state: 'has-code' as const, findingCount: 0 });
      b.boards[0].items[2].linked = [mk('api/routes'), mk('api/services')];   // routes <-> services: two edges
      return b;
    } });
    (q.sandbox.C4PM_BOARD as any).select('b3');
    const n = (q.sandbox.document as any).getElementById('map-wrap').children.find((c: any) => c.id === 'bd-note');
    expect(n.children[0].textContent).toBe('b3 · Build makeQuiz — 2 c-items lit, 2 arrows between them (Esc to clear)');
  });

  it('the button calls zoomToLinked (one flight)', () => {
    B.select('b1');
    note().children[1].click();
    expect(flown.length).toBe(1);
  });

  it('the note sets no display rule inline (found in real Chrome: it would beat the hidden attribute and show an empty box)', () => {
    expect(note().style.cssText).not.toMatch(/display/);
  });

  it('title text goes in as text, never as markup', () => {
    B.select('b6');
    expect(noteText()).toContain('<img src=x onerror=alert(1)>');
    expect(note().children[0].children.length).toBe(0);
    expect(note().children[0]._html).toBe('');
  });
});
