import { parseC4 } from '../src/plan/parser';
import { buildViewModel, PLAN_BLOCK_MAX_LINES } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewNode } from '../src/types';

// P13-T2b: ViewNode.planBlock. Real parser output (so endLine is the real one), claim-mode snapshot.
const C4_FILE = '../plans/arch.c4';
const C4_TEXT = [
  'model {',                                   // 1
  "  app = system 'Claim App' {",              // 2
  "    web = container 'Web' {",               // 3
  "      auth = component 'Auth' {",           // 4
  '        link ../src/util.ts#formatDate',    // 5
  '      }',                                   // 6
  "      orders = component 'Orders' {",       // 7
  '        link ../src/order.ts#createOrder',  // 8
  '      }',                                   // 9
  '    }',                                     // 10
  '  }',                                       // 11
  '}',                                         // 12
].join('\n');

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function snapshotFor(plan: Plan) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = [{ id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
  const outlines: FileOutline[] = [
    { file: 'src/util.ts', lineCount: 5, parseError: false, elements: [fn('formatDate', 1, 5)] },
    { file: 'src/order.ts', lineCount: 5, parseError: false, elements: [fn('createOrder', 1, 5)] },
  ];
  const input: BuildInput = { meta, containers, components: [], outlines, imports: [], componentEdges: [], fileEdges: [] };
  return buildSnapshot(input, plan);
}

function find(n: ViewNode, id: string): ViewNode | undefined {
  if (n.id === id) return n;
  for (const c of n.children) {
    const f = find(c, id);
    if (f) return f;
  }
  return undefined;
}

describe('ViewNode.planBlock (P13-T2b)', () => {
  const plan = planFrom(C4_TEXT);
  const snap = snapshotFor(plan);
  const texts = new Map([[C4_FILE, C4_TEXT]]);

  it('claim mode: component block is its own lines; container block includes children', () => {
    const m = buildViewModel(snap, 's', plan, texts);
    const auth = find(m.root, 'app.web.auth')!;
    expect(auth.planBlock).toEqual({ file: C4_FILE, startLine: 4, endLine: 6, lines: C4_TEXT.split('\n').slice(3, 6) });
    const web = find(m.root, 'web')!;
    expect(web.planBlock).toMatchObject({ file: C4_FILE, startLine: 3, endLine: 10 });
    expect(web.planBlock!.lines).toHaveLength(8);
    expect(web.planBlock!.lines.join('\n')).toContain("orders = component 'Orders'");
  });

  it('nodes without a plan element (slices, files, functions) have no planBlock', () => {
    const m = buildViewModel(snap, 's', plan, texts);
    const walk = (n: ViewNode): void => {
      if (n.kind !== 'system' && n.kind !== 'container' && n.kind !== 'component') expect(n.planBlock).toBeUndefined();
      n.children.forEach(walk);
    };
    walk(m.root);
  });

  it('omitted when planTexts is absent, lacks the file, or the id is ambiguous', () => {
    expect(find(buildViewModel(snap, 's', plan).root, 'app.web.auth')!.planBlock).toBeUndefined();
    expect(find(buildViewModel(snap, 's', plan, new Map()).root, 'app.web.auth')!.planBlock).toBeUndefined();

    const twoText = C4_TEXT.replace('  }\n}', "  }\n  other = system 'Other' {\n    web = container 'Web2'\n  }\n}");
    const p2 = planFrom(twoText);
    const m = buildViewModel(snapshotFor(p2), 's', p2, new Map([[C4_FILE, twoText]]));
    expect(find(m.root, 'web')!.planBlock).toBeUndefined();   // 'web' matches app.web and other.web
  });

  it('caps at 200 lines; endLine is the last included line', () => {
    const body = Array.from({ length: 300 }, (_, i) => `    // filler ${i}`);
    const lines = C4_TEXT.split('\n');
    const bigText = [...lines.slice(0, 3), ...body, ...lines.slice(3)].join('\n');
    const p = planFrom(bigText);
    const m = buildViewModel(snapshotFor(p), 's', p, new Map([[C4_FILE, bigText]]));
    const web = find(m.root, 'web')!.planBlock!;
    expect(web.lines).toHaveLength(PLAN_BLOCK_MAX_LINES);
    expect(web.startLine).toBe(3);
    expect(web.endLine).toBe(3 + PLAN_BLOCK_MAX_LINES - 1);
  });

  it('folder mode (no plan): output identical with or without planTexts', () => {
    const a = JSON.stringify(buildViewModel(snap, 's'));
    const b = JSON.stringify(buildViewModel(snap, 's', undefined, texts));
    expect(b).toBe(a);
    expect(a).not.toContain('planBlock');
  });
});
