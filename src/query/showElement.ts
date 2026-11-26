import type { Plan, PlanElement, ViewNode, ViewOrigin } from '../types';
import type { LookupItem } from '../util/lookup';
import { isElementKind, isStorageKind } from '../plan/kinds';
import { storageTechOf, storageWord } from '../storage/storageWords';
import type { StorageKind } from '../storage/storageWords';
import type { StoreState } from '../storage/storageState';
import type { RecordShow } from './storage';
import { nodesBelow } from '../view/tree';

/** b275: what the reader found behind a store, for `plan show <store>` (text and --json). */
export interface StoreCode { reader: string | null; records: number; reason?: string; error?: string }

/**
 * b275, STOR-4 (b336): what a store's entry in the storage state (storageOf) says. A read failure is `error` with reader null
 * (as b275 printed it), shown beside the rest of the output, never dropped; a store without a model gives its reason (STOR-3).
 */
export function storeCodeOf(s: StoreState): StoreCode {
  if (s.error !== undefined) return { reader: null, records: 0, error: s.error };
  if (!s.model) return { reader: s.reader, records: 0, ...(s.reason !== undefined ? { reason: s.reason } : {}) };
  return { reader: s.reader, records: s.model.records.length };
}

const codeText = (c: StoreCode): string =>
  c.error !== undefined ? `error: ${c.error}`
    : c.reason !== undefined ? c.reason
      : `reader ${c.reader}, ${c.records} records`;

/** STOR-4 (b336): the code line of a record, `file:line-endLine (by link|name)`. */
const recordText = (r: RecordShow): string =>
  `${r.endLine === r.line ? `${r.file}:${r.line}` : `${r.file}:${r.line}-${r.endLine}`} (by ${r.by})`;

/** STOR-4 (b336): one indented row per code field: name, type, then pk, null, fk table.column and on delete when set. */
function fieldRows(r: RecordShow, indent: string): string[] {
  const nameW = Math.max(0, ...r.fields.map((f) => f.name.length));
  const typeW = Math.max(0, ...r.fields.map((f) => f.type.length));
  return r.fields.map((f) => {
    const cols = [f.name.padEnd(nameW), f.type.padEnd(typeW)];
    if (f.pk) cols.push('pk');
    if (f.nullable) cols.push('null');
    if (f.fk !== null) cols.push(`fk ${f.fk}`);
    if (f.onDelete !== null) cols.push(`on delete ${f.onDelete}`);
    return (indent + cols.join('  ')).trimEnd();
  });
}

export interface CollectedElement {
  item: LookupItem;
  node: ViewNode;
  parentId: string | null;   // id of the nearest element ancestor (system/container/subregion/component; isElementKind); a component in a subregion: the subregion
}

/**
 * Walk the tree and keep the element nodes (system/container/subregion/component; isElementKind) as lookup items. A
 * container's subregions (nodesBelow) are items too, and a component in a subregion (ViewNode.subregion) has that subregion
 * as its parent, so a walk up the parents passes the subregion as in the plan (container.subregion.component).
 */
export function collectItems(root: ViewNode): CollectedElement[] {
  const out: CollectedElement[] = [];
  const walk = (node: ViewNode, parentId: string | null): void => {
    const isElement = isElementKind(node.kind);
    if (isElement) {
      out.push({ item: { uid: node.uid, id: node.id, ...(node.planId !== undefined ? { fqn: node.planId } : {}), title: node.name, level: node.kind }, node, parentId });
    }
    for (const c of nodesBelow(node)) walk(c, c.subregion ?? (isElement ? node.id : parentId));
  };
  walk(root, null);
  return out;
}

function planChildren(el: PlanElement, plan: Plan): number {
  return plan.elements.filter((c) => c.parent === el.id && isElementKind(c.kind)).length;
}

function sourceText(el: PlanElement): string {
  const s = el.source;
  return s.endLine === undefined || s.endLine === s.line ? `${s.file}:${s.line}` : `${s.file}:${s.line}-${s.endLine}`;
}

