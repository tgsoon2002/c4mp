import path from 'path';
import { parseC4 } from '../src/plan/parser';
import { isClaimModePlan } from '../src/c4/ownership';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { runSnapshot } from '../src/index';
import { Plan, BuildInput, FileOutline, SnapshotMeta, ViewModel, ViewNode } from '../src/types';

// P14-T44a: a plan element with no code yet shows in folder mode (ViewNode.planOnly).
const C4_FILE = '../plans/shop.c4';

const GREENFIELD = [
  'model {',
  "  shop = system 'Shop' {",
  "    api = container 'API' {",
  "      technology 'Node.js'",
  "      auth = component 'Auth' {",
  '        metadata {',
  "          status 'done'",
  "          owner 'kien'",
  '        }',
  '      }',
  "      orders = component 'Orders' {",
  '      }',
  '    }',
  "    web = container 'Web' {",
  "      technology 'React'",
  "      cart = component 'Cart' {",
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function modelFor(plan: Plan, outlines: FileOutline[] = []): ViewModel {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/shop', repoName: 'Shop', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const input: BuildInput = { meta, containers: [], components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
  return buildViewModel(buildSnapshot(input, plan), 'test', plan, new Map());
}

function allNodes(n: ViewNode, out: ViewNode[] = []): ViewNode[] {
  out.push(n);
  n.children.forEach((c) => allNodes(c, out));
  return out;
}

function nodeById(m: ViewModel, id: string): ViewNode | undefined {
  return allNodes(m.root).find((n) => n.id === id);
}

describe('plan-only containers and components in folder mode (P14-T44a)', () => {
  it('greenfield plan: 2 container and 3 component nodes, all planOnly, under their plan container', () => {
    const m = modelFor(planFrom(GREENFIELD));
    const planOnly = allNodes(m.root).filter((n) => n.planOnly === true);
    expect(planOnly.filter((n) => n.kind === 'container').map((n) => n.id).sort()).toEqual(['shop.api', 'shop.web']);
    expect(planOnly.filter((n) => n.kind === 'component').map((n) => n.id).sort()).toEqual([
      'shop.api.auth',
      'shop.api.orders',
      'shop.web.cart',
    ]);
    expect(nodeById(m, 'shop.api')?.children.map((c) => c.id).sort()).toEqual(['shop.api.auth', 'shop.api.orders']);
    expect(nodeById(m, 'shop.web')?.children.map((c) => c.id)).toEqual(['shop.web.cart']);
  });

  it('greenfield plan: status and owner pills in meta; weight 1; plan origin', () => {
    const m = modelFor(planFrom(GREENFIELD));
    const auth = nodeById(m, 'shop.api.auth');
    expect(auth?.meta).toEqual({ status: 'done', owner: 'kien' });
    expect(auth?.weight).toBe(1);
    expect(auth?.origin?.kind).toBe('plan');
    expect(nodeById(m, 'shop.api.orders')?.meta).toBeUndefined();
  });

  it('plan whose elements all match scanned code (sample fixture): no planOnly nodes, container ids unchanged', () => {
    const repo = path.join(__dirname, 'fixtures/sample');
    const snapshot = runSnapshot({ repo, write: false, quiet: true });
    const scannedIds = snapshot.containers.map((c) => c.id).sort();
    // one plan container per scanned container; localId(shop.api) === 'api' matches the scanned id
    const plan = planFrom(
      ['model {', "  shop = system 'Shop' {", ...scannedIds.map((id) => `    ${id} = container '${id}' {\n    }`), '  }', '}'].join('\n'),
    );
    const m = buildViewModel(snapshot, 'sample', plan, new Map());
    expect(allNodes(m.root).filter((n) => n.planOnly === true)).toEqual([]);
    expect(m.root.children.filter((n) => n.kind === 'container').map((n) => n.id).sort()).toEqual(scannedIds);
  });

  it('claim-mode plan: no planOnly nodes (claim path untouched)', () => {
    const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
    const outlines: FileOutline[] = [{ file: 'scripts/run.ts', lineCount: 5, parseError: false, elements: [fn('runAll', 1, 5)] }];
    const claimText = [
      'model {',
      "  shop = system 'Shop' {",
      "    extra = container 'Extra' {",
      "      scripts = component 'Scripts' {",
      '        link ../scripts/run.ts#runAll',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const plan = planFrom(claimText);
    expect(isClaimModePlan(plan)).toBe(true);
    const m = modelFor(plan, outlines);
    expect(allNodes(m.root).filter((n) => n.planOnly === true)).toEqual([]);
  });
});

// P14-T44c-a: a folder-mode plan component that already stands for a scanned component gets no planOnly twin.
// The plan file sits in the generate-c4 folder, so '../../../../x' links resolve to repo-root 'x'.
const SHOP_FILE = '.c4pm/projects/sample-shop/plan/api.c4';

function planIn(text: string, file: string): Plan {
  const r = parseC4(text, file);
  return { files: [file], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function comp(id: string, title: string, link?: string): string[] {
  return [`      ${id} = component '${title}' {`, ...(link ? [`        link ${link}`] : []), '      }'];
}

function folderPlan(apiLines: string[], webLines: string[] = []): Plan {
  return planIn(
    [
      'model {',
      "  sample_shop = system 'Sample Shop' {",
      "    api = container 'API' {",
      ...apiLines,
      '    }',
      "    web = container 'Web' {",
      ...webLines,
      '    }',
      '  }',
      '}',
    ].join('\n'),
    SHOP_FILE,
  );
}

const API_SAMPLE = [
  ...comp('lib', 'Lib', '../../../../api/src/lib/'),
  ...comp('models', 'Models', '../../../../api/src/models/'),
  ...comp('root_files', 'Root files', '../../../../api/src/server.ts'),
  ...comp('routes', 'Routes', '../../../../api/src/routes/'),
  ...comp('services', 'Services', '../../../../api/src/services/'),
];
const WEB_SAMPLE = [
  ...comp('components', 'Components', '../../../../web/src/components/'),
  ...comp('root_files', 'Root files', '../../../../web/src/App.tsx'),
];

describe('folder-mode plan component that stands for a scanned component (P14-T44c-a)', () => {
  const sampleRepo = path.join(__dirname, 'fixtures/sample');
  const sampleSnapshot = () => runSnapshot({ repo: sampleRepo, write: false, quiet: true });

  it('generate-c4 shape of the sample: no planOnly component, no duplicate component name in a container', () => {
    const m = buildViewModel(sampleSnapshot(), 'sample', folderPlan(API_SAMPLE, WEB_SAMPLE), new Map());
    const comps = allNodes(m.root).filter((n) => n.kind === 'component');
    expect(comps.filter((n) => n.planOnly === true)).toEqual([]);
    for (const container of allNodes(m.root).filter((n) => n.kind === 'container')) {
      const names = container.children.filter((n) => n.kind === 'component').map((n) => n.name);
      expect(new Set(names).size).toBe(names.length);
    }
    expect(nodeById(m, 'api/lib')?.origin?.kind).toBe('scanned');
    expect(nodeById(m, 'web/_root')?.origin?.kind).toBe('scanned');
  });

  it('a plan component with no link and no matching folder keeps its planOnly node (origin plan)', () => {
    const plan = folderPlan([...comp('auth', 'Auth', '../../../../api/src/auth/'), ...comp('jobs', 'Jobs')]);
    const m = buildViewModel(sampleSnapshot(), 'sample', plan, new Map());
    for (const id of ['sample_shop.api.auth', 'sample_shop.api.jobs']) {
      expect(nodeById(m, id)?.planOnly).toBe(true);
      expect(nodeById(m, id)?.origin?.kind).toBe('plan');
    }
  });

  it('two plan components linking the same folder: the first (by id) stands for it, the second keeps a planOnly node', () => {
    const plan = folderPlan([...comp('lib', 'Lib', '../../../../api/src/lib/'), ...comp('lib2', 'Lib two', '../../../../api/src/lib/')]);
    const m = buildViewModel(sampleSnapshot(), 'sample', plan, new Map());
    expect(nodeById(m, 'sample_shop.api.lib')).toBeUndefined();
    expect(nodeById(m, 'sample_shop.api.lib2')?.planOnly).toBe(true);
    expect(nodeById(m, 'api/lib')?.origin?.kind).toBe('scanned');
  });

  it('a file link inside a sub-folder of a scanned folder (exact match, not inside) keeps its planOnly node', () => {
    const plan = folderPlan([...comp('auth', 'Auth', '../../../../api/src/lib/auth/index.ts')]);
    const m = buildViewModel(sampleSnapshot(), 'sample', plan, new Map());
    expect(nodeById(m, 'sample_shop.api.auth')?.planOnly).toBe(true);
    expect(nodeById(m, 'api/lib')?.planOnly).toBeUndefined();
  });

  it('plan root_files with no links stands for scanned _root: no twin', () => {
    const plan = folderPlan([...comp('root_files', 'Root files')]);
    const m = buildViewModel(sampleSnapshot(), 'sample', plan, new Map());
    expect(nodeById(m, 'sample_shop.api.root_files')).toBeUndefined();
    expect(nodeById(m, 'api/_root')?.origin?.kind).toBe('scanned');
  });

  // B14: the stand-in carries the plan's title, status, id and relations onto the scanned node.
  it('B14: scanned node takes the plan title, status and plan id; a relation between two stand-ins is drawn', () => {
    const plan = folderPlan([
      "      lib = component 'Library' {",
      '        link ../../../../api/src/lib/',
      '        metadata {',
      "          status 'in-progress'",
      '        }',
      '      }',
      ...comp('models', 'Models', '../../../../api/src/models/'),
    ]);
    plan.relations.push({ from: 'sample_shop.api.lib', to: 'sample_shop.api.models', label: 'reads', source: { file: SHOP_FILE, line: 99 } });
    const m = buildViewModel(sampleSnapshot(), 'sample', plan, new Map());
    const n = nodeById(m, 'api/lib');
    expect(n?.name).toBe('Library');
    expect(n?.meta?.status).toBe('in-progress');
    expect(n?.planId).toBe('sample_shop.api.lib');
    expect(nodeById(m, 'sample_shop.api.lib')).toBeUndefined();
    expect(m.relations).toEqual([expect.objectContaining({ from: 'api/lib', to: 'api/models', label: 'reads' })]);
    expect(m.edges.some((e) => e.from === 'api/lib' && e.to === 'api/models')).toBe(true);
  });

  it('path normalisation: a leading ./ and a file link inside the folder both match the scanned component', () => {
    for (const link of ['./api/src/lib/', './api/src/lib/log.ts']) {
      const plan = folderPlan([...comp('lib', 'Lib', '../../../../api/src/lib/')]);
      plan.elements.find((e) => e.id === 'sample_shop.api.lib')!.links[0].path = link;
      const m = buildViewModel(sampleSnapshot(), 'sample', plan, new Map());
      expect(nodeById(m, 'sample_shop.api.lib')).toBeUndefined();
      expect(nodeById(m, 'api/lib')?.origin?.kind).toBe('scanned');
    }
  });
});

describe('relations between plan-only elements (EXT-1)', () => {
  const WITH_RELATIONS = GREENFIELD.replace(/\n\}$/, "\n  shop.web -> shop.api 'calls'\n  shop.web.cart -> shop.api.orders 'places order'\n  shop.api.auth -> shop.api.orders\n}");

  it.each([
    ['container to container', 'shop.web', 'shop.api'],
    ['component to component, across containers', 'shop.web.cart', 'shop.api.orders'],
    ['component to component, same container', 'shop.api.auth', 'shop.api.orders'],
  ])('%s: edge and relation drawn', (_name, from, to) => {
    const m = modelFor(planFrom(WITH_RELATIONS));
    expect(m.edges).toContainEqual({ from, to, weight: 1 });
    expect(m.relations?.some((r) => r.from === from && r.to === to)).toBe(true);
  });

  it('every declared relation is kept (none dropped as unresolved)', () => {
    const plan = planFrom(WITH_RELATIONS);
    expect(plan.relations).toHaveLength(3);
    expect(modelFor(plan).relations).toHaveLength(3);
  });
});
