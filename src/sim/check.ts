import type { CallIndex } from '../callGraph/callResolve';
import { EDGE_KINDS } from '../callGraph/callResolve';
import type { Plan, PlanElement, PlanFinding, SimItem, SimStep } from '../types';
import { ENTRY_KINDS, isFrontendKind, owningEntry } from '../plan/kinds';
import { resolveSimTarget, type SimTargetHit } from './resolve';
import { log } from '../log';

/**
 * What the s-item rules read besides the items. `code`: `callIndex(snapshot)` (its elements resolve `path#name` refs, its
 * sites judge function -> function pairs); null = no scan. `callFiles`: the files whose calls the scan read
 * (`snapshot.calls`); null = none read, so function -> function pairs give no finding (Q6: T8 reads them when needed).
 * A file outside the set (a 'tests' scan, a language without calls) gives its pairs no finding either.
 */
export interface SimCheckContext {
  plan: Plan | null;
  code: CallIndex | null;
  callFiles: ReadonlySet<string> | null;
}

/** Q4 (K 2026-11-15): a function -> function pair is connected along up to this many resolved calls (A -> x -> y -> B). */
export const SIM_CALL_HOPS = 3;
/** How far the search goes to name a longer path in the message (a pair past SIM_CALL_HOPS is still not connected). */
const PATH_SEARCH_HOPS = 6;

/** Arch kinds an io element may call or be implemented by (pair 2, the NavCall rule of src/view/navModel.ts). */
const ARCH_TARGET_KINDS = new Set(['component', 'function', 'method', 'class']);
/** Plan kinds whose code is one function (pair 3; needsCallIndex reads it too). */
export const FUNCTION_KINDS = new Set(['function', 'method']);

/** A resolved target, as the pair rules see it. */
interface Node {
  name: string;                 // plan fqn or code key, for messages
  el: PlanElement | null;       // the plan element (null for a code-only target)
  code: string | null;          // `file#name` of its code: a code target, or a function/method element's function link
}

/** b783: the second step's `call`, both ends resolved to plan elements; null when absent, a code key or missing. */
type StepCall = { from: PlanElement; to: PlanElement } | null;

type PairVerdict = { kind: 'connected' } | { kind: 'unverified' | 'unconnected'; why: string } | null;

/** The pair rules by verdict (`rule: '...'` literals: test/guide-rules.test.ts reads them). */
const PAIR_RULES: Record<'unverified' | 'unconnected', Pick<PlanFinding, 'severity' | 'rule'>> = {
  unverified: { severity: 'info', rule: 'sim-step-unverified' },
  unconnected: { severity: 'info', rule: 'sim-step-unconnected' },
};

const lastSegment = (name: string): string => name.slice(name.lastIndexOf('.') + 1);
const fileOf = (key: string): string => key.slice(0, key.lastIndexOf('#'));
const nameOf = (key: string): string => key.slice(key.lastIndexOf('#') + 1);

/**
 * The s-item rules (PHASE_25_SIMULATIONS.md T7). Pure: reads the items, the plan and the call index.
 * - `sim-target-missing` (warning): a step target, inline-stage target, `call.from` / `call.to` (QF1) or rows key that
 *   resolves to nothing (a rows key also when it is not a record). id `s-1:3` (step 3, 1-based), `s-2:stage-3` on a journey.
 * - `sim-step-unconnected` (info) / `sim-step-unverified` (info): judged consecutive steps of a flow, id `s-1:2-3`.
 * - `sim-stage-missing` (warning): a journey's `flow` stage that names no s-item, a journey, or itself. id `s-2:stage-3`.
 * `person` is free text (Q7): never a finding. Not sorted (simsForCheck sorts).
 */
