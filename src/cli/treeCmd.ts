/**
 * P18-T11: `c4mp plan tree <level> <target>`: the plan below one element as Mermaid, text or JSON. Read-only: writes
 * nothing, not even `.c4mp/`. Level c1 = system, c2 = container, c3 = component (must match the target's kind).
 */
import type { Command } from 'commander';
import { addExamples, addRepo } from '../cliHelp';
import { buildTree, isViewTreeTarget, levelOf } from '../query/treeModel';
import type { TreeLevel } from '../query/treeModel';
import { itemsLinkedTo, readBoard } from '../query/board';
import type { Graph, GraphNode, Plan } from '../types';
import {
  addDirectionOption, addFenceOption, addFormatOption, addMaxNodesOption, formatGraph, parseGraphOpts, parseMaxNodes, positiveInt,
} from './graphOut';
import {
  NO_PLAN_MESSAGE, addViewOption, cmdError, emitError, parseView, runAction, withQuietLogs,
} from './common';
import type { CmdError, Opts, PlanEditDeps } from './common';
import { loadPlanState, resolveTarget } from '../services/planState';
import { registerPlanCommand } from './planGroup';

export { splitAncestorEdges } from './graphOut';

const LEVEL_NAME: Record<TreeLevel, string> = { c1: 'system', c2: 'container', c3: 'component' };

const BOARD_NODE_PREFIX = 'board/';

/**
 * P18-PB6: one node per board item that links to a shown plan element (`b12 task in-progress`), with a dashed edge
 * to that element. Items of archived boards are left out. Returns a one-line note instead of a graph when there is
 * nothing to add because there is no board file (the board is read-only here: nothing is created).
 */
function addBoardItems(graph: Graph, plan: Plan, repoRoot: string): Graph | string {
  const loaded = readBoard(repoRoot);
  if (loaded.state === 'problems') return `${loaded.file} has problems; board items not shown (c4mp board list shows them)`;
  if (loaded.state === 'none') return 'no board file; --boards adds nothing';

  const uidOf = new Map<string, string>();   // fqn -> uid of the shown elements
  const byFqn = new Map(plan.elements.map(e => [e.id, e] as const));
  for (const n of graph.nodes) {
    const uid = n.outside ? undefined : byFqn.get(n.id)?.metadata.uid;
    if (uid) uidOf.set(n.id, uid);
  }
  const boardNodes: GraphNode[] = [];   // sorted by id below: the tree nodes keep their order, board items were always listed by id
  const edges = [...graph.edges];
  const added = new Set<string>();
  for (const [fqn, uid] of uidOf) {
    for (const { board, item } of itemsLinkedTo(loaded.data, uid)) {
      if (board.archived) continue;
      const id = BOARD_NODE_PREFIX + item.id;
      if (!added.has(id)) {
        added.add(id);
        boardNodes.push({ id, label: [item.id, item.kind, item.status].filter(Boolean).join(' '), kind: 'board-item' });
      }
      edges.push({ from: id, to: fqn, dashed: true });
    }
  }
  return { nodes: [...graph.nodes, ...boardNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))], edges };
}

