import * as path from 'path';
import type { CodeElement, FileCalls, Ownership, PathLiteral, Plan, PlanElement, RunCommand, Snapshot, SnapshotFile, SourcePos, TestsConfig } from '../types';
import { callIndex, MODULE_CALLER, type CallSite } from '../callGraph/callResolve';
import { ignoreReachMatcher } from '../importer/testMatch';
import { localId, SYSTEM_ID_QUALIFIER } from '../names';
import { ownerIdOf } from './ownership';
import { matchPlannedTest, plannedTestsUnder } from './planTests';
import { log, timed } from '../log';

// Phase 26 (T26-7, Document/Roadmap/Phase26/ATTACH-DESIGN.md section A): where each test case hangs. A case is attached
// to the lowest common c-item of the code it reaches (D2 subject first, D3 never lift, D4 layers skipped, D5 mocks,
// A3 shared/unassigned code). Derived on every scan, never stored (D13): pure, memoised per snapshot object.
// T26-8: hidden reach. A string literal that is exactly a scanned path (D17) is file reach when it goes into a
// file/path/process call or a test helper that passes it to one (D22, T26-8b; data strings never); a plan `test` block with
// `case` (D16) is a hand link: to a case id it overrides the derived place (A4), to a test file (a helper) it adds the
// block's parent to the reach of every case using that file.

export type AttachLevel = 'element' | 'component' | 'container' | 'system';
/** How the place was found: call sites, import uses and path literals (TS/JS), file imports (other languages, pseudo
 *  cases), or a hand link of the plan naming the case (A4). */
export type AttachVia = 'calls' | 'imports' | 'hand';
/** The rung of the D2/D3 ladder that decided: body without ignoreReach files, body, body + setup without them, all;
 *  'hand' when a hand link naming the case decided. */
export type ReachStep = 'body' | 'body+ignored' | 'setup' | 'setup+ignored' | 'none' | 'hand';

/** A test case (D1): an element of kind 'test' of a role-test file; `id` = `file#name` (D13). A role-test file without
 *  cases that no other test file imports is one pseudo case with `id` = the file and `name` = ''. */
export interface TestCase { id: string; file: string; name: string; line: number; endLine: number }

export interface TestAttachment {
  testId: string;
  level: AttachLevel | 'none';
  target: string | null;   // tree id: 'file#name', component id, container id or the system id; null for 'none'
  touches: string[];       // tree ids reached (elements, and the components owning reached code), target excluded, sorted;
                           // with a hand link (via 'hand') also the derived place
  via: AttachVia;
  step: ReachStep;
  mocked: string[];        // repo files the test file mocks (D5), sorted
  helpers: string[];       // other role-test files the case went through (helpers, D7), sorted
}

/** The c-item tree the cases attach to: element -> owner component -> container -> system, layers skipped (D4). */
export interface CItemTree {
  parentOf(id: string): string | null;
  childrenOf(id: string): string[];
  kindOf(id: string): AttachLevel | undefined;   // undefined: not a node of the tree
  systemId: string;
}

export interface TestIndex {
  cases: Map<string, TestCase>;                  // in file, then line order
  attachments: Map<string, TestAttachment>;      // by test id
  byTarget: Map<string, string[]>;               // tree id -> test ids attached there
  byTouch: Map<string, string[]>;                // tree id -> test ids that touch it
  tree: CItemTree;
}

export interface AttachInput {
  snapshot: Snapshot;              // built with collectCalls 'tests' (or true): calls of the role-test files
  plan: Plan | null;               // its `test` blocks with `case` are the hand links (D16)
  ownership: Ownership | null;     // claim mode: resolveOwnership of the plan; folder mode: null
  tests: TestsConfig | undefined;  // config `tests` (ignoreReach)
}

/** Owner of code that sits in no container: the synthetic Shared node, or unassigned (C26). */
const OUTSIDE = new Set(['shared-auto', 'unassigned']);
const CALL_OWNER_KINDS = new Set(['function', 'method', 'test']);   // the owners of calls (languages/typescript/calls.ts sweep)

/** What a case reaches: elements of source files (`file#name` -> file), whole source files, and tree nodes a helper
 *  hand link adds (T26-8). */
