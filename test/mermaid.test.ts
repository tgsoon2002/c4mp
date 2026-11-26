import { renderMermaid } from '../src/query/mermaid';
import type { Graph } from '../src/types';

// P18-T7: neutral graph -> Mermaid flowchart (D17).
describe('renderMermaid', () => {
  it('golden: one parent, two children, one labeled edge, status colours', () => {
    const g: Graph = {
      nodes: [
        { id: 'app.api', label: 'Api', kind: 'container', status: 'in-progress' },
        { id: 'app.api.b', label: 'Billing', kind: 'component', status: 'done', owner: 'K', parent: 'app.api' },
        { id: 'app.api.a', label: 'Auth', kind: 'component', parent: 'app.api' },
      ],
      edges: [{ from: 'app.api.b', to: 'app.api.a', label: 'calls' }],
    };
    expect(renderMermaid(g)).toBe([
      'flowchart TD',
      '  subgraph n_app_api["Api (container)"]',
      '    n_app_api_a["Auth<br/>component"]',
      '    n_app_api_b["Billing<br/>component · done · K"]:::done',
      '  end',
      '  n_app_api_b -->|"calls"| n_app_api_a',
      '  classDef inprogress fill:#fef9c3,stroke:#ca8a04,color:#422006',
      '  classDef done fill:#dcfce7,stroke:#16a34a,color:#052e16',
      '  class n_app_api inprogress',
      '',
    ].join('\n'));
  });

  it('nested subgraphs, LR direction, comments, fence', () => {
    const g: Graph = {
      nodes: [
        { id: 'a', label: 'A', kind: 'system' },
        { id: 'b', label: 'B', kind: 'container', parent: 'a' },
        { id: 'c', label: 'C', kind: 'component', parent: 'b' },
      ],
      edges: [],
    };
    expect(renderMermaid(g, { direction: 'LR', fence: true, comments: ['2 relation(s) leave this view'] })).toBe([
      '```mermaid',
      'flowchart LR',
      '  %% 2 relation(s) leave this view',
      '  subgraph n_a["A (system)"]',
      '    subgraph n_b["B (container)"]',
      '      n_c["C<br/>component"]',
      '    end',
      '  end',
      '```',
      '',
    ].join('\n'));
  });

  it('escapes quotes, angle brackets and ampersands in labels; no raw quote inside a label', () => {
    const g: Graph = {
      nodes: [
        { id: 'x', label: 'Say "hi" <b>& bye</b>\nline2', kind: 'component', owner: 'O"wner' },
        { id: 'y', label: 'Y', kind: 'component' },
      ],
      edges: [{ from: 'x', to: 'y', label: 'a "q" <x> & y' }],
    };
    const out = renderMermaid(g);
    expect(out).toContain('n_x["Say #quot;hi#quot; #lt;b#gt;#amp; bye#lt;/b#gt; line2<br/>component · O#quot;wner"]');
    expect(out).toContain('n_x -->|"a #quot;q#quot; #lt;x#gt; #amp; y"| n_y');
    for (const line of out.split('\n')) {
      const m = /\["(.*)"\]/.exec(line) ?? /\|"(.*)"\|/.exec(line);
      if (m) expect(m[1]).not.toContain('"');
    }
  });

  it('ids that collide after sanitising get _2, _3 in id order', () => {
    const g: Graph = {
      nodes: [
        { id: 'a_b', label: 'two', kind: 'component' },
        { id: 'a.b', label: 'one', kind: 'component' },
        { id: 'a-b', label: 'three', kind: 'component' },
      ],
      edges: [{ from: 'a.b', to: 'a-b' }],
    };
    const out = renderMermaid(g);
    // sorted by id: 'a-b' < 'a.b' < 'a_b'
    expect(out).toContain('n_a_b["three<br/>component"]');
    expect(out).toContain('n_a_b_2["one<br/>component"]');
    expect(out).toContain('n_a_b_3["two<br/>component"]');
    expect(out).toContain('n_a_b_2 --> n_a_b');
  });

  it('a node whose id is the word end stays legal (prefix n_)', () => {
    const out = renderMermaid({ nodes: [{ id: 'end', label: 'End', kind: 'component' }], edges: [] });
    expect(out).toBe('flowchart TD\n  n_end["End<br/>component"]\n');
  });

  it('no edges, empty graph, dashed edges, external stubs', () => {
    expect(renderMermaid({ nodes: [], edges: [] })).toBe('flowchart TD\n');
    const g: Graph = {
      nodes: [
        { id: 'a', label: 'A', kind: 'component' },
        { id: 'ext', label: 'Outside', kind: 'external', outside: true },
      ],
      edges: [
        { from: 'a', to: 'ext', dashed: true },
        { from: 'a', to: 'ext', dashed: true, label: 'uses' },
      ],
    };
    const out = renderMermaid(g);
    expect(out).toContain('  n_a -.-> n_ext\n');
    expect(out).toContain('  n_a -.->|"uses"| n_ext\n');
    expect(out).toContain('n_ext["Outside<br/>external"]:::external');
    expect(out).toContain('classDef external');
  });

  it('is deterministic: input order of nodes and edges does not matter', () => {
    const nodes = [
      { id: 'b', label: 'B', kind: 'component' },
      { id: 'a', label: 'A', kind: 'component' },
    ];
    const edges = [{ from: 'b', to: 'a', label: 'z' }, { from: 'a', to: 'b' }, { from: 'a', to: 'b', label: 'a' }];
    expect(renderMermaid({ nodes, edges })).toBe(renderMermaid({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }));
  });

  it('throws on an edge to a missing node and on duplicate node ids; a parent cycle still draws every node', () => {
    expect(() => renderMermaid({ nodes: [{ id: 'a', label: 'A', kind: 'x' }], edges: [{ from: 'a', to: 'zz' }] })).toThrow(/not a node/);
    expect(() => renderMermaid({ nodes: [{ id: 'a', label: 'A', kind: 'x' }, { id: 'a', label: 'B', kind: 'x' }], edges: [] })).toThrow(/duplicate/);
    const cyc = renderMermaid({
      nodes: [{ id: 'a', label: 'A', kind: 'x', parent: 'b' }, { id: 'b', label: 'B', kind: 'x', parent: 'a' }],
      edges: [],
    });
    expect(cyc).toContain('n_a');
    expect(cyc).toContain('n_b');
  });
});