/** AI-readable form: indented `fqn  [kind]  status owner` lines, then the relations. */
function formatTreeText(graph: Graph): string {
  const kids = new Map<string | undefined, GraphNode[]>();
  for (const n of graph.nodes) {
    const key = n.outside ? '(external)' : n.kind === 'board-item' ? '(boards)' : n.parent;
    kids.set(key, [...(kids.get(key) ?? []), n]);
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number): void => {
    for (const n of kids.get(parent) ?? []) {
      const tail = [n.status, n.owner].filter(Boolean).join(' ');
      lines.push(`${'  '.repeat(depth)}${n.id}  [${n.kind}]${tail ? `  ${tail}` : ''}`);
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const external = kids.get('(external)') ?? [];
  if (external.length > 0) {
    lines.push('external:');
    for (const n of external) lines.push(`  ${n.id}  [${n.kind}]`);
  }
  const boardItems = kids.get('(boards)') ?? [];
  if (boardItems.length > 0) {
    lines.push('board items:');
    for (const n of boardItems) lines.push(`  ${n.label}`);
  }
  const isBoardEdge = (e: Graph['edges'][number]): boolean => e.from.startsWith(BOARD_NODE_PREFIX);
  const relations = graph.edges.filter(e => !isBoardEdge(e));
  if (relations.length > 0) {
    lines.push('relations:');
    for (const e of relations) lines.push(`  ${e.from} -> ${e.to}${e.label ? `  ${e.label}` : ''}${e.dashed ? '  (leaves this view)' : ''}`);
  }
  const links = graph.edges.filter(isBoardEdge);
  if (links.length > 0) {
    lines.push('board links:');
    for (const e of links) lines.push(`  ${e.from.slice(BOARD_NODE_PREFIX.length)} -> ${e.to}`);
  }
  return lines.join('\n');
}

/** The text to print, or the error. Prints nothing itself (it runs with console.log sent to stderr). */
function runTree(first: string, second: string | undefined, opts: Opts, deps: PlanEditDeps): string | CmdError {
  const bad = (e: CmdError): CmdError => e;

  // b273: arch = `<level> <target>` as ever; with --view io|storage the one positional is the target (any element of
  // that view, or a container to start from) and there is no level.
  const view = parseView(opts);
  if (typeof view !== 'string') return bad(view);
  let level = first;
  let target: string;
  if (view === 'arch') {
    if (second === undefined) return bad(cmdError('invalid', 'tree needs a level and a target: c4mp plan tree <c1|c2|c3> <target>'));
    target = second;
  } else {
    if (second !== undefined) return bad(cmdError('invalid', `with --view ${view} give only the target: c4mp plan tree <target> --view ${view}`));
    target = first;
    level = '';
  }

  if (view === 'arch' && !(level in LEVEL_NAME)) return bad(cmdError('invalid', `level must be c1, c2 or c3, got '${level}'`));
  const parsed = parseGraphOpts(opts);
  if ('code' in parsed) return bad(parsed);
  const { format, direction } = parsed;
  if (opts.recursive && opts.depth !== undefined) return bad(cmdError('invalid', '-r and --depth cannot be used together'));
  let levels: number | 'all' = opts.recursive ? 'all' : 1;
  if (opts.depth !== undefined) {
    const d = positiveInt('--depth', opts.depth);
    if (typeof d !== 'number') return bad(d);
    levels = d;
  }
  const maxNodes = parseMaxNodes(opts);
  if (typeof maxNodes !== 'number') return bad(maxNodes);

  const state = loadPlanState(opts.repo as string, deps.buildCliConfig(opts));
  if (!state) return bad(cmdError('no-plan', NO_PLAN_MESSAGE));
  const resolved = resolveTarget(state, target);
  if (!resolved.ok) return bad(resolved.error);
  if (view === 'arch') {
    const actual = levelOf(resolved.el.kind);
    if (actual === null) {
      return bad(cmdError('invalid', `'${target}' is a ${resolved.el.kind}, which has no tree level; tree starts at a system, container or component`));
    }
    if (actual !== level) {
      return bad(cmdError('invalid', `'${target}' is a ${resolved.el.kind}, use level ${actual}: c4mp plan tree ${actual} ${target}`));
    }
  } else if (!isViewTreeTarget(resolved.el.kind, view)) {
    return bad(cmdError('invalid', `'${target}' is a ${resolved.el.kind}; with --view ${view} the target is a container or an element of the ${view} view`));
  }

  const built = buildTree(state.plan, resolved.el, { levels, external: opts.external === true, maxNodes, ...(view === 'arch' ? {} : { view }) });
  if ('error' in built) {
    return bad(cmdError('invalid', `${built.count} nodes is more than --max-nodes ${maxNodes}; lower --depth, drop -r or raise --max-nodes`));
  }
  let graph = built.graph;
  if (opts.boards) {
    const withBoards = addBoardItems(graph, state.plan, state.repoRoot);
    if (typeof withBoards === 'string') console.error(`note: ${withBoards}`);
    else graph = withBoards;
    if (graph.nodes.length > maxNodes) {
      return bad(cmdError('invalid', `${graph.nodes.length} nodes with the board items is more than --max-nodes ${maxNodes}; lower --depth, drop -r or raise --max-nodes`));
    }
  }

  return formatGraph(format, direction, graph, opts, {
    json: () => JSON.stringify({ ...graph, outside: built.outside, truncated: built.truncated }, null, 2),
    text: () => formatTreeText(graph),
    keepOrder: true,
    comments: (dropped) => {
      const comments: string[] = [];
      if (!opts.external && built.outside > 0) comments.push(`${built.outside} relation(s) leave this view`);
      if (built.truncated) comments.push('deeper levels are hidden (use -r or --depth)');
      if (dropped > 0) comments.push(`${dropped} relation(s) between a box and its own descendant are not drawn`);
      return comments;
    },
  });
}

export function registerTreeCommand(program: Command, deps: PlanEditDeps): void {
  registerPlanCommand(program, { name: 'tree', args: '<level> [target]' }, cmd => buildTreeCmd(cmd, deps));
}

function buildTreeCmd(cmd: Command, deps: PlanEditDeps): Command {
  const treeCmd = addViewOption(addRepo(
    cmd
      .description(
        'Draw the plan below one element. ' +
          'Level is c1 (system), c2 (container) or c3 (component) and must match the target; one level down by default, ' +
          '-r for all. With --view io or storage there is no level: give only the target, a container or any element of that view ' +
          '(c4mp plan tree <target> --view storage). Prints Mermaid (paste it in any viewer), text or JSON. Read-only: writes nothing',
      ),
  ))
    .option('-r, --recursive', 'show every level below the target')
    .option('--depth <n>', 'show n levels below the target (not with -r)');
  addFormatOption(treeCmd);
  addDirectionOption(treeCmd);
  treeCmd.option('--external', 'draw relations that leave the view as dashed edges');
  addMaxNodesOption(treeCmd);
  addFenceOption(treeCmd);
  treeCmd
    .option('--boards', 'also draw the board items that link to a shown element (dashed)')
    .action((level: string, target: string | undefined, opts: Opts) => {
      runAction(opts, 'tree', () => {
        const result = withQuietLogs(() => runTree(level, target, opts, deps));
        if (typeof result !== 'string') return emitError(opts, 'tree', result);
        console.log(result);
        return 0;
      });
    });
  addExamples(treeCmd, [
    'c4mp plan tree c1 app --repo .                   containers of a system',
    'c4mp plan tree c2 api --repo . -r                everything below a container',
    'c4mp plan tree c3 auth --repo . --format text    planned code, AI-readable',
    'c4mp plan tree c2 api --repo . > tree.mmd        Mermaid text, no fence',
    'c4mp plan tree api --view storage --repo . -r    the stores, records and fields of a container',
  ]);
  return treeCmd;
}