interface Reach { els: Map<string, string>; files: Set<string>; helpers: Set<string>; nodes: Set<string> }
const emptyReach = (): Reach => ({ els: new Map(), files: new Set(), helpers: new Set(), nodes: new Set() });
function addAll(into: Reach, from: Reach): void {
  for (const [id, file] of from.els) into.els.set(id, file);
  for (const f of from.files) into.files.add(f);
  for (const h of from.helpers) into.helpers.add(h);
  for (const n of from.nodes) into.nodes.add(n);
}
function filtered(r: Reach, drop: (file: string) => boolean): Reach {
  return {
    els: new Map([...r.els].filter(([, file]) => !drop(file))),
    files: new Set([...r.files].filter((f) => !drop(f))),
    helpers: r.helpers,
    nodes: r.nodes,
  };
}
const isEmpty = (r: Reach): boolean => r.els.size === 0 && r.files.size === 0 && r.nodes.size === 0;

const byFileLine = (a: TestCase, b: TestCase): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

// ---------------------------------------------------------------- tree

interface TreeParts { tree: CItemTree; ownersOfFile: (file: string) => string[] }

function buildTree(snapshot: Snapshot, ownership: Ownership | null): TreeParts {
  const kind = new Map<string, AttachLevel>();
  const parent = new Map<string, string | null>();
  const nodeIds = new Set([...snapshot.containers.map((c) => c.id), ...snapshot.components.map((c) => c.id)]);
  // Same rule as the view model's root (view/model.ts), so tree ids are the map's node ids.
  const systemId = nodeIds.has(snapshot.system.id) ? snapshot.system.id + SYSTEM_ID_QUALIFIER : snapshot.system.id;
  kind.set(systemId, 'system');
  parent.set(systemId, null);
  for (const c of snapshot.containers) { kind.set(c.id, 'container'); parent.set(c.id, systemId); }
  for (const c of snapshot.components) {
    if (!kind.has(c.containerId)) { kind.set(c.containerId, 'container'); parent.set(c.containerId, systemId); }   // plan-only container
    kind.set(c.id, 'component');
    parent.set(c.id, c.containerId);   // claim mode: containerFqnOf (plan/standIn.ts), layers skipped, resolved to the scan
  }
  const sourceFiles = new Map(snapshot.files.filter((f) => f.role !== 'test').map((f) => [f.file, f]));
  const ownerOfElement = (f: SnapshotFile, name: string): string => {
    const o = ownerIdOf(ownership, f, name);
    if (o === undefined) throw new Error(`testAttach: no owner for ${f.file}#${name}`);
    return o;
  };
  for (const f of sourceFiles.values()) {
    for (const e of f.elements) {
      const id = `${f.file}#${e.name}`;
      if (kind.has(id)) continue;
      const o = ownerOfElement(f, e.name);
      kind.set(id, 'element');
      parent.set(id, kind.get(o) === 'component' ? o : systemId);   // shared / unassigned code hangs under the system
    }
  }
  const children = new Map<string, string[]>();
  for (const [id, p] of parent) if (p !== null) children.set(p, [...(children.get(p) ?? []), id]);

  const fileOwners = new Map<string, string[]>();
  const ownersOfFile = (file: string): string[] => {
    let out = fileOwners.get(file);
    if (!out) {
      const f = sourceFiles.get(file)!;
      const code = f.elements.filter((e) => e.kind !== 'type');
      out = code.length > 0 ? [...new Set(code.map((e) => ownerOfElement(f, e.name)))].sort() : [ownerIdOf(ownership, f)!];
      fileOwners.set(file, out);
    }
    return out;
  };
  return {
    tree: {
      parentOf: (id) => parent.get(id) ?? null,
      childrenOf: (id) => children.get(id) ?? [],
      kindOf: (id) => kind.get(id),
      systemId,
    },
    ownersOfFile,
  };
}

function ancestors(tree: CItemTree, id: string): string[] {
  const out: string[] = [];
  for (let n: string | null = id; n !== null; n = tree.parentOf(n)) out.push(n);
  return out;
}

function lowestCommon(tree: CItemTree, ids: string[]): string {
  let common = ancestors(tree, ids[0]);
  for (const id of ids.slice(1)) {
    const up = new Set(ancestors(tree, id));
    common = common.filter((n) => up.has(n));
  }
  return common[0] ?? tree.systemId;
}

