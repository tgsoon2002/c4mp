/**
 * b318 (PLANOPS-1): one pure builder per plan edit (link, set, add, relate). A builder takes the loaded plan state and
 * validated arguments and returns a `PlanEdit` (the new file texts, the postcondition, notes, which checks the gate needs)
 * or a refusal. It writes nothing and runs no scan. The command files (linkCmd, setCmd, addCmd, relateCmd) are thin
 * wrappers: parse options, load the state, call a builder, then `linkCheckError` and `runWrite` over `writeSpecOf`.
 * Bulk apply (later) folds the same builders and writes once through the same gate.
 * Each `parseXArgs` is the part that runs BEFORE the plan is loaded (so argument errors come first, as before).
 * b477: part of the Plan editing service (L3, with linkCheck.ts and fieldRules.ts); imports nothing from src/cli/.
 */
import * as fs from 'fs';
import * as path from 'path';
import { addElementText, addTargetOf } from '../c4/editAdd';
import type { AddElementSpec } from '../c4/editAdd';
import { addLinkText, removeLinkText } from '../c4/editLink';
import { addRelationText } from '../c4/editRelate';
import { setFieldsText } from '../c4/editSet';
import type { SetField } from '../c4/editSet';
import { addTestText, locateElement, locateModelBlock, removeElementMetadata, removeTestText, setElementMetadata } from '../c4/editMeta';
import { unifiedDiff } from '../c4/textDiff';
import { starterWireframe } from '../c4/wireframeRefs';
import { c4Id, isReservedId } from '../names';
import { newUid, UID_KEY } from '../util/uid';
import { addRuleOf, addableKinds, topLevelKinds } from '../plan/kinds';
import type { AddRule } from '../plan/kinds';
import { formatLink, parseLink } from '../plan/links';
import { isClaimModePlan } from '../c4/ownership';
import { parsePlanTexts } from '../plan/parser';
import { isTestRef } from '../util/testIds';
import { didYouMean } from '../util/text';
import type { Plan, PlanElement, PlanLink } from '../types';
import { timed } from '../log';
import { CLAIM_SWITCH_NOTE, cmdError, resolveTarget, scanWithPlan, targetInfoOf, withText } from './planState';
import type { CmdError, Opts, PlanState, TargetInfo, WriteSpec } from './planState';
import { checkFieldValue, doneNeedsOwner } from './fieldRules';
import { linkProblems } from './linkCheck';
import { CMD_NAME } from '../constants';

/** One plan edit, ready for the gate. `lost` = element ids the edit removes (becomes the gate's `allowLost`). */
export interface PlanEdit {
  target: TargetInfo;
  /** The whole edited plan: every plan file with its new text. */
  newTexts: Map<string, string>;
  /** The plan parsed from `newTexts`. */
  after: Plan;
  /** Postcondition on the edited plan (in memory and again on the plan re-read from disk). String = failure reason. */
  post: (plan: Plan) => string | null;
  notes: string[];
  /** The gate needs the full check scan. */
  needsScan: boolean;
  lost: string[];
  /** Links of `fqn` that must resolve (needs a scan); `only` picks which of its links are checked (default all). */
  linkChecks: { fqn: string; only?: (l: PlanLink) => boolean }[];
  /** plan move / rename (PLAN_MOVE.md 4): the gate's old -> new map, wireframe edits, extra report fields. */
  moved?: WriteSpec['moved'];
  wireframes?: WriteSpec['wireframes'];
  report?: WriteSpec['report'];
  /** plan remove --test (Phase 26, A8): the test blocks the edit removes (the gate's `allowLostTests`). */
  lostTests?: WriteSpec['allowLostTests'];
}

export type EditResult = { ok: true; edit: PlanEdit } | { ok: false; error: CmdError; target: TargetInfo | null };

const refuse = (error: CmdError, target: TargetInfo | null = null): EditResult => ({ ok: false, error, target });
export const isCmdError = (x: unknown): x is CmdError => typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const optString = (opts: Opts, k: string): string | undefined => (typeof opts[k] === 'string' ? (opts[k] as string) : undefined);

/** `a, b or c`. */
export const orList = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/** The gate/write input of an edit; `opts` carries yes, force, check, json. */
export function writeSpecOf(command: string, opts: Opts, state: PlanState, edit: PlanEdit): WriteSpec {
  return {
    command, opts, state, target: edit.target, newTexts: edit.newTexts, notes: edit.notes, scan: edit.needsScan,
    allowLost: edit.lost, post: edit.post,
    ...(edit.moved ? { moved: edit.moved } : {}),
    ...(edit.wireframes ? { wireframes: edit.wireframes } : {}),
    ...(edit.report ? { report: edit.report } : {}),
    ...(edit.lostTests ? { allowLostTests: edit.lostTests } : {}),
  };
}

