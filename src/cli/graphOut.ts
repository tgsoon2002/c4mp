/**
 * P8: what `c4mp plan tree` and `c4mp board tree` share: the --format / --direction / --max-nodes / --fence options,
 * their checks, and the choice between Mermaid, text and JSON. Each command keeps its own graph, its own text
 * layout and its own JSON fields; this file only holds what was copied between them.
 */
import type { Command } from 'commander';
import { renderMermaid } from '../query/mermaid';
import type { Graph, GraphNode } from '../types';
import { wholeNumberProblem } from '../cliHelp';
import { cmdError } from './common';
import type { CmdError, Opts } from './common';

export const GRAPH_FORMATS = ['mermaid', 'text', 'json'];
export const DEFAULT_MAX_NODES = 120;

/** Each adder registers one option; a command adds them where its help should list them. */
export const addFormatOption = (cmd: Command): Command => cmd.option('--format <fmt>', 'mermaid, text or json', 'mermaid');
export const addDirectionOption = (cmd: Command): Command => cmd.option('--direction <dir>', 'Mermaid direction: TD or LR', 'TD');
export const addMaxNodesOption = (cmd: Command): Command => cmd.option('--max-nodes <n>', `refuse a bigger graph (default ${DEFAULT_MAX_NODES})`);
export const addFenceOption = (cmd: Command): Command => cmd.option('--fence', 'wrap the Mermaid text in a ```mermaid block');

/** Whole number >= 1 from a commander string, or an error message. */
export function positiveInt(label: string, raw: unknown): number | CmdError {
  const problem = wholeNumberProblem(label, raw, 1);
  return problem === null ? Number(raw) : cmdError('invalid', problem);
}

/** `--format` and `--direction` checked, or the error. */
export function parseGraphOpts(opts: Opts): { format: string; direction: 'TD' | 'LR' } | CmdError {
  const format = String(opts.format ?? 'mermaid');
  if (!GRAPH_FORMATS.includes(format)) return cmdError('invalid', `--format must be one of ${GRAPH_FORMATS.join(', ')}, got '${format}'`);
  const direction = String(opts.direction ?? 'TD').toUpperCase();
  if (direction !== 'TD' && direction !== 'LR') return cmdError('invalid', `--direction must be TD or LR, got '${direction}'`);
  return { format, direction: direction as 'TD' | 'LR' };
}

/** `--max-nodes` checked (default when absent), or the error. */
export function parseMaxNodes(opts: Opts): number | CmdError {
  return opts.maxNodes === undefined ? DEFAULT_MAX_NODES : positiveInt('--max-nodes', opts.maxNodes);
}

/**
 * Edges between a box and its own descendant (a relation from a subgraph to something inside it) can break some
 * Mermaid renderers. Choice: the Mermaid output drops them and says how many in a `%%` comment; text and JSON keep them.
 */
export function splitAncestorEdges(graph: Graph): { kept: Graph['edges']; dropped: number } {
  const parentOf = new Map<string, string | undefined>(graph.nodes.map((n: GraphNode) => [n.id, n.parent]));
  const isAncestor = (a: string, of: string): boolean => {
    const seen = new Set<string>();
    for (let p = parentOf.get(of); p !== undefined && !seen.has(p); p = parentOf.get(p)) {
      if (p === a) return true;
      seen.add(p);
    }
    return false;
  };
  const kept = graph.edges.filter(e => !isAncestor(e.from, e.to) && !isAncestor(e.to, e.from));
  return { kept, dropped: graph.edges.length - kept.length };
}

/** What a command gives to `formatGraph`: one producer per format (only the chosen one runs). */
export interface GraphFormats {
  json: () => string;
  text: () => string;
  /** The Mermaid note lines; `dropped` = relations left out because they join a box to its own descendant. */
  comments: (dropped: number) => string[];
  /** Draw nodes in the graph's own order (plan tree: layers in declaration order). */
  keepOrder?: boolean;
}

/** The graph as the chosen format, without a trailing newline in the Mermaid case. */
export function formatGraph(format: string, direction: 'TD' | 'LR', graph: Graph, opts: Opts, out: GraphFormats): string {
  if (format === 'json') return out.json();
  if (format === 'text') return out.text();
  const { kept, dropped } = splitAncestorEdges(graph);
  return renderMermaid({ nodes: graph.nodes, edges: kept }, { direction, fence: opts.fence === true, comments: out.comments(dropped), keepOrder: out.keepOrder === true }).replace(/\n$/, '');
}