/** A.5: one element -> that element (A3, any owner); else the LCA of the owners, OUTSIDE code lifts a component to its
 *  container (C26). Hand-link nodes (T26-8) join as they are: an element like a reached element, a component, container
 *  or the system as an owner. */
function place(r: Reach, parts: TreeParts): Pick<TestAttachment, 'level' | 'target' | 'touches'> {
  if (isEmpty(r)) return { level: 'none', target: null, touches: [] };
  const { tree } = parts;
  const els = [...new Set([...r.els.keys(), ...[...r.nodes].filter((n) => tree.kindOf(n) === 'element')])];
  const nodes = [...r.nodes].filter((n) => tree.kindOf(n) !== 'element');
  const owners = new Set<string>(nodes);
  for (const id of els) owners.add(tree.parentOf(id) === tree.systemId ? 'unassigned' : tree.parentOf(id)!);
  for (const f of r.files) for (const o of parts.ownersOfFile(f)) owners.add(o);
  const inner = [...owners].filter((o) => !OUTSIDE.has(o) && (tree.kindOf(o) === 'component' || nodes.includes(o))).sort();
  const outside = inner.length < owners.size;

  let target: string;
  if (els.length === 1 && r.files.size === 0 && nodes.length === 0) target = els[0];
  else if (inner.length === 0) target = tree.systemId;
  else {
    target = lowestCommon(tree, inner);
    if (outside && tree.kindOf(target) === 'component') target = tree.parentOf(target)!;
  }
  const touches = [...new Set([...els, ...inner])].filter((id) => id !== target).sort();
  return { level: tree.kindOf(target)!, target, touches };
}

// ---------------------------------------------------------------- reach

interface FileData {
  fc: FileCalls;
  bindings: Map<string, FileCalls['bindings'][number]>;
  sitesByCaller: Map<string, CallSite[]>;
  usesByOwner: Map<string, string[]>;        // owner element name or '<module>' -> use names
  filesByOwner: Map<string, string[]>;       // owner element name or '<module>' -> source files named by path literals (T26-8)
  moduleLines: { line: number; site?: CallSite; use?: string; file?: string }[];   // '<module>' sites, uses, literal files, for setup scopes
}

/** Innermost function, method or test case of `elements` holding `line` (the calls sweep of languages/typescript/calls.ts), else null. */
function ownerAt(owners: CodeElement[], line: number): CodeElement | null {
  let best: CodeElement | null = null;
  for (const e of owners) {
    if (e.startLine > line || e.endLine < line) continue;
    if (!best || e.startLine > best.startLine || (e.startLine === best.startLine && e.endLine < best.endLine)) best = e;
  }
  return best;
}

/**
 * Attaches every test case of the snapshot (ATTACH-DESIGN A.3). Throws when the snapshot has role-test files but was
 * built without calls (runSnapshot collectCalls 'tests' or true): no silent fallback that would differ per command.
 */
export function attachTests(input: AttachInput): TestIndex {
  return timed('attach tests', () => attach(input), (ix) => `${ix.cases.size} cases`);
}

