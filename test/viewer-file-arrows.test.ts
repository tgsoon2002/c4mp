import { renderViewHtml } from '../src/page/html';
import type { ViewEdge, ViewModel, ViewNode } from '../src/types';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// b896 (K 2026-11-19, option 2): file -> file arrows inside a box. A box with at most 20 file edges shows them all; a
// bigger box shows only the arrows of the card that holds the selection (the card, or a node inside it). Glow on every
// file arrow: out = the from-card holds the selection, inn = the to-card holds it. Component edges are unchanged.
// Runs the real render.js visibleEdges on the nav-view sample, with hand-made file cards in two components.

const SMALL = 'api/utils', BIG = 'api/models';
const X = `${BIG}/x.ts`, FN = `${X}#run`;
const card = (n: number) => `${BIG}/f${n}.ts`;

/** The sample with SMALL holding cards s0..s2 (2 file edges) and BIG holding X (with function FN) + f1..f21 (21 file edges). */
function model(): ViewModel {
  const m = loadSample();
  const comps = m.root.children.find((c) => c.id === 'api')!.children;
  const tpl = comps.find((c) => c.id === SMALL)!.children[0];   // a file card with one function card inside
  const fileCard = (id: string, fn?: string): ViewNode => {
    const c = JSON.parse(JSON.stringify(tpl)) as ViewNode;
    c.id = id;
    c.file = id;
    c.children = fn ? [{ ...c.children[0], id: fn, children: [] }] : [];
    return c;
  };
  comps.find((c) => c.id === SMALL)!.children = ['s0', 's1', 's2'].map((s) => fileCard(`${SMALL}/${s}.ts`));
  comps.find((c) => c.id === BIG)!.children = [fileCard(X, FN), ...Array.from({ length: 21 }, (_, i) => fileCard(card(i + 1)))];
  const e = (from: string, to: string): ViewEdge => ({ from, to, weight: 1 });
  m.fileEdges = [
    e(`${SMALL}/s0.ts`, `${SMALL}/s1.ts`), e(`${SMALL}/s1.ts`, `${SMALL}/s2.ts`),
    ...Array.from({ length: 10 }, (_, i) => e(X, card(i + 1))),        // X -> f1..f10
    ...Array.from({ length: 10 }, (_, i) => e(card(i + 11), X)),       // f11..f20 -> X
    e(card(1), card(21)),                                              // not touching X
  ];
  return m;
}

const m = model();
const w = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop', 'search-mode', 'search-hint'], globals: { location: { href: 'file:///x.html', hash: '' } } }).sandbox.window as any;
const all = (n: ViewNode): ViewNode[] => [n, ...n.children.flatMap(all)];

/** visibleEdges with every node down to the file cards open (function cards closed) and `sel` selected. */
function visible(sel: string | null, open: (n: ViewNode) => boolean = (n) => n.kind !== 'function') {
  const { map } = w.C4PM_STATE;
  for (const k of Object.keys(map.alpha)) delete map.alpha[k];
  all(m.root).filter(open).forEach((n) => { map.alpha[n.id] = 1; });
  map.selectedId = sel;
  const list = w.C4PM_RENDER.edges.visibleEdges() as Array<{ A: ViewNode; B: ViewNode; out: boolean; inn: boolean; file?: boolean }>;
  const tag = (v: (typeof list)[number]) => `${v.A.id}>${v.B.id}${v.out ? ' out' : ''}${v.inn ? ' inn' : ''}`;
  return { file: list.filter((v) => v.file).map(tag).sort(), comp: list.filter((v) => !v.file).map(tag).sort() };
}
const inBig = (list: string[]) => list.filter((s) => s.startsWith(`${BIG}/`));

describe('b896 file arrows inside a box', () => {
  it('a box with 2 file edges, nothing selected: both arrows, no glow', () => {
    expect(visible(null).file.filter((s) => s.startsWith(`${SMALL}/`))).toEqual([`${SMALL}/s0.ts>${SMALL}/s1.ts`, `${SMALL}/s1.ts>${SMALL}/s2.ts`]);
  });

  it('a box with 21 file edges, nothing selected: no file arrows', () => {
    expect(inBig(visible(null).file)).toEqual([]);
  });

  const xArrows = [
    ...Array.from({ length: 10 }, (_, i) => `${X}>${card(i + 1)} out`),
    ...Array.from({ length: 10 }, (_, i) => `${card(i + 11)}>${X} inn`),
  ].sort();

  it.each([['the card X', X], ['a function inside X', FN]])('big box, %s selected: only the arrows touching X, out from X, inn into X', (_, sel) => {
    expect(inBig(visible(sel).file)).toEqual(xArrows);
  });

  it('big box itself selected, or a card of another box: none of its file arrows', () => {
    expect(inBig(visible(BIG).file)).toEqual([]);
    expect(inBig(visible(`${SMALL}/s1.ts`).file)).toEqual([]);
  });

  it('small box: a selected card glows its own arrows (out / inn), the others stay plain', () => {
    expect(visible(`${SMALL}/s1.ts`).file).toEqual([`${SMALL}/s0.ts>${SMALL}/s1.ts inn`, `${SMALL}/s1.ts>${SMALL}/s2.ts out`]);
  });

  it('component edges are not changed by a selection', () => {
    const compsOnly = (n: ViewNode) => n.kind !== 'file' && n.kind !== 'function';   // components open, file cards closed
    expect(visible(null, compsOnly).file).toEqual([]);
    expect(visible('api/routes', compsOnly).comp).toEqual([
      'api/_root>api/routes inn', 'api/_root>api/utils', 'api/routes>api/payments out', 'api/routes>api/services out',
      'api/routes>api/utils out', 'api/services>api/models', 'api/services>api/routes inn',
    ].sort());
  });
});