/** b210: technology of the nearest store at or above `el` (a cycle in a broken plan stops the walk). */
function storeTechOf(el: PlanElement, plan: Plan): string | null {
  const seen = new Set<string>();
  for (let cur: PlanElement | undefined = el; cur && !seen.has(cur.id); cur = plan.elements.find((e) => e.id === cur!.parent)) {
    if (cur.kind === 'store') return cur.technology;
    seen.add(cur.id);
  }
  return null;
}

/** b210: the everyday word of a storage element (table, column, ...), null for other kinds or an unknown technology. */
function storageAsWord(el: PlanElement, plan: Plan): string | null {
  if (!isStorageKind(el.kind)) return null;
  const tech = storeTechOf(el, plan);
  return storageTechOf(tech) === null ? null : storageWord(tech, el.kind as StorageKind);
}

/**
 * Text block for one plan element. A line is omitted when its value is absent. `node` = matching view node (claim mode), optional.
 * `record` (STOR-4): the code record of a plan record, as a code line and one row per field.
 */
export function formatPlanElement(el: PlanElement, plan: Plan, node?: ViewNode, code?: StoreCode, record?: RecordShow): string {
  const row = (label: string, value: string): string => `${(label + ':').padEnd(11)}${value}`;
  const lines = [`${el.kind}  ${el.title}`];
  lines.push(row('uid', el.metadata.uid ?? '(none: run c4mp plan ids)'));
  lines.push(row('fqn', el.id));
  if (el.parent) lines.push(row('parent', el.parent));
  const as = storageAsWord(el, plan);
  if (as !== null) lines.push(row('as', as));
  if (code) lines.push(row('code', codeText(code)));
  if (record) lines.push(row('code', recordText(record)), ...fieldRows(record, ' '.repeat(11)));
  const n = planChildren(el, plan);
  if (n > 0) lines.push(row('children', String(n)));
  lines.push(row('source', sourceText(el)));
  if (el.links.length > 0) lines.push(row('links', el.links.map((l) => l.raw).join(', ')));
  if (el.metadata.status) lines.push(row('status', el.metadata.status));
  if (el.metadata.owner) lines.push(row('owner', el.metadata.owner));
  if (node?.origin) lines.push(row('origin', originText(node.origin)));
  if (node?.claims && node.claims.length > 0) lines.push(row('claims', node.claims.map(claimText).join(', ')));
  return lines.join('\n');
}

/** The `--json` object of one plan element (`plan show <target> --json`; query/planShow.ts adds `tests`). `record` only when given (STOR-4). */
export function planElementJson(el: PlanElement, plan: Plan, node?: ViewNode, code?: StoreCode, record?: RecordShow): object {
  return {
    kind: el.kind,
    name: el.title,
    uid: el.metadata.uid,
    id: el.id,
    fqn: el.id,
    parent: el.parent,
    ...(storageAsWord(el, plan) !== null ? { as: storageAsWord(el, plan) } : {}),
    children: planChildren(el, plan),
    ...(code ? { code } : {}),
    ...(record ? { record } : {}),
    source: el.source,
    plan: { file: el.source.file, startLine: el.source.line, endLine: el.source.endLine },
    links: el.links.map((l) => l.raw),
    meta: el.metadata,
    origin: node?.origin,
    claims: node?.claims,
  };
}

function originText(o: ViewOrigin): string {
  const parts: string[] = [];
  if (o.folder) parts.push(`folder ${o.folder}`);
  if (o.planFile) {
    const range = o.planLine === undefined ? '' : o.planEndLine === undefined || o.planEndLine === o.planLine ? `:${o.planLine}` : `:${o.planLine}-${o.planEndLine}`;
    parts.push(`plan ${o.planFile}${range}`);
  }
  return parts.length > 0 ? `${o.kind} (${parts.join(', ')})` : o.kind;
}

function claimText(c: NonNullable<ViewNode['claims']>[number]): string {
  return c.fn ? `${c.kind} ${c.path}#${c.fn}` : `${c.kind} ${c.path}`;
}
