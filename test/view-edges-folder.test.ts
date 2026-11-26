import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, PlanElement, PlanRelation, BuildInput, Container, SnapshotMeta } from '../src/types';

// P14-T35 (Q3): plan relations become drawn edges in folder mode too (no function-level claims).
const container = (id: string): PlanElement => ({
  id, kind: 'container', title: id, description: null, technology: null,
  links: [], metadata: {}, parent: null, source: { file: 'a.c4', line: 1 },
});
const rel = (from: string, to: string): PlanRelation => ({ from, to, label: null, source: { file: 'a.c4', line: 5 } });

function plan(relations: PlanRelation[]): Plan {
  return { files: ['a.c4'], elements: [container('shop.web'), container('shop.api')], relations, issues: [] };
}

function snapshot(ids: string[] = ['web', 'api']) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'r', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = ids.map((id) => ({ id, name: id, path: id, tech: 'Node.js', manifest: `${id}/package.json` }));
  const input: BuildInput = { meta, containers, components: [], outlines: [], imports: [], componentEdges: [], fileEdges: [] };
  return buildSnapshot(input);
}

describe('folder-mode plan relations as edges (P14-T35)', () => {
  it('a plan relation between two containers draws a weight-1 edge', () => {
    const p = plan([rel('shop.web', 'shop.api')]);
    const m = buildViewModel(snapshot(), 's', p);
    expect(m.edges).toEqual([{ from: 'web', to: 'api', weight: 1 }]);
  });

  it('repeated identical relations count once; self and unresolved relations are dropped', () => {
    const p = plan([rel('shop.web', 'shop.api'), rel('shop.web', 'shop.api'), rel('shop.web', 'shop.web'), rel('shop.web', 'shop.ghost')]);
    expect(buildViewModel(snapshot(), 's', p).edges).toEqual([{ from: 'web', to: 'api', weight: 1 }]);
  });

  it('underscore plan id resolves to a hyphen folder container (normalised)', () => {
    const p: Plan = { ...plan([rel('shop.api_gw', 'shop.user_svc')]), elements: [container('shop.api_gw'), container('shop.user_svc')] };
    const m = buildViewModel(snapshot(['api-gw', 'user-svc']), 's', p);
    expect(m.edges).toEqual([{ from: 'api-gw', to: 'user-svc', weight: 1 }]);
    expect(m.relations).toHaveLength(1);
  });

  it('ambiguous normalisation does not resolve', () => {
    const p = plan([rel('shop.api_x', 'shop.web')]);
    const m = buildViewModel(snapshot(['api-x', 'apiX', 'web']), 's', p);
    expect(m.edges).toEqual([]);
    expect(m.relations).toEqual([]);
  });

  it('exact localId still wins over a normalised match', () => {
    const p = plan([rel('shop.api_x', 'shop.web')]);
    const m = buildViewModel(snapshot(['api_x', 'api-x', 'web']), 's', p);
    expect(m.edges).toEqual([{ from: 'api_x', to: 'web', weight: 1 }]);
  });

  it('no plan, or a plan without relations: no edges (unchanged)', () => {
    expect(buildViewModel(snapshot(), 's').edges).toEqual([]);
    expect(buildViewModel(snapshot(), 's', plan([])).edges).toEqual([]);
  });
});
