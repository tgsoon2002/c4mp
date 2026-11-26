import type { Plan, PlanElement } from '../types';
import type { Field, RecordType } from '../schema/types';
import { addElementText } from './editAdd';
import type { AddElementSpec } from './editAdd';
import { c4ElementId } from '../names';
import { UID_KEY, newUid } from '../util/uid';
import { containerOf } from '../plan/layers';
import { claimMatches, extractClaims, SPECIFICITY } from './ownership';
import { checkKey, formatFk, formatIndex, indexKey } from '../storage/storageMeta';

// b273 (D6): `plan generate --view storage`. Pure helpers: which container gets a store (by who owns the reader's
// files) and the .c4 text of a store with its records and fields. The CLI (src/cli/generateView.ts) does the I/O.

export interface StoreOwner {
  container: PlanElement;
  component: PlanElement;
  /** How many of the files this component owns. */
  owned: number;
}

/**
 * The container to put a store in: the container of the component that owns the most of `files` (claims from
 * extractClaims/claimMatches; a function claim counts for its whole file). Per file the most specific claim wins, a tie
 * goes to the component first in the plan. Components tie on file count -> the one with the more specific claim,
 * then the first in the plan. Null when no component owns any file (or its parent is not in the plan).
 */
export function ownerContainer(plan: Plan, files: string[]): StoreOwner | null {
  const claims = extractClaims(plan);
  const order = new Map<string, number>();
  claims.forEach((c) => { if (!order.has(c.elementId)) order.set(c.elementId, order.size); });

  const stats = new Map<string, { owned: number; best: number }>();
  for (const file of files) {
    let winner: { id: string; spec: number } | null = null;
    for (const c of claims) {
      if (!claimMatches(c, file, c.fn ?? '')) continue;
      const spec = SPECIFICITY[c.kind];
      if (!winner || spec > winner.spec || (spec === winner.spec && order.get(c.elementId)! < order.get(winner.id)!)) winner = { id: c.elementId, spec };
    }
    if (!winner) continue;
    const s = stats.get(winner.id) ?? { owned: 0, best: 0 };
    stats.set(winner.id, { owned: s.owned + 1, best: Math.max(s.best, winner.spec) });
  }

  const ranked = [...stats.entries()].sort(([a, x], [b, y]) => y.owned - x.owned || y.best - x.best || order.get(a)! - order.get(b)!);
  for (const [id, s] of ranked) {
    const component = plan.elements.find((e) => e.id === id);
    const containerFqn = component ? containerOf(plan, component) : null;   // a layered component: its layer is skipped
    const container = plan.elements.find((e) => e.id === containerFqn && e.kind === 'container');
    if (component && container) return { container, component, owned: s.owned };
  }
  return null;
}

const bool = (v: boolean): string => (v ? 'true' : 'false');

/** Metadata of a field: type, pk, nullable, unique, default, values, fk, onDelete (src/storage/storageMeta.ts FIELD_META_KEYS). */
export function fieldMeta(f: Field): [string, string][] {
  const m: [string, string][] = [['type', f.type]];
  if (f.pk) m.push(['pk', 'true']);
  m.push(['nullable', bool(f.nullable)]);
  if (f.unique) m.push(['unique', 'true']);
  if (f.default !== null) m.push(['default', f.default]);
  if (f.values !== null) m.push(['values', f.values.join(',')]);
  if (f.fk) {
    m.push(['fk', formatFk({ record: f.fk.table, field: f.fk.column })]);
    if (f.fk.onDelete !== null) m.push(['onDelete', f.fk.onDelete]);
  }
  return m;
}

/** Metadata of a record: pk (composite), index.<name>, check.<name> (a check with no readable expression is left out). */
export function recordMeta(r: RecordType): [string, string][] {
  const m: [string, string][] = [];
  if (r.primaryKey.length > 0) m.push(['pk', r.primaryKey.join(',')]);
  for (const ix of r.indexes) m.push([indexKey(ix.name), formatIndex(ix)]);
  for (const ck of r.checks) if (ck.expr !== null) m.push([checkKey(ck.name), ck.expr]);
  return m;
}

/** First free id: `base`, else `base_2`, `base_3`, ... (`used` is updated). */
export function freeId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

export interface NewStore {
  /** Local id under the container. */
  id: string;
  title: string;
  technology: string | undefined;
  reader: string;
  /** Repo-relative file or folder, or null for the repo root (no `source` line). */
  source: string | null;
  records: RecordType[];
}

export interface StoreText { text: string; fqn: string; records: number; fields: number }

/**
 * Add the store, its records and fields under `containerFqn` in `fileText`, one addElementText per element (uid first in
 * each element's metadata). Throws when an insertion does not apply (text too broken to edit) or an element is invalid
 * (e.g. a metadata key that is not a c4 ident); nothing is half-applied because the caller keeps the old text.
 * `at` (W5, b301; from addTargetOf): the store goes into the container's `extend` block number `at.extendIndex` of this
 * text; its records and fields go under the store's fqn as always.
 */
export function addStoreText(fileText: string, containerFqn: string, store: NewStore, at?: { extendIndex: number }): StoreText {
  let text = fileText;
  let fields = 0;
  const add = (parentFqn: string, spec: AddElementSpec, where?: { extendIndex: number }): string => {
    const r = addElementText(text, parentFqn, { ...spec, metadata: [[UID_KEY, newUid()], ...(spec.metadata ?? [])] }, where);
    if (!r.changed) throw new Error(`could not insert ${spec.id} under ${parentFqn} (text not editable)`);
    text = r.text;
    return r.fqn;
  };
  const addFields = (parentFqn: string, list: Field[]): void => {
    const used = new Set<string>();
    for (const f of list) {
      const fqn = add(parentFqn, { id: freeId(c4ElementId(f.name), used), kind: 'field', title: f.name, metadata: fieldMeta(f) });
      fields++;
      if (f.children?.length) addFields(fqn, f.children);
    }
  };

  const storeFqn = add(containerFqn, {
    id: store.id,
    kind: 'store',
    title: store.title,
    ...(store.technology !== undefined ? { technology: store.technology } : {}),
    metadata: [['reader', store.reader], ...(store.source !== null ? [['source', store.source] as [string, string]] : [])],
  }, at);
  const usedRecords = new Set<string>();
  for (const r of store.records) {
    const recFqn = add(storeFqn, { id: freeId(c4ElementId(r.name), usedRecords), kind: 'record', title: r.name, metadata: recordMeta(r) });
    addFields(recFqn, r.fields);
  }
  return { text, fqn: storeFqn, records: store.records.length, fields };
}