function attach({ snapshot, plan, ownership, tests }: AttachInput): TestIndex {
  const testFiles = snapshot.files.filter((f) => f.role === 'test');
  if (testFiles.length > 0 && !snapshot.calls) {
    throw new Error("attachTests: the snapshot has no calls; build it with collectCalls 'tests' (or true)");
  }
  const parts = buildTree(snapshot, ownership);
  const filesByPath = new Map(snapshot.files.map((f) => [f.file, f]));
  const isTestFile = (file: string): boolean => filesByPath.get(file)?.role === 'test';
  const isSource = (file: string): boolean => filesByPath.has(file) && !isTestFile(file);
  const ignored = ignoreReachMatcher(tests);
  const sites = callIndex(snapshot).sites;
  const edgesFrom = new Map<string, string[]>();
  for (const e of snapshot.fileEdges) if (e.from !== e.to) edgesFrom.set(e.from, [...(edgesFrom.get(e.from) ?? []), e.to]);
  const elementsByName = new Map<string, Map<string, CodeElement>>();   // per file; the first of a repeated name (callIndex)
  const elementOf = (file: string, name: string): CodeElement | undefined => {
    let m = elementsByName.get(file);
    if (!m) {
      m = new Map();
      for (const e of filesByPath.get(file)?.elements ?? []) if (!m.has(e.name)) m.set(e.name, e);
      elementsByName.set(file, m);
    }
    return m.get(name);
  };

  /** D17: the source file a path literal of `file` names exactly (from the repo root, or from the file's folder), or
   *  null. A file whose code is all types is no reach (D3), like a type-only import. No build-output mapping. */
  const literalTarget = (file: string, value: string): string | null => {
    for (const p of [path.posix.normalize(value), path.posix.normalize(path.posix.join(path.posix.dirname(file), value))]) {
      const f = filesByPath.get(p);
      if (f && f.role !== 'test' && !(f.elements.length > 0 && f.elements.every((e) => e.kind === 'type'))) return p;
    }
    return null;
  };

  /** D22 (T26-8b): parameter `index` of role-test function `file#fn` goes into a file/path/process call: that call. */
  const helperParams = new Map<string, string>();
  for (const fc of snapshot.calls ?? []) if (isTestFile(fc.file)) for (const p of fc.pathParams ?? []) helperParams.set(`${fc.file}#${p.fn}#${p.index}`, p.call);
  const sitesAt = new Map<string, CallSite[]>();   // `file:line:callee` -> call sites
  for (const s of sites) if (s.callee !== null) sitesAt.set(`${s.file}:${s.line}:${s.callee}`, [...(sitesAt.get(`${s.file}:${s.line}:${s.callee}`) ?? []), s]);
  /** D22: why a path literal of `file` is file reach (its file/path/process call, or the test helper it is passed to
   *  whose parameter goes into one), or null for a data string. */
  const literalReason = (file: string, l: PathLiteral): string | null => {
    if (l.call) return l.call;
    for (const a of l.args ?? []) {
      for (const { verdict: v } of sitesAt.get(`${file}:${a.line}:${a.callee}`) ?? []) {
        if (v.kind !== 'edge' || !isTestFile(v.file)) continue;
        const call = helperParams.get(`${v.file}#${v.name}#${a.index}`);
        if (call) return `${v.file}#${v.name} -> ${call}`;
      }
    }
    return null;
  };

  // -- per role-test file with calls: sites by caller, uses and path literals by owner, module-level lines
  const data = new Map<string, FileData>();
  for (const fc of snapshot.calls ?? []) {
    if (!isTestFile(fc.file)) continue;
    const owners = filesByPath.get(fc.file)!.elements.filter((e) => CALL_OWNER_KINDS.has(e.kind));
    const d: FileData = { fc, bindings: new Map(fc.bindings.map((b) => [b.local, b])), sitesByCaller: new Map(), usesByOwner: new Map(), filesByOwner: new Map(), moduleLines: [] };
    data.set(fc.file, d);
    for (const u of fc.uses ?? []) {
      const owner = ownerAt(owners, u.line)?.name ?? MODULE_CALLER;
      d.usesByOwner.set(owner, [...(d.usesByOwner.get(owner) ?? []), u.name]);
      if (owner === MODULE_CALLER) d.moduleLines.push({ line: u.line, use: u.name });
    }
    for (const l of fc.pathLiterals ?? []) {
      const target = literalTarget(fc.file, l.value);
      if (target === null) continue;
      const reason = literalReason(fc.file, l);
      log('test-attach', reason === null ? 'path literal is data' : 'path literal is reach', { file: fc.file, line: l.line, value: l.value, ...(reason !== null && { reason }) });
      if (reason === null) continue;
      const owner = ownerAt(owners, l.line)?.name ?? MODULE_CALLER;
      d.filesByOwner.set(owner, [...(d.filesByOwner.get(owner) ?? []), target]);
      if (owner === MODULE_CALLER) d.moduleLines.push({ line: l.line, file: target });
    }
  }
  for (const s of sites) {
    const d = data.get(s.file);
    if (!d) continue;
    d.sitesByCaller.set(s.caller, [...(d.sitesByCaller.get(s.caller) ?? []), s]);
    if (s.caller === MODULE_CALLER) d.moduleLines.push({ line: s.line, site: s });
  }

  // -- file-import reach (other languages, pseudo cases, helpers without calls): memoised, helpers expanded
  const fileReachMemo = new Map<string, Reach>();
  const typeOnlyFile = (file: string): boolean => filesByPath.get(file)!.elements.every((e) => e.kind === 'type');
  const fileImportReach = (file: string, visiting = new Set<string>()): Reach => {
    const memo = fileReachMemo.get(file);
    if (memo) return memo;
    const r = emptyReach();
    if (visiting.has(file)) return r;
    visiting.add(file);
    for (const to of edgesFrom.get(file) ?? []) {
      if (isTestFile(to)) { r.helpers.add(to); addAll(r, fileImportReach(to, visiting)); }
      else if (isSource(to) && !typeOnlyFile(to)) r.files.add(to);
    }
    visiting.delete(file);
    fileReachMemo.set(file, r);
    return r;
  };

  // -- call reach: a role-test element (helper or local function) expands to its own reach, memoised
  const elementReachMemo = new Map<string, Reach>();
  const visitingEls = new Set<string>();
  const elementReach = (file: string, name: string): Reach => {
    const key = `${file}#${name}`;
    const memo = elementReachMemo.get(key);
    if (memo) return memo;
    const d = data.get(file);
    if (!d) return fileImportReach(file);   // a helper file without calls (other language)
    if (visitingEls.has(key)) return emptyReach();   // cycle: the outer visit collects the rest
    visitingEls.add(key);
    const r = sitesReach(d, d.sitesByCaller.get(name) ?? [], d.usesByOwner.get(name) ?? [], d.filesByOwner.get(name) ?? []);
    visitingEls.delete(key);
    elementReachMemo.set(key, r);
    return r;
  };
  const wholeHelperReach = (file: string): Reach => {
    const d = data.get(file);
    if (!d) return fileImportReach(file);
    const r = emptyReach();
    for (const name of new Set([...d.sitesByCaller.keys(), ...d.usesByOwner.keys(), ...d.filesByOwner.keys()])) addAll(r, name === MODULE_CALLER ? moduleReach(d) : elementReach(file, name));
    return r;
  };
  const moduleReach = (d: FileData): Reach => sitesReach(d, d.sitesByCaller.get(MODULE_CALLER) ?? [], d.usesByOwner.get(MODULE_CALLER) ?? [], d.filesByOwner.get(MODULE_CALLER) ?? []);

  /** An element of the repo reached by name: a helper in a test file expands, type elements never count (D3). */
  const reachElement = (r: Reach, file: string, name: string): void => {
    if (isTestFile(file)) { r.helpers.add(file); addAll(r, elementReach(file, name)); return; }
    const el = elementOf(file, name);
    if (el && el.kind !== 'type') r.els.set(`${file}#${name}`, file);
  };

  /** A pure re-export file (no elements of its own, e.g. an index.ts barrel): the one file behind it defining `name`. */
  const throughBarrel = (file: string, name: string): string | null => {
    if (filesByPath.get(file)!.elements.length > 0) return null;
    const seen = new Set([file]);
    const found: string[] = [];
    for (let level = [file]; level.length > 0 && found.length === 0; ) {
      const next: string[] = [];
      for (const f of level) for (const to of edgesFrom.get(f) ?? []) {
        if (seen.has(to) || !filesByPath.has(to)) continue;
        seen.add(to);
        if (elementOf(to, name)) found.push(to);
        else if (filesByPath.get(to)!.elements.length === 0) next.push(to);
      }
      level = next;
    }
    return found.length === 1 ? found[0] : null;
  };

  /** A name chain headed by an import binding (`fn`, `ns.fn`, `Cls.m`): the element it names, else its whole file. */
  const reachBinding = (r: Reach, d: FileData, chain: string): void => {
    const [head, member] = chain.split('.');
    const b = d.bindings.get(head);
    if (!b || b.typeOnly || !b.target || !filesByPath.has(b.target)) return;
    const name = b.imported === '*' ? member : b.imported === 'default' ? undefined : b.imported;
    if (isTestFile(b.target)) {
      if (name !== undefined && elementOf(b.target, name)) reachElement(r, b.target, name);
      else { r.helpers.add(b.target); addAll(r, wholeHelperReach(b.target)); }
      return;
    }
    if (name === undefined) { r.files.add(b.target); return; }
    const el = elementOf(b.target, name);
    if (el) { if (el.kind !== 'type') r.els.set(`${b.target}#${name}`, b.target); return; }
    const behind = throughBarrel(b.target, name);
    if (behind) reachElement(r, behind, name);
    else r.files.add(b.target);
  };

  /** Reach of call sites, import uses and source files named by path literals (T26-8). */
  function sitesReach(d: FileData, siteList: CallSite[], uses: string[], files: string[]): Reach {
    const r = emptyReach();
    for (const s of siteList) {
      if (s.verdict.kind === 'edge') reachElement(r, s.verdict.file, s.verdict.name);
      else if (s.verdict.kind === 'unresolved' && s.callee !== null) reachBinding(r, d, s.callee);
    }
    for (const u of uses) reachBinding(r, d, u);
    for (const f of files) r.files.add(f);
    return r;
  }

  // -- cases
  const cases = new Map<string, TestCase>();
  const attachments = new Map<string, TestAttachment>();
  const importedByTests = new Set(snapshot.fileEdges.filter((e) => e.from !== e.to && isTestFile(e.from)).map((e) => e.to));

  const links = handLinks(plan, parts.tree, isTestFile);
  /** A rung plus the tree nodes of helper links (A.7) to a file the rung went through, or to the case's own file. */
  const withHandNodes = (c: TestCase, r: Reach): Reach => {
    const nodes = new Set(r.nodes);
    for (const [file, ids] of links.helpers) if (file === c.file || r.helpers.has(file)) for (const id of ids) nodes.add(id);
    return { ...r, nodes };
  };
  const decide = (c: TestCase, ladder: [ReachStep, Reach][], via: AttachVia, mocked: Set<string>): void => {
    const rungs = ladder.map(([step, r]): [ReachStep, Reach] => [step, withHandNodes(c, filtered(r, (f) => mocked.has(f) || !isSource(f)))]);
    const hit = rungs.find(([, r]) => !isEmpty(r));
    const [step, reach] = hit ?? ['none' as const, emptyReach()];
    const helpers = new Set(rungs.flatMap(([, r]) => [...r.helpers]));
    helpers.delete(c.file);
    cases.set(c.id, c);
    const derived = place(reach, parts);
    const common = { testId: c.id, mocked: [...mocked].sort(), helpers: [...helpers].sort() };
    const hand = links.cases.get(c.id);
    if (!hand) { attachments.set(c.id, { ...common, ...derived, via, step }); return; }
    // A4: an exact case link overrides the derived place; the derived place and its touches stay as touches.
    const target = lowestCommon(parts.tree, hand);
    const touches = [...new Set([...derived.touches, ...(derived.target === null ? [] : [derived.target])])].filter((id) => id !== target).sort();
    attachments.set(c.id, { ...common, level: parts.tree.kindOf(target)!, target, touches, via: 'hand', step: 'hand' });
  };
  const withoutIgnored = (r: Reach): Reach => filtered(r, ignored);

  for (const f of testFiles) {
    const d = data.get(f.file);
    const mocked = new Set((d?.fc.mocks ?? []).flatMap((m) => (m.target ? [m.target] : [])));
    const found = f.elements.filter((e) => e.kind === 'test');
    if (found.length === 0) {
      if (importedByTests.has(f.file)) continue;   // a helper (D7): reached through the cases that use it
      const body = fileImportReach(f.file);
      decide({ id: f.file, file: f.file, name: '', line: 1, endLine: f.lineCount }, [['body', withoutIgnored(body)], ['body+ignored', body]], 'imports', mocked);
      continue;
    }
    if (!d) {
      // Other languages (no calls): every case reaches the file's imports; D2 does not apply (C27).
      const body = fileImportReach(f.file);
      for (const e of found) {
        decide({ id: `${f.file}#${e.name}`, file: f.file, name: e.name, line: e.startLine, endLine: e.endLine },
          [['body', withoutIgnored(body)], ['body+ignored', body]], 'imports', mocked);
      }
      continue;
    }
    const scopes = (f.testBlocks ?? []).filter((b) => b.kind === 'describe');
    const innermostScope = (line: number): number => {
      let best = -1;
      scopes.forEach((s, i) => { if (s.startLine <= line && line <= s.endLine && (best < 0 || s.startLine >= scopes[best].startLine)) best = i; });
      return best;
    };
    const byScope = new Map<number, { sites: CallSite[]; uses: string[]; files: string[] }>();
    for (const m of d.moduleLines) {
      const k = innermostScope(m.line);
      const slot = byScope.get(k) ?? { sites: [], uses: [], files: [] };
      if (m.site) slot.sites.push(m.site);
      if (m.use) slot.uses.push(m.use);
      if (m.file) slot.files.push(m.file);
      byScope.set(k, slot);
    }
    const scopeReach = new Map([...byScope].map(([k, s]) => [k, sitesReach(d, s.sites, s.uses, s.files)]));
    for (const e of found) {
      const body = elementReach(f.file, e.name);
      const setup = emptyReach();
      addAll(setup, body);
      addAll(setup, scopeReach.get(-1) ?? emptyReach());
      scopes.forEach((s, i) => { if (s.startLine <= e.startLine && e.endLine <= s.endLine) addAll(setup, scopeReach.get(i) ?? emptyReach()); });
      decide({ id: `${f.file}#${e.name}`, file: f.file, name: e.name, line: e.startLine, endLine: e.endLine },
        [['body', withoutIgnored(body)], ['body+ignored', body], ['setup', withoutIgnored(setup)], ['setup+ignored', setup]], 'calls', mocked);
    }
  }

  const sorted = [...cases.values()].sort(byFileLine);
  const byTarget = new Map<string, string[]>();
  const byTouch = new Map<string, string[]>();
  for (const c of sorted) {
    const a = attachments.get(c.id)!;
    if (a.target !== null) byTarget.set(a.target, [...(byTarget.get(a.target) ?? []), c.id]);
    for (const t of a.touches) byTouch.set(t, [...(byTouch.get(t) ?? []), c.id]);
  }
  log('test-attach', 'done', { cases: sorted.length, targets: byTarget.size });
  return { cases: new Map(sorted.map((c) => [c.id, c])), attachments, byTarget, byTouch, tree: parts.tree };
}

