import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Component, Container, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// P14-T8: ViewNode.uid copied from the plan element's `uid` metadata (optional, ids untouched).
const C4_FILE = '../plans/arch.c4';
const UID_SYS = '00000000-0000-4000-8000-000000000001';
const UID_WEB = '00000000-0000-4000-8000-000000000002';
const UID_AUTH = '00000000-0000-4000-8000-000000000003';

function c4Text(withUid: boolean, withLinks: boolean): string {
  const meta = (u: string): string[] => (withUid ? [`metadata { uid '${u}' }`] : []);
  return [
    'model {',
    "  app = system 'Claim App' {",
    ...meta(UID_SYS),
    "    web = container 'Web' {",
    ...meta(UID_WEB),
    "      auth = component 'Auth' {",
    ...meta(UID_AUTH),
    ...(withLinks ? ['        link ../src/util.ts#formatDate'] : []),
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function snapshotFor(plan: Plan) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = [{ id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
  const outlines: FileOutline[] = [{ file: 'src/util.ts', lineCount: 5, parseError: false, elements: [fn('formatDate', 1, 5)] }];
  // Folder mode (no #fn links): a folder component must own the file; its id is a folder id, not a plan fqn.
  const components: Component[] = plan.elements.some((e) => e.kind === 'component' && e.links?.length)
    ? []
    : [{ id: 'web/src', name: 'Src', containerId: 'web', path: 'src', files: ['src/util.ts'] }];
  const input: BuildInput = { meta, containers, components, outlines, imports: [], componentEdges: [], fileEdges: [] };
  return buildSnapshot(input, plan);
}

function all(n: ViewNode, out: ViewNode[] = []): ViewNode[] {
  out.push(n);
  n.children.forEach((c) => all(c, out));
  return out;
}
const find = (n: ViewNode, id: string): ViewNode | undefined => all(n).find((x) => x.id === id);
const strip = (nodes: ViewNode[]) => nodes.map(({ uid: _u, ...rest }) => rest);

describe('ViewNode.uid (P14-T8)', () => {
  const plan = planFrom(c4Text(true, true));
  const model = buildViewModel(snapshotFor(plan), 's', plan);

  it('claim mode: system, container, component carry the plan uid', () => {
    expect(model.root.uid).toBe(UID_SYS);
    expect(find(model.root, 'web')!.uid).toBe(UID_WEB);
    expect(find(model.root, 'app.web.auth')!.uid).toBe(UID_AUTH);
  });

  it('slice, file and function nodes have no uid', () => {
    const others = all(model.root).filter((n) => !['system', 'container', 'component'].includes(n.kind));
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect('uid' in n).toBe(false);
  });

  it('plan without uids: model equals the one with uids once uid is stripped; no node has key uid', () => {
    const planNo = planFrom(c4Text(false, true));
    const modelNo = buildViewModel(snapshotFor(planNo), 's', planNo);
    expect(all(modelNo.root).some((n) => 'uid' in n)).toBe(false);
    expect(strip(all(model.root)).map((n) => ({ ...n, children: undefined, planBlock: undefined, origin: undefined }))).toEqual(
      strip(all(modelNo.root)).map((n) => ({ ...n, children: undefined, planBlock: undefined, origin: undefined }))
    );
  });

  it('ambiguous container local id: no uid, no throw', () => {
    const text = [
      'model {',
      "  a = system 'A' {",
      "    web = container 'Web' {",
      `      metadata { uid '${UID_WEB}' }`,
      '    }',
      '  }',
      "  b = system 'B' {",
      "    web = container 'Web' {",
      `      metadata { uid '${UID_AUTH}' }`,
      '    }',
      '  }',
      '}',
    ].join('\n');
    const p = planFrom(text);
    let m: ReturnType<typeof buildViewModel> | undefined;
    expect(() => { m = buildViewModel(snapshotFor(p), 's', p); }).not.toThrow();
    expect(find(m!.root, 'web')!.uid).toBeUndefined();
  });

  it('folder-mode plan (no #fn links) with uids: system and container nodes get uid', () => {
    const p = planFrom(c4Text(true, false));
    const m = buildViewModel(snapshotFor(p), 's', p);
    expect(m.root.uid).toBe(UID_SYS);
    expect(find(m.root, 'web')!.uid).toBe(UID_WEB);
  });
});
