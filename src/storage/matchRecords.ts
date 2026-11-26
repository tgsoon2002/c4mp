import type { Plan, PlanElement } from '../types';
import { c4ElementId } from '../names';
import type { RecordType, SchemaModel } from '../schema/types';

// b273 (D6): the one place a plan record is matched to a record the reader found in the code. `plan unplanned
// --view storage` uses it now; the D4 drift check reuses it, so both agree on what "the same record" means.

export interface RecordMatch {
  element: PlanElement;
  code: RecordType;
  /** link = the plan record's own `link file#name` named the code record; name = title or local id equals the code name. */
  by: 'link' | 'name';
}

export interface RecordMatching {
  matched: RecordMatch[];
  /** Records in the code that no plan record matches, in reader order. */
  unplanned: RecordType[];
  /** Plan records that match nothing in the code, in the order given. */
  missing: PlanElement[];
}

/** The record elements directly under a store, in plan order. */
export const recordsOfStore = (plan: Plan, store: PlanElement): PlanElement[] =>
  plan.elements.filter((e) => e.kind === 'record' && e.parent === store.id);

const localId = (el: PlanElement): string => el.id.slice(el.id.lastIndexOf('.') + 1);

/**
 * Match plan records to the model's records. Pure. Each code record is used at most once.
 * Pass 1 (a link wins): a plan record with a link whose path is the code record's file and whose #name is the
 * record's SQL name or its constant name. Pass 2 (name): the plan record's title or local id is the record's name
 * (or the name made safe for an id, c4ElementId). The first plan record in the given order takes a contested code record.
 */
export function matchRecords(records: PlanElement[], model: SchemaModel): RecordMatching {
  const taken = new Set<RecordType>();
  const matchedBy = new Map<PlanElement, RecordMatch>();

  for (const el of records) {
    for (const link of el.links) {
      if (link.name === null) continue;
      const code = model.records.find((r) => !taken.has(r) && r.file === link.path && (r.name === link.name || r.key === link.name));
      if (code) {
        taken.add(code);
        matchedBy.set(el, { element: el, code, by: 'link' });
        break;
      }
    }
  }
  for (const el of records) {
    if (matchedBy.has(el)) continue;
    const id = localId(el);
    const code = model.records.find((r) => !taken.has(r) && (el.title === r.name || id === r.name || id === c4ElementId(r.name)));
    if (code) {
      taken.add(code);
      matchedBy.set(el, { element: el, code, by: 'name' });
    }
  }

  return {
    matched: records.flatMap((el) => matchedBy.get(el) ?? []),
    unplanned: model.records.filter((r) => !taken.has(r)),
    missing: records.filter((el) => !matchedBy.has(el)),
  };
}