// ---------------------------------------------------------------- hand links (T26-8, D16, A.7)

/**
 * Hand links of the plan: `test` blocks with `case`, by the tree id of their parent (treeIdOf). A `case` naming a
 * role-test file is a helper link (the file -> tree ids); any other value is a case id (case id -> tree ids). A value
 * that names nothing simply matches no case (check rule test-link-dead reports it); a parent with no tree node (not on
 * the map) links nowhere.
 */
function handLinks(plan: Plan | null, tree: CItemTree, isTestFile: (file: string) => boolean): { cases: Map<string, string[]>; helpers: Map<string, string[]> } {
  const cases = new Map<string, string[]>();
  const helpers = new Map<string, string[]>();
  for (const el of plan?.elements ?? []) {
    const linked = (el.tests ?? []).filter((t) => t.case !== null);
    if (linked.length === 0) continue;
    const id = treeIdOf(tree, el);
    if (id === null) { log('test-attach', 'hand link parent not on the map', { parent: el.id }); continue; }
    for (const t of linked) {
      const into = isTestFile(t.case!) ? helpers : cases;
      into.set(t.case!, [...new Set([...(into.get(t.case!) ?? []), id])]);
    }
  }
  return { cases, helpers };
}

/** treeIdOfPlan on a tree (see there). */
function treeIdOf(tree: CItemTree, el: PlanElement): string | null {
  if (el.kind === 'system') return tree.systemId;
  if (tree.kindOf(el.id) !== undefined) return el.id;
  if (el.kind === 'container' && tree.kindOf(localId(el.id)) === 'container') return localId(el.id);
  const link = el.links.find((l) => l.name !== null);
  return link && tree.kindOf(`${link.path}#${link.name}`) === 'element' ? `${link.path}#${link.name}` : null;
}

