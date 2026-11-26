import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import type { ViewModel, ViewNode } from '../src/types';
import { runViewerScripts, type FakeEl, type HarnessResult } from './helpers/viewer-harness';
import { runCli } from './helpers/runCli';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const E = require('../viewer/edit.js');

// SR3 (b693, K 2026-11-12 Q1-Q3, Q5): the Auto arrange header button puts the selected container (its boxes, its frames
// and its own size; its top-left stays) or the selected subregion (its frame and its boxes) back to the automatic layout,
// as one undo entry. The export lists the nodes back at auto that the plan had a layout for as null.

// layers-claim: api has the subregions logic (orders) and data (store). Every box below api is hand-placed: api is
// larger, orders and store moved, the data frame placed.
const FIX = path.join(__dirname, 'fixtures', 'layers-claim');
const HAND = (t: string) => t
  .replace("    api = container 'Api' {", "    api = container 'Api' {\n      metadata { layout ';30,74,500,600' }")
  .replace("        orders = component 'Orders' {", "        orders = component 'Orders' {\n          metadata { layout ';120,160,360,254' }")
  .replace("      data = layer 'Data' {", "      data = layer 'Data' {\n        metadata { layout ';15,330,330,210' }")
  .replace("        store = component 'Store' {", "        store = component 'Store' {\n          metadata { layout ';60,420,360,254' }");

/** A temp copy of layers-claim with its plan text changed by `edit`. */
function copyFixture(edit: (text: string) => string = (t) => t): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sr3-'));
  fs.cpSync(FIX, dir, { recursive: true });
  const file = path.join(dir, 'c4', 'plan.c4');
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  return dir;
}

type Rect = { x: number; y: number; w: number; h: number };
type VN = ViewNode & { parent?: VN };
const all = (n: ViewNode): ViewNode[] => [n, ...(n.subregions ?? []), ...n.children.flatMap(all)];
const find = (root: ViewNode, id: string): ViewNode => all(root).find((x) => x.id === id)!;

// The build without layout metadata, frames fitted as the page fits them (placeFrames).
let plainApi: ViewNode;
beforeAll(() => {
  plainApi = find(buildView({ repo: FIX }).model.root, 'api');
  E.placeFrames(plainApi);
});

/** Every rect below `api` (regions, bubbles, frames) relative to api's top-left, and api's own size. */
function below(api: ViewNode): Record<string, number[]> {
  const out: Record<string, number[]> = { api: [api.w, api.h] };
  const rel = (r: Rect) => [r.x - api.x, r.y - api.y, r.w, r.h];
  for (const n of all(api).slice(1)) {
    out[n.id] = rel(n);
    if (n.bubble) out[`bubble:${n.id}`] = rel(n.bubble);
  }
  return out;
}
const expectClose = (got: Record<string, number[]>, want: Record<string, number[]>, tol: number) => {
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  for (const k of Object.keys(want)) {
    want[k].forEach((v, i) => {
      if (Math.abs(got[k][i] - v) > tol) throw new Error(`${k}[${i}]: ${got[k][i]} vs ${v} (tolerance ${tol})`);
    });
  }
};

/** The page of `model` in edit mode with api open. */
function page(model: ViewModel) {
  const h = runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop'] });
  h.frames.flush();
  const map = h.sandbox.C4PM_MAP as {
    nodeById: (id: string) => VN; flyTo: (id: string) => void; select: (id: string | null) => boolean;
    setEdit: (on: boolean) => void; exportLayout: () => { version: number; nodes: Record<string, unknown> };
  };
  map.flyTo('api');
  h.frames.runToCompletion();
  map.setEdit(true);
  const doc = h.sandbox.document as { getElementById: (id: string) => FakeEl & { onclick?: () => void; disabled?: boolean; hidden?: boolean } };
  const btn = (id: string) => doc.getElementById(id);
  const arrange = (id: string) => { map.select(id); btn('btn-arrange').onclick!(); h.frames.flush(); };
  return { h, map, btn, arrange, api: map.nodeById('api') };
}
const rectsOf = (h: HarnessResult, ids: string[]) => {
  const map = h.sandbox.C4PM_MAP as { nodeById: (id: string) => VN };
  return ids.map((id) => E.rectOf(map.nodeById(id)));
};