/**
 * Run the edit's link checks (one scan). Returns the refusal, or null when every checked link resolves.
 * A scan that cannot run is a refusal too (nothing is written).
 */
export function linkCheckError(state: PlanState, edit: PlanEdit): CmdError | null {
  if (edit.linkChecks.length === 0) return null;
  try {
    const problems = timed('link check', () => edit.linkChecks.flatMap(c => linkProblems(state, edit.after, c.fqn, c.only)));
    if (problems.length > 0) return cmdError('invalid', problems.join('\n'));
  } catch (err) {
    return cmdError('invalid', `the link check could not run, nothing written: ${errText(err)}`);
  }
  return null;
}

// --- link ----------------------------------------------------------------------------------------------------

export interface LinkArgs { rel: string; frag: string | null; linkArg: string; title?: string }

const sameLink = (a: PlanLink, b: PlanLink): boolean =>
  a.path === b.path && a.name === b.name && a.lines?.start === b.lines?.start && a.lines?.end === b.lines?.end;

export function parseLinkArgs(linkArg: string, title?: string): LinkArgs | CmdError {
  const hash = linkArg.indexOf('#');
  const rel = (hash < 0 ? linkArg : linkArg.slice(0, hash)).replace(/^\.\//, '');
  const frag = hash < 0 ? null : linkArg.slice(hash + 1);
  if (rel === '' || frag === '' || path.isAbsolute(rel)) {
    return cmdError('invalid', `the link must be a repo-relative path or path#name, got '${linkArg}'`);
  }
  if (title !== undefined) {
    const bad = checkFieldValue('title', title);
    if (bad) return cmdError('invalid', bad);
  }
  return { rel, frag, linkArg, ...(title !== undefined ? { title } : {}) };
}

export function linkEdit(state: PlanState, target: string, args: LinkArgs): EditResult {
  const resolved = resolveTarget(state, target, { codeToo: true });
  if (!resolved.ok) return refuse(resolved.error);
  const el = resolved.el;
  const info = targetInfoOf(el);
  if (el.kind === 'subregion') return refuse(cmdError('invalid', `${el.id} is a subregion: a subregion claims nothing; link one of its components`), info);

  const file = el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the element is not a plan file read by this command: ${file}`), info);

  const linkText = formatLink(args.rel, path.posix.dirname(file), args.frag, state.repoRoot);
  let edited: ReturnType<typeof addLinkText>;
  try {
    edited = addLinkText(oldText, el.id, linkText, args.title);
  } catch (err) {
    return refuse(cmdError('invalid', errText(err)), info);
  }
  if (!edited.changed) return refuse(cmdError('invalid', `could not edit ${el.id} in ${file} (text not editable)`), info);
  const newTexts = withText(state, file, edited.text);

  const after = parsePlanTexts(state.repoRoot, newTexts);
  const afterEl = after.elements.find(e => e.id === el.id);
  if (!afterEl || afterEl.links.length !== el.links.length + 1) {
    return refuse(cmdError('invalid', `the new link was not read back from the edited text (${linkText})`), info);
  }
  if (afterEl.links.every(l => el.links.some(b => sameLink(b, l)))) {
    return refuse(cmdError('invalid', `${el.id} already links ${args.linkArg}; nothing added`), info);
  }

  const notes: string[] = [];
  if (args.frag !== null && !isClaimModePlan(state.plan) && isClaimModePlan(after)) notes.push(CLAIM_SWITCH_NOTE);

  return {
    ok: true,
    edit: {
      target: info, newTexts, after, notes, needsScan: true, lost: [],
      linkChecks: [{ fqn: el.id, only: l => !el.links.some(b => sameLink(b, l)) }],
      post: plan => {
        const now = plan.elements.find(e => e.id === el.id);
        if (!now || now.links.length !== el.links.length + 1) return `${el.id} should have ${el.links.length + 1} links after the edit`;
        return null;
      },
    },
  };
}

/** b899: give the element `fqn` (any kind, planned code too) a new uid. Sims store uids only and mint one when the element has none. */
export function uidEdit(state: PlanState, fqn: string): EditResult {
  const el = state.plan.elements.find(e => e.id === fqn);
  if (!el) return refuse(cmdError('not-found', `no element ${fqn}`));
  const info = targetInfoOf(el);
  if (el.metadata[UID_KEY] !== undefined) return refuse(cmdError('invalid', `${fqn} already has uid ${el.metadata[UID_KEY]}; nothing added`), info);
  const file = el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the element is not a plan file read by this command: ${file}`), info);
  const uid = newUid();
  const edited = setElementMetadata(oldText, fqn, UID_KEY, uid);
  if (!edited.changed) return refuse(cmdError('invalid', `could not add a uid to ${fqn} in ${file} (text not editable)`), info);
  const newTexts = withText(state, file, edited.text);
  return {
    ok: true,
    edit: {
      target: { uid, fqn, kind: el.kind }, newTexts, after: parsePlanTexts(state.repoRoot, newTexts),
      notes: [], needsScan: false, lost: [], linkChecks: [],
      post: plan => {
        const now = plan.elements.filter(e => e.id === fqn);
        return now.length === 1 && now[0].metadata[UID_KEY] === uid ? null : `${fqn} should have uid ${uid} after the edit`;
      },
    },
  };
}