// ---------------------------------------------------------------- memo and readers

const memo = new WeakMap<Snapshot, { input: AttachInput; ix: TestIndex }>();

/** attachTests, once per snapshot object (and the same plan, ownership and tests config objects). */
export function testIndexOf(input: AttachInput): TestIndex {
  const hit = memo.get(input.snapshot);
  if (hit && hit.input.plan === input.plan && hit.input.ownership === input.ownership && hit.input.tests === input.tests) return hit.ix;
  const ix = attachTests(input);
  memo.set(input.snapshot, { input, ix });
  return ix;
}

/**
 * Tests of tree id `id`: `own` = attached to it; with `children`, those attached below it; with `touches`, those that
 * touch it (or, with `children`, something below it) but are attached elsewhere. Each test is listed once, in file and
 * line order.
 */
export function testsOf(ix: TestIndex, id: string, o: { children?: boolean; touches?: boolean } = {}): { own: string[]; children: string[]; touches: string[] } {
  const own = [...(ix.byTarget.get(id) ?? [])];
  const seen = new Set(own);
  const order = (ids: string[]): string[] => ids.sort((a, b) => byFileLine(ix.cases.get(a)!, ix.cases.get(b)!));
  const below: string[] = [];
  if (o.children || o.touches) {
    const stack = [...ix.tree.childrenOf(id)];
    while (stack.length > 0) { const n = stack.pop()!; below.push(n); stack.push(...ix.tree.childrenOf(n)); }
  }
  const children: string[] = [];
  if (o.children) for (const n of below) for (const t of ix.byTarget.get(n) ?? []) if (!seen.has(t)) { seen.add(t); children.push(t); }
  const touches: string[] = [];
  if (o.touches) {
    for (const n of [id, ...(o.children ? below : [])]) for (const t of ix.byTouch.get(n) ?? []) if (!seen.has(t)) { seen.add(t); touches.push(t); }
  }
  return { own, children: order(children), touches: order(touches) };
}

