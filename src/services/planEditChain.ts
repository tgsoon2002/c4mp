/**
 * b899 (SIM-UID): plan edits built one after another on one plan state and written as ONE edit (one link check, one
 * gate, one write). Sims use it to add the code they name and to give elements uids before storing a uid; a later
 * bulk plan edit can use it the same way. Also: the component that owns a piece of code by the plan's own links
 * (codeOwnerOf), the plan element of a piece of code (codeElementOf), and the edit that adds code (addCodeEdit).
 * L3 (Plan editing): imports Plan editing, Ownership (L2), Plan reading and names (L1/L0); nothing from src/cli,
 * src/mcp, src/query or src/sim.
 */
import type { FileOutline, Plan, PlanElement, SnapshotFile } from '../types';
import { extractClaims, resolveOwnership } from '../c4/ownership';
import { elementsNamed } from '../languages/treesitter';
import { PLANNED_CODE_KINDS } from '../plan/plannedElements';
import { addRuleOf } from '../plan/kinds';
import type { AddRule } from '../plan/kinds';
import { c4Id, isReservedId } from '../names';
import { addEdit } from './planOps';
import type { EditResult, PlanEdit } from './planOps';
import { cmdError } from './planState';
import type { PlanState } from './planState';
import { checkFieldValue } from './fieldRules';
import { CMD_NAME } from '../constants';

export class PlanEditChain {
  private current: PlanState;
  private readonly edits: PlanEdit[] = [];
  constructor(readonly start: PlanState) { this.current = start; }
  /** The plan state after every edit kept so far (texts and the plan parsed from them). */
  get state(): PlanState { return this.current; }
  /** Build one edit on the current state. Kept: the state moves on. Refused (or a move/rename edit): nothing changes. */
  apply(build: (state: PlanState) => EditResult): EditResult {
    const r = build(this.current);
    if (!r.ok) return r;
    if (r.edit.moved || r.edit.wireframes || r.edit.lostTests) return { ok: false, error: cmdError('invalid', 'a move, rename or test removal cannot be chained'), target: r.edit.target };
    this.edits.push(r.edit);
    this.current = { ...this.current, texts: r.edit.newTexts, plan: r.edit.after };
    return r;
  }
  /** null when no edit was kept; else ONE PlanEdit from `start` to `state` (every postcondition, note, link check, lost id). */
  edit(): PlanEdit | null {
    if (this.edits.length === 0) return null;
    const edits = [...this.edits];
    return {
      target: edits[0].target, newTexts: this.current.texts, after: this.current.plan,
      post: plan => { for (const e of edits) { const why = e.post(plan); if (why !== null) return why; } return null; },
      notes: [...new Set(edits.flatMap(e => e.notes))], needsScan: edits.some(e => e.needsScan),
      lost: [...new Set(edits.flatMap(e => e.lost))], linkChecks: edits.flatMap(e => e.linkChecks),
    };
  }
}

/** The planned code element (function, method, class, type) whose `#name` link names exactly `rel#name`: the first in plan order, or null. */
export function codeElementOf(plan: Plan, rel: string, name: string): PlanElement | null {
  return plan.elements.find(el => PLANNED_CODE_KINDS.includes(el.kind) && el.links.some(l => l.path === rel && l.name === name)) ?? null;
}

/**
 * The component fqn that owns `outline.file#name` by the plan's component links, folder or claim mode alike: the
 * map's rule (resolveOwnership over extractClaims: a function claim, then a file claim, then a folder claim; a tie
 * goes to the element first in the plan). null = no component link covers it. No scan: the one outline given.
 */
export function codeOwnerOf(plan: Plan, outline: FileOutline, name: string): string | null {
  const file: SnapshotFile = { ...outline, componentId: 'unassigned' };
  const owner = resolveOwnership(extractClaims(plan), [file], []).owner[`${outline.file}#${name}`];
  return owner === undefined || owner === 'unassigned' || owner === 'shared-auto' ? null : owner;
}

/** What addCodeEdit adds: the code (`outline.file` repo-relative, `name` as the outline names it), its owner, its status (default done). */
export interface CodeAddSpec { outline: FileOutline; name: string; owner?: string; status?: string }

/** The plan kind per outline kind of code that may be added (b899: what a sim may point at). */
const CODE_RULES: Record<string, AddRule> = {
  function: addRuleOf('planned-fn') as AddRule,
  class: addRuleOf('planned-class') as AddRule,
  method: { plan: 'method', parents: ['component'], code: true },   // plan add has no planned-method word; parses (test/planMove.test.ts:269)
};

const refuseCode = (message: string): EditResult => ({ ok: false, error: cmdError('invalid', message), target: null });

/**
 * Add `outline.file#name` to the plan through addEdit: under its owning component (codeOwnerOf), kind function /
 * method / class (the outline kind), title = the name, id = c4Id(name) (`_<kind>` for a keyword, as addEdit), a
 * `#name` link, status done and an owner (spec.owner, else the component's `owner` metadata). addEdit writes no uid
 * for code kinds: chain uidEdit after it.
 */
export function addCodeEdit(state: PlanState, spec: CodeAddSpec): EditResult {
  const file = spec.outline.file;
  const ref = `${file}#${spec.name}`;
  const code = elementsNamed(spec.outline, spec.name)[0];
  if (!code) return refuseCode(`no function, class or method '${spec.name}' in ${file}`);
  const rule = CODE_RULES[code.kind];
  if (!rule) return refuseCode(`${ref} is a ${code.kind}; only a function, method or class is added to the plan`);
  const parent = codeOwnerOf(state.plan, spec.outline, spec.name);
  if (parent === null) return refuseCode(`no component claims ${ref}: link its file or folder to a component first (${CMD_NAME} plan link <component> ${file})`);
  const owner = spec.owner ?? state.plan.elements.find(e => e.id === parent)?.metadata.owner;
  if (owner === undefined || owner.trim() === '') {
    return refuseCode(`${ref} is added as a done ${rule.plan} and needs an owner: give one (--owner <name>; MCP: owner) or set owner on ${parent}`);
  }
  const bad = checkFieldValue('owner', owner);
  if (bad !== null) return refuseCode(bad);
  let id = c4Id(spec.name);
  if (isReservedId(id, false)) id = `${id}_${rule.plan}`;   // the id addEdit makes
  const fqn = `${parent}.${id}`;
  const existing = state.plan.elements.find(e => e.id === fqn);
  if (existing) {
    return refuseCode(`${fqn} already exists (${existing.kind} '${existing.title}') and does not link ${ref}: give it as the ref, or link it first (${CMD_NAME} plan link ${fqn} ${ref})`);
  }
  const status = spec.status ?? 'done';
  return addEdit(state, { kindWord: rule.plan, kind: rule, name: spec.name, meta: [['status', status], ['owner', owner]], status, parent, link: ref });
}