/** `path[#name | #Lx-Ly]` of a link as the user types it (for refusal texts). */
const linkLabel = (l: PlanLink): string =>
  l.path + (l.name ? `#${l.name}` : l.lines ? `#L${l.lines.start}${l.lines.end !== l.lines.start ? `-L${l.lines.end}` : ''}` : '');

/**
 * b904 plan unlink: remove the one body link line of the target that matches `args.linkArg` (path[#name], titles
 * ignored). Refused when none matches, when several lines match (hand-made duplicates) or when the read links cannot
 * be paired with the text lines. The gate scans afterwards, so a removal that leaves code unowned is refused there.
 */
export function unlinkEdit(state: PlanState, target: string, args: LinkArgs): EditResult {
  const resolved = resolveTarget(state, target, { codeToo: true });
  if (!resolved.ok) return refuse(resolved.error);
  const el = resolved.el;
  const info = targetInfoOf(el);
  if (el.kind === 'subregion') return refuse(cmdError('invalid', `${el.id} is a subregion: a subregion claims nothing; it has no link to remove`), info);

  const file = el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the element is not a plan file read by this command: ${file}`), info);

  const want = parseLink(args.linkArg, '_.c4');
  const hits = el.links.flatMap((l, i) => (sameLink(l, want) ? [i] : []));
  const removeHint = `to delete the whole element use c4mp plan remove ${el.id}`;
  if (hits.length === 0) {
    const have = el.links.length === 0 ? 'it has no links' : `links: ${el.links.map(linkLabel).join(', ')}`;
    return refuse(cmdError('invalid', `${el.id} has no link '${args.linkArg}' (${have}); ${removeHint}`), info);
  }
  if (hits.length > 1) {
    return refuse(cmdError('invalid', `${el.id} has ${hits.length} link lines for '${args.linkArg}': a hand edit made duplicates (plan link refuses a second identical link); remove the extra line from the .c4 file by hand and run ${CMD_NAME} plan unlink again`), info);
  }
  const lines = locateElement(oldText, el.id)?.linkLines.length ?? 0;
  if (el.links.length !== lines) {
    return refuse(cmdError('invalid', `the links of ${el.id} cannot be matched to its text lines (${el.links.length} read, ${lines} found in ${file}); nothing written`), info);
  }

  const edited = removeLinkText(oldText, el.id, hits[0]);
  if (!edited.changed) return refuse(cmdError('invalid', `could not remove the link of ${el.id} in ${file} (text not editable)`), info);
  const newTexts = withText(state, file, edited.text);
  return {
    ok: true,
    edit: {
      target: info, newTexts, after: parsePlanTexts(state.repoRoot, newTexts), notes: [], needsScan: true, lost: [], linkChecks: [],
      post: plan => {
        const now = plan.elements.find(e => e.id === el.id);
        return now && now.links.length === el.links.length - 1 ? null : `${el.id} should have ${el.links.length - 1} links after the edit`;
      },
    },
  };
}

// --- set -----------------------------------------------------------------------------------------------------

const SET_META_KEYS = ['status', 'owner', 'sprint', 'priority', 'signature', 'purpose', 'shape', 'role'];   // shape: C1 C2 (b834), a person's head; role: b908, a foundation component
/** b908: the keys `plan set --unset` may remove (the metadata keys). */
export const SET_UNSET_KEYS = SET_META_KEYS;
const SET_BODY_KEYS = ['title', 'description', 'technology'];
export const SET_ALLOWED_KEYS = [...SET_META_KEYS, ...SET_BODY_KEYS];
const SET_NEVER_KEYS = ['uid', 'layout'];

/** `key=value` pairs, split on the FIRST `=` (the value may contain `=`); every key and value is checked. */
export function parseSetArgs(pairs: string[]): SetField[] | CmdError {
  const out: SetField[] = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) return cmdError('invalid', `'${p}' is not key=value`);
    const key = p.slice(0, eq);
    if (SET_NEVER_KEYS.includes(key)) {
      return cmdError('invalid', `${key} cannot be changed with set (${key === 'uid' ? `uids are written by ${CMD_NAME} plan ids and ${CMD_NAME} plan add` : `layout is written by ${CMD_NAME} plan apply-layout`})`);
    }
    if (!SET_ALLOWED_KEYS.includes(key)) {
      const m = didYouMean(key, SET_ALLOWED_KEYS);   // b219
      return cmdError('invalid', `unknown key '${key}'${m ? `, did you mean '${m}'?` : '.'} Allowed: ${SET_ALLOWED_KEYS.join(', ')}`);
    }
    if (out.some(f => f.key === key)) return cmdError('invalid', `key '${key}' is given twice`);
    out.push({ key, value: p.slice(eq + 1) });
  }
  for (const f of out) {
    const bad = checkFieldValue(f.key, f.value);
    if (bad) return cmdError('invalid', bad);
  }
  return out;
}

/** b908: the keys of `plan set --unset`: metadata keys only (SET_UNSET_KEYS); uid/layout as in parseSetArgs; not also set. */
export function parseUnsetArgs(keys: string[], fields: SetField[]): string[] | CmdError {
  const out: string[] = [];
  for (const key of keys) {
    if (SET_NEVER_KEYS.includes(key)) return cmdError('invalid', `${key} cannot be removed with set (${key === 'uid' ? `uids are written by ${CMD_NAME} plan ids and ${CMD_NAME} plan add` : `layout is written by ${CMD_NAME} plan apply-layout`})`);
    if (!SET_UNSET_KEYS.includes(key)) {
      const m = didYouMean(key, SET_UNSET_KEYS);
      return cmdError('invalid', `--unset takes a metadata key${m ? `; did you mean '${m}'?` : '.'} Allowed: ${SET_UNSET_KEYS.join(', ')}`);
    }
    if (out.includes(key) || fields.some(f => f.key === key)) return cmdError('invalid', `key '${key}' is given twice`);
    out.push(key);
  }
  return out;
}

/** Does the parsed element already hold this value? */
function isCurrent(el: { title: string; description: string | null; technology: string | null; metadata: Record<string, string> }, f: SetField): boolean {
  if (f.key === 'title') return el.title === f.value;
  if (f.key === 'description') return el.description === f.value;
  if (f.key === 'technology') return el.technology === f.value;
  return el.metadata[f.key] === f.value;
}

export function setEdit(state: PlanState, target: string, fields: SetField[], unset: string[] = []): EditResult {
  const resolved = resolveTarget(state, target, { codeToo: true });
  if (!resolved.ok) return refuse(resolved.error);
  const el = resolved.el;
  const info = targetInfoOf(el);

  const status = fields.find(f => f.key === 'status')?.value;
  if (status !== undefined) {
    const problem = doneNeedsOwner(status, fields.find(f => f.key === 'owner')?.value ?? el.metadata.owner);
    if (problem) return refuse(cmdError('invalid', problem), info);
  }

  const file = el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the element is not a plan file read by this command: ${file}`), info);
  let edited: ReturnType<typeof setFieldsText>;
  try {
    edited = setFieldsText(oldText, el.id, fields);
    for (const key of unset) edited = { ...edited, text: removeElementMetadata(edited.text, el.id, key).text };   // b908
  } catch (err) {
    return refuse(cmdError('invalid', errText(err)), info);
  }
  if (edited.text === oldText && (fields.some(f => !isCurrent(el, f)) || unset.some(k => el.metadata[k] !== undefined))) {
    return refuse(cmdError('invalid', `could not edit ${el.id} in ${file} (text not editable)`), info);
  }
  const newTexts = withText(state, file, edited.text);

  return {
    ok: true,
    edit: {
      target: info, newTexts, after: parsePlanTexts(state.repoRoot, newTexts), notes: [], lost: [], linkChecks: [],
      needsScan: status === 'done' || status === 'in-progress',
      post: plan => {
        const now = plan.elements.filter(e => e.id === el.id);
        if (now.length !== 1) return `${el.id} should exist exactly once after the edit, found ${now.length}`;
        for (const f of fields) if (!isCurrent(now[0], f)) return `${f.key} of ${el.id} is not '${f.value}' after the edit`;
        for (const k of unset) if (now[0].metadata[k] !== undefined) return `${k} of ${el.id} is still set after the edit`;
        return null;
      },
    },
  };
}

