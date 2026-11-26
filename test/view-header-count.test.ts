import { withRenderedContainerCount } from '../src/page/html';
import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { Plan, BuildInput, Container, FileOutline, SnapshotMeta, ViewModel, ViewNode } from '../src/types';

// P14-T5c: the header sentence counts RENDERED container nodes (same rule as the panel chip).
function node(id: string, kind: string, children: ViewNode[] = []): ViewNode {
  return { id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0 } as unknown as ViewNode;
}

function modelWith(summary: string, containerCount: number): ViewModel {
  const cs = Array.from({ length: containerCount }, (_, i) => node(`c${i}`, 'container', [node(`k${i}`, 'component')]));
  return { summary, root: node('sys', 'system', [...cs, node('sh', 'shared')]) } as unknown as ViewModel;
}

describe('withRenderedContainerCount (P14-T5c)', () => {
  it('(a) replaces the scanned count with the rendered count, other numbers unchanged', () => {
    const m = withRenderedContainerCount(modelWith('x — 2 containers, 8 components, 37 files', 3));
    expect(m.summary).toBe('x — 3 containers, 8 components, 37 files');
  });

  it('(b) singular for exactly 1 container', () => {
    expect(withRenderedContainerCount(modelWith('x — 2 containers, 8 components', 1)).summary).toBe('x — 1 container, 8 components');
  });

  it('(c) summary without the phrase is unchanged', () => {
    const m = modelWith('nothing to see', 3);
    expect(withRenderedContainerCount(m).summary).toBe('nothing to see');
  });

  it('(d) nested container nodes are counted too', () => {
    const m = { summary: 'x — 1 containers, 1 files', root: node('sys', 'system', [node('a', 'container', [node('b', 'container')])]) } as unknown as ViewModel;
    expect(withRenderedContainerCount(m).summary).toBe('x — 2 containers, 1 files');
  });

  it('(e) real model with a plan-only container: header counts it', () => {
    const file = '../plans/arch.c4';
    const text = [
      'model {',
      "  sys = system 'Sys' {",
      "    ghost = container 'Ghost' {",
      "      technology 'Go'",
      "      gc = component 'Gc' {",
      '        link ../ghost/g.go#run',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const r = parseC4(text, file);
    const plan: Plan = { files: [file], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
    const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/x', repoName: 'X', createdAt: '2026-01-01T00:00:00.000Z', git: null };
    const web: Container = { id: 'web', name: 'Web', path: 'web', tech: 'Node.js', manifest: 'package.json' };
    const outlines: FileOutline[] = [{ file: 'web/a.ts', lineCount: 3, parseError: false, elements: [{ name: 'f', kind: 'function', startLine: 1, endLine: 3, lineCount: 3 }] }];
    const input: BuildInput = { meta, containers: [web], components: [{ id: 'web/_root', name: 'Root files', containerId: 'web', path: 'web', files: ['web/a.ts'] }], outlines, imports: [], componentEdges: [], fileEdges: [] };
    const model = buildViewModel(buildSnapshot(input, plan), 'X — 1 containers, 0 components', plan);
    const rendered = (function count(n: ViewNode): number { return (n.kind === 'container' ? 1 : 0) + n.children.reduce((s, c) => s + count(c), 0); })(model.root);
    // Phase 34 F1: the scanned 'web' holds no claimed code, so only the plan container is drawn and counted.
    expect(rendered).toBe(1);
    expect(withRenderedContainerCount(model).summary).toBe('X — 1 container, 0 components');
  });
});
