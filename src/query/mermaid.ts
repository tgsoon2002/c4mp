import type { Graph, GraphNode } from '../types';
import { cmp } from '../util/text';

export interface MermaidOptions {
  direction?: 'TD' | 'LR';
  /** Wrap the output in a ```mermaid fence. */
  fence?: boolean;
  /** Printed as `%%` comment lines under the first line. */
  comments?: string[];
  /** Draw the nodes in the order the graph gives them (default: sorted by id). Ids of colliding names are still made in id order. */
  keepOrder?: boolean;
}

const STATUS_CLASS: Record<string, string> = {
  planned: 'planned',
  'in-progress': 'inprogress',
  done: 'done',
  abandoned: 'abandoned',
};
const CLASS_DEFS: Record<string, string> = {
  planned: 'fill:#eef2ff,stroke:#6366f1,color:#1e1b4b',
  inprogress: 'fill:#fef9c3,stroke:#ca8a04,color:#422006',
  done: 'fill:#dcfce7,stroke:#16a34a,color:#052e16',
  abandoned: 'fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray:4 3',
  external: 'fill:#ffffff,stroke:#9ca3af,color:#6b7280,stroke-dasharray:4 3',
};
const CLASS_ORDER = ['planned', 'inprogress', 'done', 'abandoned', 'external'];

/** Text for inside `"..."`: `&` first so the entities we add are not escaped twice; line breaks removed. */
function esc(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}


/**
 * Render a Graph as a Mermaid flowchart (D17). Nodes with children become nested `subgraph`s, leaves are
 * nodes. Node ids are `n_` + id with every char outside [A-Za-z0-9_] replaced by `_` (the prefix avoids the
 * Mermaid word `end`); a collision gets `_2`, `_3`, in id order. Output is deterministic: nodes sorted by id,
 * edges by from/to/label. Throws on an edge whose endpoint is not a node, or a duplicate node id.
 */
export function renderMermaid(graph: Graph, opts: MermaidOptions = {}): string {
  const direction = opts.direction ?? 'TD';

  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    byId.set(n.id, n);
  }
  for (const e of graph.edges) {
    for (const end of [e.from, e.to]) if (!byId.has(end)) throw new Error(`edge endpoint is not a node: ${end}`);
  }

  const sorted = [...graph.nodes].sort((a, b) => cmp(a.id, b.id));
  const mid = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of sorted) {
    const base = 'n_' + n.id.replace(/[^A-Za-z0-9_]/g, '_');
    let m = base;
    for (let k = 2; taken.has(m); k++) m = `${base}_${k}`;
    taken.add(m);
    mid.set(n.id, m);
  }

  const drawn = opts.keepOrder ? graph.nodes : sorted;
  const children = new Map<string, GraphNode[]>();
  const roots: GraphNode[] = [];
  for (const n of drawn) {
    if (n.parent !== undefined && n.parent !== n.id && byId.has(n.parent)) {
      const l = children.get(n.parent) ?? [];
      l.push(n);
      children.set(n.parent, l);
    } else roots.push(n);
  }

  const used = new Set<string>();
  const classLines: string[] = [];
  const clsOf = (n: GraphNode): string | null => {
    const c = n.outside ? 'external' : n.status !== undefined ? STATUS_CLASS[n.status] ?? null : null;
    if (c) used.add(c);
    return c;
  };

  const lines: string[] = [`flowchart ${direction}`];
  for (const c of opts.comments ?? []) lines.push(`  %% ${c.replace(/[\r\n]+/g, ' ')}`);

  const emitted = new Set<string>();
  const emit = (n: GraphNode, depth: number): void => {
    if (emitted.has(n.id)) return;
    emitted.add(n.id);
    const pad = '  '.repeat(depth + 1);
    const id = mid.get(n.id)!;
    const cls = clsOf(n);
    const kids = children.get(n.id) ?? [];
    if (kids.length > 0) {
      lines.push(`${pad}subgraph ${id}["${esc(`${n.label} (${n.kind})`)}"]`);
      for (const k of kids) emit(k, depth + 1);
      lines.push(`${pad}end`);
      if (cls) classLines.push(`  class ${id} ${cls}`);   // `:::` cannot follow a subgraph
      return;
    }
    const sub = [n.kind, n.status, n.owner].filter((x): x is string => !!x).join(' · ');
    const text = esc(n.label) + (sub ? `<br/>${esc(sub)}` : '');
    lines.push(`${pad}${id}["${text}"]${cls ? `:::${cls}` : ''}`);
  };
  for (const r of roots) emit(r, 0);
  // Parent cycles leave nodes unreachable from a root: still draw them (top level).
  for (const n of drawn) emit(n, 0);

  const edges = [...graph.edges].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.label ?? '', b.label ?? ''));
  for (const e of edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    const label = e.label !== undefined && e.label !== '' ? `|"${esc(e.label)}"|` : '';
    lines.push(`  ${mid.get(e.from)} ${arrow}${label} ${mid.get(e.to)}`);
  }

  for (const c of CLASS_ORDER) if (used.has(c)) lines.push(`  classDef ${c} ${CLASS_DEFS[c]}`);
  lines.push(...classLines);

  const body = lines.join('\n') + '\n';
  return opts.fence ? '```mermaid\n' + body + '```\n' : body;
}