// --- relate --------------------------------------------------------------------------------------------------

export interface RelateArgs { label?: string }

export function parseRelateArgs(label?: string): RelateArgs | CmdError {
  if (label !== undefined) {
    const bad = checkFieldValue('label', label);
    if (bad) return cmdError('invalid', bad);
  }
  return label !== undefined ? { label } : {};
}

export function relateEdit(state: PlanState, fromArg: string, toArg: string, args: RelateArgs): EditResult {
  const from = resolveTarget(state, fromArg, { codeToo: true });
  if (!from.ok) return refuse({ ...from.error, message: `from: ${from.error.message}` });
  const to = resolveTarget(state, toArg, { codeToo: true });
  if (!to.ok) return refuse({ ...to.error, message: `to: ${to.error.message}` }, targetInfoOf(from.el));
  const info = targetInfoOf(from.el);

  if (from.el.id === to.el.id) return refuse(cmdError('invalid', `${from.el.id} cannot relate to itself`), info);
  const dup = state.plan.relations.find(r => r.from === from.el.id && r.to === to.el.id);
  if (dup) {
    return refuse(cmdError('invalid', `${from.el.id} -> ${to.el.id} already exists${dup.label ? ` ('${dup.label}')` : ''}; nothing added`), info);
  }

  const file = from.el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the element is not a plan file read by this command: ${file}`), info);
  let edited: ReturnType<typeof addRelationText>;
  try {
    edited = addRelationText(oldText, from.el.id, to.el.id, args.label);
  } catch (err) {
    return refuse(cmdError('invalid', errText(err)), info);
  }
  if (!edited.changed) return refuse(cmdError('invalid', `could not edit ${from.el.id} in ${file} (text not editable)`), info);
  const newTexts = withText(state, file, edited.text);

  const wantedLabel = args.label ?? null;
  return {
    ok: true,
    edit: {
      target: info, newTexts, after: parsePlanTexts(state.repoRoot, newTexts), notes: [], needsScan: false, lost: [], linkChecks: [],
      post: plan => {
        const now = plan.relations.filter(r => r.from === from.el.id && r.to === to.el.id);
        if (now.length !== 1) return `${from.el.id} -> ${to.el.id} should exist exactly once after the edit, found ${now.length}`;
        if (now[0].label !== wantedLabel) return `the label of ${from.el.id} -> ${to.el.id} is not as asked`;
        if (plan.relations.length !== state.plan.relations.length + 1) return 'the edit changed the number of relations by more than one';
        return null;
      },
    },
  };
}

// --- add -----------------------------------------------------------------------------------------------------

/** The word that stands for "a top-level kind, chosen with --as" (never guessed from the name: 'Admin' may be a person or a tool). */
export const ADD_CONTEXT = 'context';
const ADD_CODE_ONLY_KEYS = ['signature', 'purpose'];
const ADD_META_KEYS = ['status', 'owner', 'sprint', 'priority', 'signature', 'purpose'];
/** Keys `--meta` may not set: uid and layout are written by the tool, the rest have their own option (and value check). */
const ADD_META_REFUSED = ['uid', 'layout', ...ADD_META_KEYS];

export interface AddArgs {
  kindWord: string;
  kind: AddRule;
  name: string;
  meta: [string, string][];
  status?: string;
  title?: string;
  description?: string;
  tech?: string;
  parent?: string;
  id?: string;
  link?: string;
  /** `plan add test --case`: a hand link (test case id or role-test helper file). */
  case?: string;
}

/** Options `plan add test` takes besides --parent and --case (the rest describe an element, a test block has none). */
const ACCESSORY_REFUSED = ['as', 'title', 'id', 'description', 'tech', 'link', ...ADD_META_KEYS];

/** Options → validated add arguments (the checks that need no plan). `opts` uses the CLI option names. */
export function parseAddArgs(kindWordArg: string, name: string, opts: Opts): AddArgs | CmdError {
  let kindWord = kindWordArg;
  const as = optString(opts, 'as');
  if (kindWord === ADD_CONTEXT) {
    if (as === undefined || !topLevelKinds().includes(as)) {
      return cmdError('invalid', `plan add ${ADD_CONTEXT} needs --as ${orList(topLevelKinds())}${as === undefined ? '' : `, got '${as}'`}`);
    }
    kindWord = as;
  } else if (as !== undefined) {
    return cmdError('invalid', `--as is only for 'plan add ${ADD_CONTEXT}'`);
  }
  const kind = addRuleOf(kindWord);
  if (!kind) return cmdError('invalid', `kind must be one of ${[...addableKinds(), ADD_CONTEXT].join(', ')}, got '${kindWord}'`);
  const caseId = optString(opts, 'case');
  if (kind.accessory) {
    const extra = [...ACCESSORY_REFUSED.filter(k => optString(opts, k) !== undefined), ...(Array.isArray(opts.meta) && opts.meta.length > 0 ? ['meta'] : [])];
    if (extra.length > 0) return cmdError('invalid', `plan add ${kindWord} takes only --parent and --case, got ${extra.map(k => `--${k}`).join(', ')}`);
    for (const [k, v] of [['name', name], ['case', caseId]] as const) {
      if (v === undefined) continue;
      if (v.trim() === '' || /[\r\n]/.test(v)) return cmdError('invalid', `the test ${k} must be non-empty and on one line`);
    }
    return { kindWord, kind, name, meta: [], ...(optString(opts, 'parent') !== undefined ? { parent: optString(opts, 'parent') } : {}), ...(caseId !== undefined ? { case: caseId } : {}) };
  }
  if (caseId !== undefined) return cmdError('invalid', `--case is only for 'plan add test'`);

  const meta: [string, string][] = [];
  for (const k of ADD_META_KEYS) {
    const v = optString(opts, k);
    if (v === undefined) continue;
    if (ADD_CODE_ONLY_KEYS.includes(k) && !kind.code) return cmdError('invalid', `--${k} is only for planned-fn, planned-class and planned-type`);
    const bad = checkFieldValue(k, v);
    if (bad) return cmdError('invalid', bad);
    meta.push([k, v]);
  }
  // b210: --meta key=value (repeatable), split on the FIRST '='; the key may be dotted (index.<name>). The writer checks the key form.
  const metaArgs = Array.isArray(opts.meta) ? (opts.meta as string[]) : [];
  for (const p of metaArgs) {
    const eq = p.indexOf('=');
    if (eq <= 0) return cmdError('invalid', `--meta '${p}' is not key=value`);
    const k = p.slice(0, eq);
    if (ADD_META_REFUSED.includes(k)) return cmdError('invalid', `--meta cannot set '${k}'${k === 'uid' || k === 'layout' ? ' (written by the tool)' : ` (use --${k})`}`);
    if (meta.some(([mk]) => mk === k)) return cmdError('invalid', `metadata key '${k}' is given twice`);
    const bad = checkFieldValue(k, p.slice(eq + 1));
    if (bad) return cmdError('invalid', bad);
    meta.push([k, p.slice(eq + 1)]);
  }
  const status = optString(opts, 'status');
  const ownerProblem = doneNeedsOwner(status, optString(opts, 'owner'));
  if (ownerProblem) return cmdError('invalid', ownerProblem);
  const title = optString(opts, 'title');
  const description = optString(opts, 'description');
  const tech = optString(opts, 'tech');
  for (const [k, v] of [['name', name], ['title', title], ['description', description], ['tech', tech]] as const) {
    if (v === undefined) continue;
    const bad = checkFieldValue(k, v);
    if (bad) return cmdError('invalid', bad);
  }
  const defined = <T>(k: string, v: T | undefined) => (v !== undefined ? { [k]: v } : {});
  return {
    kindWord, kind, name, meta,
    ...defined('status', status), ...defined('title', title), ...defined('description', description), ...defined('tech', tech),
    ...defined('parent', optString(opts, 'parent')), ...defined('id', optString(opts, 'id')), ...defined('link', optString(opts, 'link')),
  };
}

export function addEdit(state: PlanState, args: AddArgs): EditResult {
  if (args.kind.accessory) return addTestEdit(state, args);
  const { kindWord, kind, name, meta, status } = args;
  const isCode = kind.code;
  const topLevel = kind.parents.length === 0;

  // The parent rule is the kind table's (parents []: top level of the model, no --parent).
  let parentId: string | null = null;
  let file: string | undefined;
  let at: { extendIndex: number } | undefined;   // W5 (b301): the parent's extend block the child goes into
  if (topLevel) {
    if (args.parent !== undefined) return refuse(cmdError('invalid', `a ${kindWord} is a top-level element and takes no --parent`));
    // the model block of the file that holds the first system, else of the first plan file that has one
    const systemFile = state.plan.elements.find(e => e.kind === 'system')?.source.file;
    file = [...(systemFile !== undefined ? [systemFile] : []), ...state.texts.keys()].find(f => locateModelBlock(state.texts.get(f) ?? '') !== null);
    if (file === undefined) return refuse(cmdError('invalid', 'no plan file has a model { } block to add a top-level element to'));
  } else {
    if (args.parent === undefined) return refuse(cmdError('invalid', `a ${kindWord} goes under a ${orList(kind.parents)}: --parent <target> is required`));
    const parent = resolveTarget(state, args.parent);
    if (!parent.ok) return refuse(parent.error);
    if (!kind.parents.includes(parent.el.kind)) {
      return refuse(cmdError('invalid', `a ${kindWord} goes under a ${orList(kind.parents)}, but '${args.parent}' is a ${parent.el.kind}`));
    }
    parentId = parent.el.id;
    // W5 (b301, C13): the file that already holds the parent's children of the same view (addTargetOf)
    const target = addTargetOf(state.plan, state.texts, parentId, kind.plan);
    file = target.file;
    if (target.extendIndex !== null) at = { extendIndex: target.extendIndex };
  }

  // PS-3.16: a keyword cannot be an element id. An explicit --id is refused; the default id gets `_<kind>`.
  const notes: string[] = [];
  if (args.id !== undefined && isReservedId(args.id, topLevel)) {
    return refuse(cmdError('invalid', `id '${args.id}' is a plan keyword and cannot be an element id; pick another --id`));
  }
  let id = args.id ?? c4Id(name);
  if (args.id === undefined && isReservedId(id, topLevel)) {
    const safe = `${id}_${kind.plan}`;
    notes.push(`id '${id}' is a plan keyword; using '${safe}' (pass --id to choose)`);
    id = safe;
  }
  const fqn = parentId === null ? id : `${parentId}.${id}`;
  const existing = state.plan.elements.find(e => e.id === fqn);
  if (existing) return refuse(cmdError('invalid', `${fqn} already exists (${existing.kind} '${existing.title}'); nothing added`, { hint: 'use --id to pick another id' }));

  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the parent is not a plan file read by this command: ${file}`));

  let linkSpec: string | undefined;
  if (args.link !== undefined) {
    const hash = args.link.indexOf('#');
    const linkTarget = (hash < 0 ? args.link : args.link.slice(0, hash)).replace(/^\.\//, '');
    const frag = hash < 0 ? null : args.link.slice(hash + 1);
    if (linkTarget === '' || frag === '') return refuse(cmdError('invalid', `--link must look like path or path#name, got '${args.link}'`));
    linkSpec = formatLink(linkTarget, path.posix.dirname(file), frag, state.repoRoot);
  }

  const uid = isCode ? undefined : newUid();
  const spec: AddElementSpec = {
    id,
    kind: kind.plan,
    title: args.title ?? name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.tech !== undefined ? { technology: args.tech } : {}),
    ...(linkSpec !== undefined ? { links: [linkSpec] } : {}),
    metadata: [...(uid ? [[UID_KEY, uid] as [string, string]] : []), ...meta],
  };
  let edited: ReturnType<typeof addElementText>;
  try {
    edited = addElementText(oldText, parentId, spec, at);
  } catch (err) {
    return refuse(cmdError('invalid', errText(err)));
  }
  if (!edited.changed) return refuse(cmdError('invalid', `could not insert under ${parentId ?? 'model'} in ${file} (text not editable)`));
  const newTexts = withText(state, file, edited.text);
  const after = parsePlanTexts(state.repoRoot, newTexts);

  if (linkSpec !== undefined && linkSpec.includes('#') && !isClaimModePlan(state.plan) && isClaimModePlan(after)) {
    notes.push(CLAIM_SWITCH_NOTE);
  }

  const wantedMeta = new Map(spec.metadata);
  return {
    ok: true,
    edit: {
      target: { uid: uid ?? null, fqn, kind: kind.plan },
      newTexts, after, notes, lost: [],
      linkChecks: linkSpec !== undefined ? [{ fqn }] : [],
      needsScan: linkSpec !== undefined || status === 'done' || status === 'in-progress',
      post: plan => {
        const el: PlanElement[] = plan.elements.filter(e => e.id === fqn);
        if (el.length !== 1) return `${fqn} should exist exactly once after the edit, found ${el.length}`;
        if (el[0].parent !== parentId || el[0].kind !== kind.plan || el[0].title !== spec.title) return `${fqn} was not written as asked (parent, kind or title differ)`;
        for (const [k, v] of wantedMeta) if (el[0].metadata[k] !== v) return `${fqn} metadata ${k} is '${el[0].metadata[k]}', wanted '${v}'`;
        return null;
      },
    },
  };
}

