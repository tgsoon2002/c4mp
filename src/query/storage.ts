import type { Plan, PlanElement } from '../types';
import type { RecordType } from '../schema/types';
import { readStorage } from '../storage/storageState';
import type { FieldDiff, StorageState } from '../storage/storageState';
import { matchFields } from '../storage/fieldDiff';
import type { QueryContext } from './context';

// STOR-4 (b336), A15-A17 of the phase 20-23 plan: the storage of a query context, read once, for `plan show <store>`,
// `plan show <record>` (CLI and MCP plan_show). A store read failure is that store's `error` in the state (STOR-3).

/** One field of the code record behind a plan record. `fk` = `table.column`; `plan` = fqn of the plan field matched to it. */
export interface RecordShowField {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: string | null;
  onDelete: string | null;
  plan: string | null;
}

/** The code record a plan record matched: where it is, how it matched, its fields and the field differences. */
export interface RecordShow {
  file: string;
  line: number;
  endLine: number;
  by: 'link' | 'name';
  fields: RecordShowField[];
  diffs: FieldDiff[];
}

const states = new WeakMap<QueryContext, StorageState | null>();

/** The storage state of ctx, read once per context (like getModel). null when there is no plan or the plan has no store. */
export function storageOf(ctx: QueryContext): StorageState | null {
  if (states.has(ctx)) return states.get(ctx) as StorageState | null;
  const plan = ctx.plan;
  const state = plan && plan.elements.some((e) => e.kind === 'store') ? readStorage(plan, ctx.repoRoot, ctx.config) : null;
  states.set(ctx, state);
  return state;
}

/**
 * STOR-4 (b336, K11): every code record of ctx's storage: the plan stores' models, then what the readers find (hits),
 * once per `file#name`, in that order. [] without a plan store (Q11: no records on a repo whose plan has no store).
 */
export function recordsOf(ctx: QueryContext): RecordType[] {
  const state = storageOf(ctx);
  if (!state) return [];
  const seen = new Set<string>();
  const out: RecordType[] = [];
  for (const model of [...state.stores.map((s) => s.model), ...state.hits.map((h) => h.model)]) {
    for (const rec of model?.records ?? []) {
      const id = `${rec.file}#${rec.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(rec);
    }
  }
  return out;
}

/**
 * The code record matched to plan record `el` (the StoreState whose matching pairs it), with its fields; null when no
 * store matched it. `plan` gives the record's plan fields (matchFields pairs them with the code fields).
 */
export function recordShow(state: StorageState, el: PlanElement, plan: Plan): RecordShow | null {
  for (const store of state.stores) {
    const m = store.matching?.matched.find((x) => x.element.id === el.id);
    if (!m) continue;
    const planFields = plan.elements.filter((e) => e.kind === 'field' && e.parent === el.id);
    const planOf = new Map(matchFields(planFields, m.code.fields).pairs.map((p) => [p.code, p.plan.id] as const));
    return {
      file: m.code.file,
      line: m.code.line,
      endLine: m.code.endLine,
      by: m.by,
      fields: m.code.fields.map((f) => ({
        name: f.name,
        type: f.type,
        nullable: f.nullable,
        pk: f.pk,
        fk: f.fk ? `${f.fk.table}.${f.fk.column}` : null,
        onDelete: f.fk ? f.fk.onDelete : null,
        plan: planOf.get(f) ?? null,
      })),
      diffs: store.fieldDiffs.filter((d) => d.record === m.code.name),
    };
  }
  return null;
}