describe('Auto arrange (SR3 b693) on a hand-placed container', () => {
  const handModel = () => buildView({ repo: copyFixture(HAND) }).model;

  it('the plan is hand-placed: the page differs from the build without layout metadata', () => {
    const { api } = page(handModel());
    expect(() => expectClose(below(api), below(plainApi), 1e-6)).toThrow();
  });

  it('gives the layout of the plan without layout metadata (relative to api; api keeps its top-left); no frame is placed', () => {
    const { api, arrange } = page(handModel());
    const [x0, y0] = [api.x, api.y];
    arrange('api');
    expectClose(below(api), below(plainApi), 1e-9);   // exact: the auto rects are not rounded
    expect([api.x, api.y]).toEqual([x0, y0]);
    expect(api.subregions!.map((l) => !!l.placed)).toEqual([false, false]);
  });

  it('is one undo entry: btn-undo restores every rect, bean and placed flag; btn-redo arranges again', () => {
    const { h, api, btn, arrange } = page(handModel());
    const ids = all(api).map((n) => n.id).concat([api.parent!.id]);
    const before = rectsOf(h, ids);
    arrange('api');
    const after = rectsOf(h, ids);
    expect(after).not.toEqual(before);
    expect(btn('btn-undo').disabled).toBe(false);
    btn('btn-undo').onclick!();
    expect(rectsOf(h, ids)).toEqual(before);
    expect(btn('btn-undo').disabled).toBe(true);
    btn('btn-redo').onclick!();
    expect(rectsOf(h, ids)).toEqual(after);
  });

  it('export: null for orders, store and data (back at auto); apply-layout then rebuild: no layout below api, the rects of the plain build', () => {
    const repo = copyFixture(HAND);
    const { map, arrange } = page(buildView({ repo }).model);
    arrange('api');
    const out = map.exportLayout();
    expect(out.nodes).toEqual({ 'shop.api.logic.orders': null, 'shop.api.data': null, 'shop.api.data.store': null, api: expect.any(Object) });

    const file = path.join(repo, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(out));
    expect(runCli(['plan', 'apply-layout', '--repo', repo, '--file', file, '--force']).status).toBe(0);
    const text = fs.readFileSync(path.join(repo, 'c4', 'plan.c4'), 'utf8');
    expect(text.split('\n').filter((l) => l.includes("layout '"))).toHaveLength(1);   // api's own (its top-left stays)
    expect(text).toMatch(/api = container 'Api' \{\n\s+metadata \{ layout '/);
    const api = find(buildView({ repo }).model.root, 'api');
    E.placeFrames(api);
    expect(api.subregions!.map((l) => l.placed)).toEqual([undefined, undefined]);
    expectClose(below(api), below(plainApi), api.scale! * 2);   // integers in local units
  });
});

describe('Auto arrange (SR3 b693) on one subregion', () => {
  it('only the data frame and its store change: the store back at its auto slot, the frame back to auto', () => {
    const { h, api, map, arrange } = page(buildView({ repo: copyFixture(HAND) }).model);
    const others = ['api', 'shop.api.logic', 'shop.api.logic.orders', 'web', 'shop.web.pages'];
    const before = rectsOf(h, others);
    arrange('shop.api.data');
    expect(rectsOf(h, others)).toEqual(before);
    const data = map.nodeById('shop.api.data'), store = map.nodeById('shop.api.data.store');
    expect(data.placed).toBeUndefined();
    const want = below(plainApi)['shop.api.data.store'];
    expectClose({ s: below(api)['shop.api.data.store'] }, { s: want }, 1e-9);
    expect(store.x >= data.x && store.y >= data.y && store.x + store.w <= data.x + data.w && store.y + store.h <= data.y + data.h).toBe(true);
    expect(Object.keys(map.exportLayout().nodes).sort()).toEqual(['shop.api.data', 'shop.api.data.store']);
  });
});

describe('the Auto arrange button (SR3 b693, Q3)', () => {
  it('next to Reset layout; enabled in edit mode for a selected container or subregion only; hidden outside edit mode', () => {
    const html = renderViewHtml(buildView({ repo: FIX }).model);
    expect(html).toMatch(/id="btn-reset"[^\n]*\n\s*<button id="btn-arrange" hidden disabled /);
    const { map, btn } = page(buildView({ repo: FIX }).model);
    const b = btn('btn-arrange');
    expect([b.hidden, b.disabled]).toEqual([false, true]);   // nothing selected
    map.select('shop.api.logic.orders');
    expect(b.disabled).toBe(true);
    map.select('api');
    expect(b.disabled).toBe(false);
    map.select('shop.api.data');
    expect(b.disabled).toBe(false);
    map.setEdit(false);
    expect([b.hidden, b.disabled]).toEqual([true, true]);
    const CT = (page(buildView({ repo: FIX }).model).h.sandbox.C4PM_CONTROLS) as { autoArrangeSelected: () => boolean };
    expect(CT.autoArrangeSelected()).toBe(false);   // nothing selected
  });
});