// --- test blocks (Phase 26, T26-13, D16/D18) --------------------------------------------------------------------

type TestOf = (el: PlanElement | undefined, name: string) => number;
const testsNamed: TestOf = (el, name) => (el?.tests ?? []).filter(t => t.name === name).length;

/**
 * `plan add test "<name>" --parent X [--case <id>]`: a one-line `test` block at the end of X's body (D16). X must be a
 * container, component, function or method (ACCESSORY_ADD_KINDS); a second block of the same name under X is refused;
 * `--case` must name a detected test case id or a role-test file of a scan with the plan (a hand link is never guessed).
 */
export function addTestEdit(state: PlanState, args: AddArgs): EditResult {
  const { kindWord, kind, name } = args;
  if (args.parent === undefined) return refuse(cmdError('invalid', `a ${kindWord} goes under a ${orList(kind.parents)}: --parent <target> is required`));
  const parent = resolveTarget(state, args.parent, { codeToo: true });
  if (!parent.ok) return refuse(parent.error);
  const el = parent.el;
  const info = targetInfoOf(el);
  if (!kind.parents.includes(el.kind)) {
    return refuse(cmdError('invalid', `a ${kindWord} goes under a ${orList(kind.parents)}, but '${args.parent}' is a ${el.kind}`), info);
  }
  if (testsNamed(el, name) > 0) return refuse(cmdError('invalid', `${el.id} already has test '${name}'; nothing added`), info);
  const caseId = args.case ?? null;
  if (caseId !== null) {
    let known: boolean;
    try {
      known = isTestRef(scanWithPlan(state, state.plan), caseId);
    } catch (err) {
      return refuse(cmdError('invalid', `the case check could not run, nothing written: ${errText(err)}`), info);
    }
    if (!known) {
      return refuse(cmdError('invalid', `--case '${caseId}' is neither a test case id (file#describe › name) nor a test file of the scan`, {
        hint: `${CMD_NAME} outline <test file> --repo . lists its test cases`,
      }), info);
    }
  }
  const file = el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the parent is not a plan file read by this command: ${file}`), info);
  let edited: ReturnType<typeof addTestText>;
  try {
    edited = addTestText(oldText, el.id, { name, case: caseId });
  } catch (err) {
    return refuse(cmdError('invalid', errText(err)), info);
  }
  if (!edited.changed) return refuse(cmdError('invalid', `could not insert under ${el.id} in ${file} (text not editable)`), info);
  const newTexts = withText(state, file, edited.text);
  return {
    ok: true,
    edit: {
      target: info, newTexts, after: parsePlanTexts(state.repoRoot, newTexts), notes: [], needsScan: false, lost: [], linkChecks: [],
      post: plan => {
        const now = plan.elements.find(e => e.id === el.id);
        const hit = (now?.tests ?? []).filter(t => t.name === name);
        if (hit.length !== 1) return `${el.id} should have test '${name}' exactly once after the edit, found ${hit.length}`;
        if (hit[0].case !== caseId) return `test '${name}' of ${el.id} was not written as asked (case differs)`;
        return null;
      },
    },
  };
}

/** `plan remove X --test "<name>"`: deletes that test block of X (its line, when it has one to itself); the gate allows only it. */
export function removeTestEdit(state: PlanState, target: string, name: string): EditResult {
  const resolved = resolveTarget(state, target, { codeToo: true });
  if (!resolved.ok) return refuse(resolved.error);
  const el = resolved.el;
  const info = targetInfoOf(el);
  const had = testsNamed(el, name);
  if (had === 0) {
    const names = (el.tests ?? []).map(t => `'${t.name}'`);
    return refuse(cmdError('invalid', `${el.id} has no test '${name}'${names.length > 0 ? ` (tests: ${names.join(', ')})` : ' (it has no test blocks)'}`), info);
  }
  const file = el.source.file;
  const oldText = state.texts.get(file);
  if (oldText === undefined) return refuse(cmdError('invalid', `the file of the element is not a plan file read by this command: ${file}`), info);
  const edited = removeTestText(oldText, el.id, name);
  if (!edited.changed) return refuse(cmdError('invalid', `could not remove test '${name}' of ${el.id} in ${file} (text not editable)`), info);
  const newTexts = withText(state, file, edited.text);
  return {
    ok: true,
    edit: {
      target: info, newTexts, after: parsePlanTexts(state.repoRoot, newTexts), notes: [], needsScan: false, lost: [], linkChecks: [],
      lostTests: [{ parent: el.id, name }],
      post: plan => {
        const left = testsNamed(plan.elements.find(e => e.id === el.id), name);
        return left === had - 1 ? null : `${el.id} should have ${had - 1} test '${name}' after the edit, found ${left}`;
      },
    },
  };
}

// --- wireframe starter (W9, b305) ------------------------------------------------------------------------------

/**
 * `plan wireframe <screen>`: a new io/<screen fqn>.html from starterWireframe, as a create edit through the gate (no .c4
 * change). Refuses a target that is not a screen, a plan without a folder (K1: no io/ for wireframes) and a file that is
 * already there (never overwrites). Without io/site.css the file still lays out (its link is dropped); the note says so.
 */
export function wireframeStarterEdit(state: PlanState, screenFqn: string): EditResult {
  const el = state.plan.elements.find(e => e.id === screenFqn);
  if (el === undefined) return refuse(cmdError('invalid', `no plan element ${screenFqn}`));
  const info = targetInfoOf(el);
  if (el.kind !== 'screen') {
    return refuse(cmdError('invalid', `${el.id} is a ${el.kind}, not a screen: plan wireframe writes io/<screen fqn>.html for screens only`), info);
  }
  if (state.planDir === null) {
    return refuse(cmdError('invalid', 'the plan has no folder (it is the whole repo), so there is no io/ folder for wireframes'), info);
  }
  const ioDir = path.join(state.planDir, 'io');
  const abs = path.join(ioDir, `${el.id}.html`);
  const file = path.relative(state.repoRoot, abs).split(path.sep).join('/');
  if (fs.existsSync(abs)) {
    return refuse(cmdError('invalid', `${file} exists; plan wireframe never overwrites a wireframe`, { hint: 'edit the file, or remove it first' }), info);
  }
  const newText = starterWireframe(state.plan, el.id);
  const notes = fs.existsSync(path.join(ioDir, 'site.css'))
    ? []
    : ['io/site.css does not exist: the file links it, and its classes give no sizes until you write it (check warns wireframe-bad-stylesheet until then)'];
  const ids = (plan: Plan) => plan.elements.map(e => `${e.kind} ${e.id}`).join('\n');
  const before = ids(state.plan);
  return {
    ok: true,
    edit: {
      target: info, newTexts: state.texts, after: state.plan, notes, needsScan: false, lost: [], linkChecks: [],
      wireframes: [{ from: file, to: file, oldText: '', newText, diff: unifiedDiff(file, '', newText), create: true }],
      post: plan => (ids(plan) === before ? null : 'the plan changed while the wireframe was written'),
    },
  };
}