/**
 * Tree id of a plan element: a system -> the tree's system; a container -> its scanned container (exact id or local
 * id, as snapshot/build.ts resolves it); a component or element known to the tree -> its fqn; a function block ->
 * its first named link `file#name`. Null when the tree has no node for it (folder mode: the reader passes the view
 * node id it already found).
 */
export function treeIdOfPlan(ix: TestIndex, el: PlanElement): string | null {
  return treeIdOf(ix.tree, el);
}

export interface TestRef {
  id: string; file: string; name: string; line: number;
  level: AttachLevel | 'none'; target: string | null; via: AttachVia;
  relation: 'own' | 'child' | 'touch'; run: RunCommand | null;
}
/** A test to write (T26-13, D16): a `test` block without `case` that no detected case matches yet. */
export interface PlannedTestRef { name: string; parent: string; source: SourcePos; case: string | null }

/** The tests of one c-item for the readers (plan show, MCP, viewer, board). */
export interface TestsReport {
  run: TestRef[];       // attached to the c-item or below it
  toWrite: PlannedTestRef[];   // test blocks to write of the plan element and its plan descendants, not matched by a case
  touches: TestRef[];   // attached elsewhere, touching it
  counts: { run: number; toWrite: number; touches: number };
}

/**
 * testsOf with children and touches, as TestRefs; `runOf` (bound by the caller, it reads manifests) gives run commands.
 * `planEl` (with `plan` for its descendants): its test blocks without `case` go to `toWrite` unless a test of this
 * report (run or touches) matches the name (matchPlannedTest, A9: full chain, or a leaf unique among them).
 */