export function checkSims(items: SimItem[], ctx: SimCheckContext): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const hits = new Map<string, SimTargetHit>();
  const resolve = (ref: string): SimTargetHit => {
    let hit = hits.get(ref);
    if (!hit) hits.set(ref, (hit = resolveSimTarget(ref, ctx.plan, ctx.code?.elements ?? null)));
    return hit;
  };
  const judge = pairJudge(ctx);
  const byId = new Map(items.map((it) => [it.id, it]));

  for (const item of items) {
    if (item.kind === 'flow') {
      const steps = item.steps ?? [];
      steps.forEach((step, i) => findings.push(...refFindings(step, `${item.id}:${i + 1}`, `${item.id} step ${i + 1}`, resolve)));
      for (let i = 0; i + 1 < steps.length; i++) {
        const f = pairFinding(steps[i], steps[i + 1], i + 1, item.id, resolve, judge);
        if (f) findings.push(f);
      }
      continue;
    }
    (item.stages ?? []).forEach((stage, i) => {
      const id = `${item.id}:stage-${i + 1}`;
      const where = `${item.id} stage ${i + 1}`;
      if ('flow' in stage) {
        const f = stageFinding(stage.flow, item.id, byId);
        if (f) findings.push({ severity: 'warning', rule: 'sim-stage-missing', id, message: `${where}: ${f}` });
      } else if ('target' in stage) {
        findings.push(...refFindings(stage as SimStep, id, where, resolve));
      }
    });
  }
  log('sim', 'checkSims', { items: items.length, findings: findings.length, calls: ctx.callFiles !== null });
  return findings;
}

/** Why a journey's flow stage names no flow, or null when it names one. */
function stageFinding(ref: string, self: string, byId: Map<string, SimItem>): string | null {
  if (ref === self) return `flow '${ref}' is this journey itself`;
  const named = byId.get(ref);
  if (!named) return `flow '${ref}' names no s-item`;
  return named.kind === 'flow' ? null : `flow '${ref}' is a ${named.kind}, not a flow`;
}

/** sim-target-missing for one step (or inline stage): its targets, call.from / call.to (QF1) and rows keys (Q3). */
function refFindings(step: SimStep, id: string, where: string, resolve: (ref: string) => SimTargetHit): PlanFinding[] {
  const out: PlanFinding[] = [];
  const missing = (what: string, why: string): void => {
    out.push({ severity: 'warning', rule: 'sim-target-missing', id, message: `${where}: ${what} ${why}` });
  };
  const NOTHING = 'resolves to nothing (no plan element has this uid or fqn, no code function is at this path#name)';
  for (const t of step.target) if (resolve(t).kind === 'missing') missing(`target '${t}'`, NOTHING);
  for (const side of ['from', 'to'] as const) {
    const ref = step.call?.[side];
    if (ref !== undefined && resolve(ref).kind === 'missing') missing(`call.${side} '${ref}'`, NOTHING);
  }
  for (const key of Object.keys(step.rows ?? {})) {
    const hit = resolve(key);
    if (hit.kind === 'missing') missing(`rows key '${key}'`, 'names no record (no plan element has this uid or fqn)');
    else if (hit.kind === 'code') missing(`rows key '${key}'`, 'is code, not a plan record');
    else if (hit.el.kind !== 'record') missing(`rows key '${key}'`, `is the ${hit.el.kind} ${hit.el.id}, not a record`);
  }
  return out;
}

/**
 * One consecutive pair of flow steps (`at` = the first step's number). Connected when ANY target of the first connects
 * to ANY target of the second; a missing target skips the pair (sim-target-missing reports it). Otherwise the first
 * unverified combination, else the first unconnected one, gives the finding; unjudged combinations give none.
 */
function pairFinding(
  a: SimStep, b: SimStep, at: number, simId: string,
  resolve: (ref: string) => SimTargetHit, judge: (a: Node, b: Node, call: StepCall) => PairVerdict,
): PlanFinding | null {
  const nodes = (s: SimStep): Node[] | null => {
    const out: Node[] = [];
    for (const t of s.target) {
      const hit = resolve(t);
      if (hit.kind === 'missing') return null;
      out.push(hit.kind === 'plan'
        ? { name: hit.el.id, el: hit.el, code: hit.code }
        : { name: hit.key, el: null, code: hit.key });
    }
    return out;
  };
  const from = nodes(a);
  const to = nodes(b);
  if (!from || !to) return null;
  const planEl = (ref: string | undefined): PlanElement | null => {
    const hit = ref === undefined ? null : resolve(ref);
    return hit?.kind === 'plan' ? hit.el : null;
  };
  const callFrom = planEl(b.call?.from);
  const callTo = planEl(b.call?.to);
  const call: StepCall = callFrom && callTo ? { from: callFrom, to: callTo } : null;
  const verdicts: PairVerdict[] = [];
  for (const x of from) for (const y of to) verdicts.push(judge(x, y, call));
  if (verdicts.some((v) => v?.kind === 'connected')) return null;
  const pick = verdicts.find((v) => v?.kind === 'unverified') ?? verdicts.find((v) => v?.kind === 'unconnected');
  if (!pick || pick.kind === 'connected') return null;
  const several = from.length * to.length > 1 ? `; no target of step ${at} connects to a target of step ${at + 1}` : '';
  return { ...PAIR_RULES[pick.kind], id: `${simId}:${at}-${at + 1}`, message: `${simId} steps ${at}-${at + 1}: ${pick.why}${several}` };
}

