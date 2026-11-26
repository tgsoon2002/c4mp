import type { Plan, PlanElement, PlanFinding, Severity } from '../types';
import { storeCovers } from '../schema/storeScan';
import type { Field } from '../schema/types';
import { matchFields } from './fieldDiff';
import type { FieldDiff } from './fieldDiff';
import { storeHasNoCode } from './storageState';
import type { StorageState, StoreState } from './storageState';

// STOR-3 (b335), Q2-Q4, Q10, K10 of the phase 20/23 plan: the storage rules. Pure: they read the plan and the storage state
// (readStorage, src/storage/storageState.ts) and nothing else. Called by collectFindings only, never by checkPlan, so the
// safe-edit gate never sees them (T3). `plan unplanned --view storage` is the unplanned-* part of the same findings.

/** K10, Q3: severity of a finding on a storage element, by the element's status. No status (or an unknown one) is a warning. */
const SEVERITY_BY_STATUS: Record<string, Severity> = { planned: 'info', 'in-progress': 'warning', done: 'critical' };
const statusOf = (el: PlanElement): string | undefined => el.metadata.status;
const severityOf = (el: PlanElement): Severity => SEVERITY_BY_STATUS[statusOf(el) ?? ''] ?? 'warning';
const abandoned = (el: PlanElement): boolean => statusOf(el) === 'abandoned';

const fieldsOf = (plan: Plan, record: PlanElement): PlanElement[] =>
  plan.elements.filter((e) => e.kind === 'field' && e.parent === record.id);

/**
 * The plan field each FieldDiff of a matched record is about, from the one field match fieldDiff uses (matchFields, S4).
 * Keys `extra:<plan title>` (the plan-only fields) and `pair:<code field>`; a key holds its plan fields in plan order
 * (two plan fields of one title are two extras).
 */
function planFieldsOfDiffs(planFields: PlanElement[], codeFields: Field[]): Map<string, PlanElement[]> {
  const byKey = new Map<string, PlanElement[]>();
  const add = (key: string, el: PlanElement): void => { byKey.set(key, [...(byKey.get(key) ?? []), el]); };
  const m = matchFields(planFields, codeFields);
  for (const el of m.planOnly) add(`extra:${el.title}`, el);
  for (const p of m.pairs) add(`pair:${p.code.name}`, p.plan);
  return byKey;
}

/** The field-drift message: the kind and the plan and code values. */
function driftMessage(d: FieldDiff): string {
  const at = `${d.record}.${d.field}`;
  switch (d.kind) {
    case 'missing': return `${at}: missing in the plan (the code has it, type '${d.code ?? ''}')`;
    case 'extra': return `${at}: extra in the plan, the code has no such field`;
    case 'type': return `${at}: type '${d.plan}' in the plan, '${d.code}' in the code`;
    case 'nullable': return `${at}: nullable '${d.plan}' in the plan, '${d.code}' in the code`;
    case 'fk': return `${at}: fk '${d.plan}' in the plan, ${d.code !== undefined ? `'${d.code}'` : 'none'} in the code`;
  }
}

/** The findings of one plan store, in rule order (missing-store, store-unreadable, missing-record, planned-but-built, field-drift, unplanned-record). */
function storeFindings(plan: Plan, s: StoreState): PlanFinding[] {
  const out: PlanFinding[] = [];
  const store = s.element;
  if (!abandoned(store)) {
    if (storeHasNoCode(s)) {
      out.push({ severity: severityOf(store), rule: 'missing-store', id: store.id, message: s.reason ?? `store ${store.id} has no code files` });
    }
    if (s.error !== undefined) out.push({ severity: 'warning', rule: 'store-unreadable', id: store.id, message: s.error });
    if (s.matching) {
      for (const el of s.matching.missing) {
        if (abandoned(el)) continue;
        out.push({ severity: severityOf(el), rule: 'missing-record', id: el.id, message: `record '${el.title}' is not in the code of store ${store.id} (reader ${s.reader})` });
      }
      for (const m of s.matching.matched) {
        if (statusOf(m.element) !== 'planned') continue;
        out.push({ severity: 'info', rule: 'planned-but-built', id: m.element.id, message: `${m.element.title} is planned but code exists: ${m.code.file}:${m.code.line}; update the status?` });
      }
      for (const m of s.matching.matched) {
        if (abandoned(m.element)) continue;
        const planFields = fieldsOf(plan, m.element);
        const planFieldOf = planFieldsOfDiffs(planFields, m.code.fields);
        for (const d of s.fieldDiffs) {
          if (d.record !== m.code.name) continue;
          if (d.kind === 'missing') {
            // Q10: a record with no planned field is checked by name only.
            if (planFields.length === 0) continue;
            out.push({ severity: severityOf(m.element), rule: 'field-drift', id: m.element.id, message: driftMessage(d) });
            continue;
          }
          // an extra takes the next plan field of its title; type, nullable and fk share the one plan field of their pair
          const field = d.kind === 'extra' ? planFieldOf.get(`extra:${d.field}`)?.shift() : planFieldOf.get(`pair:${d.field}`)?.[0];
          if (!field) throw new Error(`checkStorage: no plan field of ${m.element.id} for the ${d.kind} difference of ${d.field}`);
          if (abandoned(field)) continue;
          const severity = statusOf(field) !== undefined ? severityOf(field) : severityOf(m.element);
          out.push({ severity, rule: 'field-drift', id: field.id, message: driftMessage(d) });
        }
      }
    }
  }
  // unplanned-record is about the code record, not the store: info whatever the store's status (Q4).
  for (const rec of s.matching?.unplanned ?? []) {
    out.push({ severity: 'info', rule: 'unplanned-record', id: `${rec.file}#${rec.name}`, message: `record '${rec.name}' (line ${rec.line}) is not under store ${store.id}` });
  }
  return out;
}

/**
 * The storage rules over a storage state. Per plan store in plan order its findings (storeFindings), then
 * unplanned-store (reader hits no store covers), then store-unreadable `store-scan` when the repo scan failed.
 * An abandoned store, record or field gets no finding; what is under an abandoned store or record neither.
 */
export function checkStorage(plan: Plan, state: StorageState): PlanFinding[] {
  const out = state.stores.flatMap((s) => storeFindings(plan, s));
  for (const hit of state.hits) {
    if (state.stores.some((s) => storeCovers(s, hit))) continue;
    out.push({ severity: 'info', rule: 'unplanned-store', id: hit.source ?? hit.reader, message: `${hit.reader} finds ${hit.model.records.length} records in ${hit.files.length} files, no store covers them` });
  }
  if (state.hitsError !== undefined) out.push({ severity: 'warning', rule: 'store-unreadable', id: 'store-scan', message: state.hitsError });
  return out;
}