export function testsReport(
  ix: TestIndex, treeId: string, plan: Plan | null, planEl: PlanElement | null, runOf: (t: TestCase) => RunCommand | null,
): TestsReport {
  const t = testsOf(ix, treeId, { children: true, touches: true });
  const ref = (id: string, relation: TestRef['relation']): TestRef => {
    const c = ix.cases.get(id)!;
    const a = ix.attachments.get(id)!;
    return { id, file: c.file, name: c.name, line: c.line, level: a.level, target: a.target, via: a.via, relation, run: runOf(c) };
  };
  const run = [...t.own.map((id) => ref(id, 'own')), ...t.children.map((id) => ref(id, 'child'))];
  run.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const touches = t.touches.map((id) => ref(id, 'touch'));
  const candidates = [...run, ...touches];
  const planned = planEl ? (plan ? plannedTestsUnder(plan, planEl) : (planEl.tests ?? []).map((test) => ({ parent: planEl.id, test }))) : [];
  const toWrite = planned
    .filter(({ test }) => test.case === null && matchPlannedTest(test, candidates) === null)
    .map(({ parent, test }): PlannedTestRef => ({ name: test.name, parent, source: test.source, case: null }));
  return { run, toWrite, touches, counts: { run: run.length, toWrite: toWrite.length, touches: touches.length } };
}