/** The pair rules over one plan and call index (maps built once per checkSims). */
function pairJudge(ctx: SimCheckContext): (a: Node, b: Node, call: StepCall) => PairVerdict {
  const plan = ctx.plan;
  const elements = plan?.elements ?? [];
  const relations = plan?.relations ?? [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const entryOf = (id: string): string | null => owningEntry(id, byId);
  const codeKindOf = (key: string | null): string | null => (key && ctx.code?.elements.get(key)?.kind) || null;

  /** The element and its ancestors up to the nearest component (inclusive). */
  const upToComponent = (el: PlanElement, into: Set<string>): void => {
    for (let cur: PlanElement | undefined = el; cur; cur = cur.parent === null ? undefined : byId.get(cur.parent)) {
      into.add(cur.id);
      if (cur.kind === 'component') return;
    }
  };
  /** The arch side of pair 2: the element, its ancestors up to its component, and every element under it. */
  const archSide = (n: Node): Set<string> => {
    const side = new Set<string>();
    if (n.el) {
      upToComponent(n.el, side);
      const prefix = `${n.el.id}.`;
      for (const e of elements) if (e.id.startsWith(prefix)) side.add(e.id);
      return side;
    }
    // A code target: the arch elements that link to it (its function, its file, a folder above it) and their components.
    const key = n.code!;
    const file = fileOf(key);
    for (const e of elements) {
      if (!ARCH_TARGET_KINDS.has(e.kind)) continue;
      const links = e.links.some((l) => (l.name !== null
        ? `${l.path}#${l.name}` === key
        : l.path === file || (l.path.endsWith('/') && file.startsWith(l.path))));
      if (links) upToComponent(e, side);
    }
    return side;
  };
  /** b783: the element itself when a container, else its nearest container ancestor (its app); null when none. */
  const containerOf = (id: string): string | null => {
    for (let cur = byId.get(id); cur; cur = cur.parent === null ? undefined : byId.get(cur.parent)) {
      if (cur.kind === 'container') return cur.id;
    }
    return null;
  };
  /**
   * b783: pair 2 through the second step's call. Connected when call.from is in the io entry's container or a relation
   * goes from the io side to it (archSide of call.from), a relation goes from call.from or its ancestors up to its
   * component to archSide(call.to), and call.to ends at the step (in `arch`, or the step element in archSide(call.to)).
   */
  const callLinks = (aEntry: string, ioSide: Set<string>, b: Node, arch: Set<string>, call: StepCall): boolean => {
    if (!call) return false;
    const toSide = archSide({ name: call.to.id, el: call.to, code: null });
    if (!arch.has(call.to.id) && !(b.el && toSide.has(b.el.id))) return false;
    const app = containerOf(call.from.id);
    const fromSide = archSide({ name: call.from.id, el: call.from, code: null });
    if ((app === null || app !== containerOf(aEntry)) && !relations.some((r) => ioSide.has(r.from) && fromSide.has(r.to))) return false;
    const fromUp = new Set<string>();
    upToComponent(call.from, fromUp);
    return relations.some((r) => fromUp.has(r.from) && toSide.has(r.to));
  };

  let graph: Map<string, Set<string>> | null = null;
  /** Shortest resolved call path from -> to (keys, both ends included) within PATH_SEARCH_HOPS calls, else null. */
  const callPath = (from: string, to: string): string[] | null => {
    if (!graph) {
      graph = new Map();
      for (const s of ctx.code?.sites ?? []) {
        if (s.verdict.kind !== 'edge') continue;
        const caller = `${s.file}#${s.caller}`;
        const set = graph.get(caller) ?? new Set<string>();
        set.add(`${s.verdict.file}#${s.verdict.name}`);
        graph.set(caller, set);
      }
    }
    const parent = new Map<string, string | null>([[from, null]]);
    let frontier = [from];
    for (let hop = 0; hop < PATH_SEARCH_HOPS && frontier.length > 0; hop++) {
      if (parent.has(to)) break;
      const next: string[] = [];
      for (const k of frontier) for (const n of graph.get(k) ?? []) if (!parent.has(n)) { parent.set(n, k); next.push(n); }
      frontier = next;
    }
    if (!parent.has(to)) return null;
    const path: string[] = [];
    for (let k: string | null = to; k !== null; k = parent.get(k) ?? null) path.unshift(k);
    return path;
  };

  return (a: Node, b: Node, call: StepCall): PairVerdict => {
    const aEntry = a.el && isFrontendKind(a.el.kind) ? entryOf(a.el.id) : null;

    // 1. io -> io entry: same owning entry, or a relation from the first's entry (or its parts) to the second (NavEdge).
    if (aEntry && b.el && ENTRY_KINDS.has(b.el.kind)) {
      const target = b.el.id;
      if (aEntry === target || relations.some((r) => r.to === target && entryOf(r.from) === aEntry)) return { kind: 'connected' };
      return { kind: 'unconnected', why: `no navigation from ${aEntry} to ${target} (no relation from ${aEntry} or its parts to ${target})` };
    }

    // 2. io part/entry -> arch: a relation from the io element or a parent up to its entry, to the arch element, its
    //    component or an element under it (NavCall; "implements" = such a relation, any label). b783: else through the
    //    second step's call (callLinks).
    const bArch = b.el ? ARCH_TARGET_KINDS.has(b.el.kind) : ARCH_TARGET_KINDS.has(codeKindOf(b.code) ?? '');
    if (aEntry && a.el && bArch) {
      const ioSide = new Set<string>();
      for (let cur: PlanElement | undefined = a.el; cur; cur = cur.id === aEntry || cur.parent === null ? undefined : byId.get(cur.parent)) ioSide.add(cur.id);
      const arch = archSide(b);
      if (relations.some((r) => ioSide.has(r.from) && arch.has(r.to))) return { kind: 'connected' };
      if (callLinks(aEntry, ioSide, b, arch, call)) return { kind: 'connected' };
      const via = a.el.id === aEntry ? '' : ` (or its parents up to ${aEntry})`;
      return { kind: 'unconnected', why: `no relation from ${a.name}${via} to ${b.name}, its component or an element under it` };
    }

    // 3. function/method -> function/method: a resolved call path of at most SIM_CALL_HOPS calls (Q4).
    const isFn = (n: Node): boolean => (n.el ? FUNCTION_KINDS.has(n.el.kind) : EDGE_KINDS.includes(codeKindOf(n.code) ?? ''));
    if (!isFn(a) || !isFn(b)) return null;   // other pairs (arch -> storage, storage -> io, ...) are not judged in v1
    if (ctx.callFiles === null || !ctx.code) return null;
    const known = (n: Node): string | null => (n.code && ctx.code!.elements.has(n.code) ? n.code : null);
    const aKey = known(a);
    const bKey = known(b);
    if (!aKey || !bKey) {
      const without = !aKey ? a.name : b.name;
      return { kind: 'unverified', why: `${without} has no code yet (planned only), so the call from ${a.name} to ${b.name} cannot be checked` };
    }
    if (!ctx.callFiles.has(fileOf(aKey))) return null;   // the scan did not read the calls of this file
    const path = callPath(aKey, bKey);
    if (path && path.length - 1 <= SIM_CALL_HOPS) return { kind: 'connected' };
    const last = lastSegment(nameOf(bKey));
    const untraced = ctx.code.sites.find((s) => s.verdict.kind === 'unresolved' && `${s.file}#${s.caller}` === aKey
      && s.callee !== null && lastSegment(s.callee) === last);
    if (untraced) {
      return { kind: 'unverified', why: `${aKey} has an untraced call '${untraced.callee}' (line ${untraced.line}) that may reach ${bKey}` };
    }
    const longer = path ? `; it reaches it only through ${path.length - 1} calls: ${path.join(' -> ')}` : '';
    return { kind: 'unconnected', why: `no resolved call from ${aKey} to ${bKey} within ${SIM_CALL_HOPS} calls${longer}` };
  };
}
