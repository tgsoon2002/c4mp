import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { loadQueryContext } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { depsOf } from '../src/query/deps';
import { getModel } from '../src/query/elements';
import { QueryError } from '../src/query/errors';
import { loadPanelScripts } from './helpers/panelScripts';

const FIX = path.join(__dirname, 'fixtures');
const PLAN = `specification {
  element system
  element container
  element component
}

model {
  shop = system 'Shop' {
    api = container 'API'
    web = container 'Web'
    ghost = container 'Ghost'
  }
  shop.api -> shop.web 'calls'
  shop.web -> shop.ghost 'later'
  shop.web -> shop.missing 'nowhere'
}
`;

/** sample (folder mode) + a cross-container import (web -> api/lib) + a plan with three relations: the second ends at a plan-only container (placed since EXT-1), the third at an element that does not exist (not placed). */
function sampleWithPlan(): QueryContext {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qdeps-'));
  fs.cpSync(path.join(FIX, 'sample'), repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'web/src/components/Api.ts'), "import { log } from '../../../api/src/lib/log';\nexport const x = log;\n");
  fs.writeFileSync(path.join(repo, 'architecture.c4'), PLAN);
  return loadQueryContext(repo);
}

// ---- the viewer's own numbers: real viewer/panel.js in a vm with a minimal fake DOM (as test/viewer-panel-deps.test.ts) ----
interface El { children: El[]; _classes: Set<string>; _text: string; nodeType?: number; [k: string]: any }
function el(): El {
  const e: El = {
    children: [], _classes: new Set(), _text: '', style: {}, title: '',
    appendChild(c: El) { e.children.push(c); return c; },
    addEventListener() {}, focus() {},
    classList: { add: (c: string) => { e._classes.add(c); } },
    get className() { return [...e._classes].join(' '); },
    set className(v: string) { e._classes = new Set(v.split(/\s+/).filter(Boolean)); },
    get textContent() { return e._text; },
    set textContent(v: string) { e._text = String(v); e.children = []; },
    get innerHTML() { return ''; },
    set innerHTML(_v: string) { e.children = []; },
  };
  return e;
}
const findAll = (root: El, pred: (e: El) => boolean, out: El[] = []): El[] => {
  for (const c of root.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
};
const textOf = (e: El): string =>
  [e._text, ...e.children.map((c) => (c.nodeType === 3 ? c._text : textOf(c)))].join(' ').replace(/\s+/g, ' ').trim();

/** What the panel shows for node `id`: chips of "Depends on" / "Used by" as sorted "Name ×N" lists. */
function panelChips(ctx: QueryContext, id: string): { out: string[]; in: string[] } {
  const data = JSON.parse(JSON.stringify(getModel(ctx)));
  const panel = el();
  const els: Record<string, El> = { panel, search: el(), 'search-results': el(), legend: el() };
  let onSelect: (n: unknown) => void = () => {};
  const sandbox: Record<string, any> = {
    console: { ...console, debug: () => {}, warn: () => {}, log: () => {} },
    Set, Map, Array, Object, String, Number, JSON, Math, RegExp,
    document: {
      getElementById: (i: string) => els[i] ?? null,
      createElement: () => el(),
      createTextNode: (t: string) => { const n = el(); n.nodeType = 3; n._text = t; return n; },
      head: el(),
      addEventListener: () => {},
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
  };
  sandbox.window = sandbox;
  sandbox.C4PM_DATA = data;
  sandbox.C4PM_MAP = {
    onSelect: (cb: (n: unknown) => void) => { onSelect = cb; },
    flyTo: () => {}, select: () => {}, overlays: {}, setOverlay: () => {},
  };
  vm.createContext(sandbox);
  // P20-T11 (b232): panel.js reads window.C4PM_SETTINGS, so the settings module runs first (as in the page)
  loadPanelScripts(sandbox);
  const find = (n: any): any => (n.id === id ? n : [...(n.subregions ?? []), ...n.children].map(find).find(Boolean));
  onSelect(find(data.root));
  const chips = (label: string): string[] => {
    const sec = findAll(panel, (e) => e.className === 'pn-section').find((s) => s.children[0] && textOf(s.children[0]) === label);
    return sec ? findAll(sec, (e) => e.className.includes('pn-dep-chip')).map(textOf).sort() : [];
  };
  return { out: chips('Depends on'), in: chips('Used by') };
}
const mine = (edges: { title: string; weight: number }[]): string[] => edges.map((e) => `${e.title} ×${e.weight}`).sort();

describe('depsOf', () => {
  const ctx = sampleWithPlan();

  it('component with edges in and out: summed weights, sorted weight desc then id', () => {
    const r = depsOf(ctx, 'api/routes');
    expect(r).toMatchObject({ id: 'api/routes', level: 'component', resolvedFrom: 'id' });
    expect(r.uses).toEqual([
      { id: 'api/lib', title: 'Lib', weight: 1 },
      { id: 'api/services', title: 'Services', weight: 1 },
    ]);
    expect(r.usedBy).toEqual([{ id: 'api/_root', title: depsOf(ctx, 'api/_root').title, weight: 1 }]);
    expect(r.declared).toEqual([]);
  });

  it('container roll-up: member edges to outside, other end rolled up to its container; same-container edges dropped', () => {
    const web = depsOf(ctx, 'web');
    expect(web.level).toBe('container');
    // web/components -> api/lib rolls up to api; the plan edge api -> web is kept as is
    // + the plan relation web -> ghost: ghost is a plan-only container, placed since EXT-1
    expect(web.uses).toEqual([{ id: 'api', title: 'Api', weight: 1 }, { id: 'shop.ghost', title: 'Ghost', weight: 1 }]);
    expect(web.usedBy).toEqual([{ id: 'api', title: 'Api', weight: 1 }]);
    const api = depsOf(ctx, 'api');
    expect(api.uses).toEqual([{ id: 'web', title: 'Web', weight: 1 }]);
    expect(api.usedBy).toEqual([{ id: 'web', title: 'Web', weight: 1 }]);   // web/components -> api/lib rolled up
  });

  it('declared relations and relations the map could not place', () => {
    const api = depsOf(ctx, 'api');
    expect(api.declared).toEqual([{ from: 'api', to: 'web', label: 'calls', source: { file: 'architecture.c4', line: 13 } }]);
    expect(api.unresolvedDeclared).toEqual([]);
    const web = depsOf(ctx, 'web');
    expect(web.declared.map((d) => d.label)).toEqual(['calls', 'later']);   // 'later' ends at the plan-only ghost (EXT-1)
    expect(web.unresolvedDeclared).toEqual([{ from: 'shop.web', to: 'shop.missing', reason: 'endpoint not found in the map' }]);   // no such element: still not placed
    // a container's declared list also covers relations of its components (none here), so lib's container 'api' sees 'calls' only
    expect(depsOf(ctx, 'api/lib').declared).toEqual([]);
  });

  it('element with no edges', () => {
    const r = depsOf(ctx, 'worker');
    expect(r).toMatchObject({ id: 'worker', level: 'container', uses: [], usedBy: [], declared: [], unresolvedDeclared: [] });
  });

  // Phase 28 LK-D: layers-claim has a container with two layers (logic, data) and a container without layers (web).
  const layered = loadQueryContext(path.join(FIX, 'layers-claim'));

  it.each([
    ['sample + plan', ctx, 8, 'api/routes', ['Lib ×1', 'Services ×1']],
    ['layers-claim (layers roll up to layers)', layered, 6, 'shop.api.logic', ['Data ×2']],
  ] as const)('numbers equal what the viewer panel shows (every container, subregion and component): %s', (_n, c, min, probe, probeOut) => {
    const ids: string[] = [];
    const walk = (n: any): void => { if (['container', 'subregion', 'component'].includes(n.kind)) ids.push(n.id); [...(n.subregions ?? []), ...n.children].forEach(walk); };
    walk(getModel(c).root);
    expect(ids.length).toBeGreaterThanOrEqual(min);
    for (const id of ids) {
      const panel = panelChips(c, id);
      const r = depsOf(c, id);
      expect({ id, out: mine(r.uses), in: mine(r.usedBy) }).toEqual({ id, out: panel.out, in: panel.in });
    }
    // and the numbers are not all empty
    expect(panelChips(c, probe).out).toEqual(probeOut);
  });

  it('subregion: deps roll up to the nearest subregion (a component outside any layer stays itself); declared covers its components', () => {
    const r = depsOf(layered, 'shop.api.logic');
    expect(r).toMatchObject({ id: 'shop.api.logic', level: 'subregion', title: 'Logic' });
    expect(r.uses).toEqual([{ id: 'shop.api.data', title: 'Data', weight: 2 }]);
    expect(r.usedBy).toEqual([{ id: 'shop.web.pages', title: 'Pages', weight: 2 }]);
    expect(r.declared.map((d) => d.label)).toEqual(['stores prices', 'places orders']);
  });

  it('phofast (plan with links absent): relations the map cannot place are reported, not dropped', () => {
    const pho = loadQueryContext(path.join(FIX, 'phofast'));
    const r = depsOf(pho, 'phofast.web');
    expect(r.level).toBe('container');
    // EXT-1: these three end at plan-only nodes, so the map places them (declared); nothing is left unplaced
    expect(r.declared.map((d) => `${d.from} -> ${d.to}`)).toEqual([
      'customer -> phofast.web',
      'kitchen -> phofast.web',
      'phofast.web -> phofast.api',
    ]);
    expect(r.unresolvedDeclared).toEqual([]);
  });

  it('level4 component without any edge', () => {
    const r = depsOf(loadQueryContext(path.join(FIX, 'level4')), 'billing');
    expect(r).toMatchObject({ level: 'component', uses: [], usedBy: [], declared: [], unresolvedDeclared: [] });
  });

  it('errors: not-found (with candidates), ambiguous (with candidates), invalid (system)', () => {
    const pho = loadQueryContext(path.join(FIX, 'phofast'));
    const err = (fn: () => unknown): QueryError => {
      try { fn(); } catch (e) { return e as QueryError; }
      throw new Error('expected a QueryError');
    };
    const nf = err(() => depsOf(pho, 'phofast.apj'));
    expect(nf).toBeInstanceOf(QueryError);
    expect(nf.code).toBe('not-found');
    expect(nf.candidates?.length).toBeGreaterThan(0);
    expect(nf.candidates!.length).toBeLessThanOrEqual(5);
    const amb = err(() => depsOf(pho, 'API'));   // title tier: container 'API' and folder component 'Api'
    expect(amb.code).toBe('ambiguous');
    expect(amb.candidates).toEqual(expect.arrayContaining(['phofast.api | API | container']));
    expect(amb.candidates!.every((c) => c.split(' | ').length === 3)).toBe(true);
    const sys = err(() => depsOf(ctx, 'sample-shop'));
    expect(sys.code).toBe('invalid');
  });
});
