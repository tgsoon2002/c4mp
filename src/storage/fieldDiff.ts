import type { PlanElement } from '../types';
import { c4ElementId } from '../names';
import { parseFk } from './storageMeta';
import type { Field } from '../schema/types';
import { sqlTypesEqual } from '../schema/sqlTypes';

// STOR-2 (b334): the fields a plan record lists against the fields the code record has. Pure. Used through
// buildStorageState (src/storage/storageState.ts) for every matched record. STOR-5 (b338): matchFields is the one field match,
// also used by the storage view (src/view/storageModel.ts).

/**
 * missing = the code has the field, the plan record does not list it; extra = the plan lists it, the code has none of that name;
 * type / nullable / fk = both have it and the stated values differ.
 */
export type FieldDiffKind = 'missing' | 'extra' | 'type' | 'nullable' | 'fk';

export interface FieldDiff {
  /** Name of the code record the plan record matched. */
  record: string;
  field: string;
  kind: FieldDiffKind;
  /** Value in the plan ('true'/'false' for nullable, 'record.field' for fk); absent for missing. */
  plan?: string;
  /** Value in the code; absent for extra. */
  code?: string;
}

/** STOR-5 (b338): the plan fields of a record against its code fields (matchFields). */
export interface FieldMatching {
  /** Matched fields, in plan order. */
  pairs: { plan: PlanElement; code: Field }[];
  /** Plan fields no code field matches, in plan order. */
  planOnly: PlanElement[];
  /** Code fields no plan field matches, in code order. */
  codeOnly: Field[];
}

const localId = (el: PlanElement): string => el.id.slice(el.id.lastIndexOf('.') + 1);
const codeFk = (f: Field): string | undefined => (f.fk ? `${f.fk.table}.${f.fk.column}` : undefined);

/**
 * STOR-5 (b338): the one field match of a record, shared by fieldDiff (rules) and buildStorageView (map). Pure. In plan order,
 * a plan field takes the first unused code field whose name is its title or local id (or the name made safe for an id,
 * c4ElementId). Each code field is used at most once. Only the given level is matched (no nested matching).
 */
export function matchFields(planFields: PlanElement[], codeFields: Field[]): FieldMatching {
  const pairs: FieldMatching['pairs'] = [];
  const planOnly: PlanElement[] = [];
  const seen = new Set<Field>();
  for (const el of planFields) {
    const id = localId(el);
    const code = codeFields.find((f) => !seen.has(f) && (el.title === f.name || id === f.name || id === c4ElementId(f.name)));
    if (!code) {
      planOnly.push(el);
      continue;
    }
    seen.add(code);
    pairs.push({ plan: el, code });
  }
  return { pairs, planOnly, codeOnly: codeFields.filter((f) => !seen.has(f)) };
}

/**
 * Compare. Fields are matched by matchFields. A value the plan does not state (no `type`, `nullable` or `fk` metadata) is not
 * compared. Only top-level fields are compared; nested fields of a document record are left out. `sameType` decides when two
 * type texts agree (default: SQL).
 * Result order: the plan's order for what it lists (type, nullable, fk per field), then `missing` in code order.
 */
export function fieldDiff(record: string, planFields: PlanElement[], codeFields: Field[], sameType: (a: string, b: string) => boolean = sqlTypesEqual): FieldDiff[] {
  const out: FieldDiff[] = [];
  const matching = matchFields(planFields, codeFields);
  const codeOf = new Map(matching.pairs.map((p) => [p.plan, p.code] as const));
  for (const el of planFields) {
    const code = codeOf.get(el);
    if (!code) {
      out.push({ record, field: el.title, kind: 'extra', plan: el.metadata.type });
      continue;
    }
    const type = el.metadata.type;
    if (type !== undefined && !sameType(type, code.type)) out.push({ record, field: code.name, kind: 'type', plan: type, code: code.type });
    const nullable = el.metadata.nullable;
    if (nullable !== undefined && (nullable === 'true') !== code.nullable) out.push({ record, field: code.name, kind: 'nullable', plan: nullable, code: String(code.nullable) });
    const fk = el.metadata.fk;
    if (fk !== undefined) {
      const parsed = parseFk(fk);
      const planFk = parsed ? `${parsed.record}.${parsed.field}` : fk;
      if (planFk !== codeFk(code)) out.push({ record, field: code.name, kind: 'fk', plan: fk, ...(codeFk(code) !== undefined ? { code: codeFk(code) } : {}) });
    }
  }
  for (const f of matching.codeOnly) out.push({ record, field: f.name, kind: 'missing', code: f.type });
  return out;
}
