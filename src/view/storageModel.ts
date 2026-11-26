import type { Plan, PlanElement, ViewEdge, ViewNode, ViewStorage } from '../types';
import { UID_KEY } from '../util/uid';
import { c4ElementId } from '../names';
import { matchFields } from '../storage/fieldDiff';
import { recordsOfStore } from '../storage/matchRecords';
import { parseFk, parseIndex, INDEX_KEY_PREFIX, CHECK_KEY_PREFIX } from '../storage/storageMeta';
import { storageTechOf, storageWord } from '../storage/storageWords';
import type { StorageKind } from '../storage/storageWords';
import { storeHasNoCode } from '../storage/storageState';
import type { StorageState, StoreState } from '../storage/storageState';
import { NO_CONTAINER } from './navModel';

// STOR-5 (b338), A18 / S5 of the phase 20-23 plan: the storage-view tree, shaped like navView ({ root, edges }): root '(storage)' >
// zones (the containers that hold stores) > stores > records > fields (nested fields = children). FK edges go from field to field.
// Built from the plan and the storage state (buildStorageState); pure. No geometry: the browser lays the tree out (STOR-6a).

type CodeRecord = NonNullable<StoreState['model']>['records'][number];
type CodeField = CodeRecord['fields'][number];

/** Root id of the storage-view tree (like '(io)' for the IO view). */
export const STORAGE_ROOT = '(storage)';

const node = (id: string, kind: ViewNode['kind'], name: string, detail: string, children: ViewNode[]): ViewNode => ({
  id, kind, name, detail, weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});

const localId = (el: PlanElement): string => el.id.slice(el.id.lastIndexOf('.') + 1);
/** A plan element is named `name` when its title or local id is it (or the name made safe for an id), as matchRecords / matchFields. */
const named = (el: PlanElement, name: string): boolean => el.title === name || localId(el) === name || localId(el) === c4ElementId(name);

/** uid and plan status of a plan element onto its node, only when set. */
function fromPlan(n: ViewNode, el: PlanElement): void {
  const uid = el.metadata[UID_KEY];
  if (uid !== undefined) n.uid = uid;
  if (el.metadata.status !== undefined) n.meta = { ...n.meta, status: el.metadata.status };
}

/** An FK to resolve once every field node exists: the code's FieldRef, or the plan's `record.field` text. */
type PendingFk = { from: string; store: StoreState; label: string | null } & ({ code: { table: string; column: string } } | { plan: string });

/**
 * The storage-view tree of a plan, or null when the plan has no store (ViewModel.storageView is then left out).
 * `state` = buildStorageState of the same plan (one entry per plan store). Ids: plan elements by fqn; a code-only record
 * `file#name` (K11), a code-only field `file#name.field` (Q6, also under a matched record; nested: `.child` appended).
 * Records: plan records in declaration order, then the code-only ones in reader order. A store the reader could not read shows
 * its plan records as plan-only (the reason is a storage finding). Hits of stores the plan lacks are not drawn.
 */
export function buildStorageView(plan: Plan, state: StorageState): { root: ViewNode; edges: ViewEdge[] } | null {
  const stores = plan.elements.filter((e) => e.kind === 'store');
  if (stores.length === 0) return null;

  // Declaration order (as buildNav): plan.elements is by id, so sort by the file's place in plan.files, then line.
  const fileIndex = new Map(plan.files.map((f, i) => [f, i] as const));
  const fileRank = (el: PlanElement): number => {
    const idx = fileIndex.get(el.source.file);
    if (idx === undefined) throw new Error(`storageModel: ${el.id} is declared in '${el.source.file}', which is not in plan.files`);
    return idx;
  };
  const declared = (els: PlanElement[]): PlanElement[] => [...els].sort((a, b) => fileRank(a) - fileRank(b) || a.source.line - b.source.line);
  const byId = new Map(plan.elements.map((e) => [e.id, e] as const));
  const stateOf = new Map(state.stores.map((s) => [s.element.id, s] as const));
  const fieldsUnder = (parent: string): PlanElement[] => plan.elements.filter((e) => e.kind === 'field' && e.parent === parent);

  const pending: PendingFk[] = [];
  /** Code field -> the id of the node that shows it (FK targets from the code; a matched field's id is its plan fqn). */
  const codeFieldId = new Map<CodeField, string>();

  const fieldNode = (id: string, name: string, origin: ViewStorage['origin'], word: string, st: StoreState, el: PlanElement | null, code: CodeField | null, children: ViewNode[]): ViewNode => {
    const n = node(id, 'field', name, '', children);
    n.word = word;
    const storage: ViewStorage = { origin };
    const meta = el?.metadata ?? {};
    const type = code ? code.type : meta.type;
    const flag = (codeValue: boolean | undefined, planValue: string | undefined): boolean => (code ? codeValue === true : planValue === 'true');
    if (flag(code?.pk, meta.pk)) storage.pk = true;
    if (flag(code?.nullable, meta.nullable)) storage.nullable = true;
    if (flag(code?.unique, meta.unique)) storage.unique = true;
    if (code?.fk) {
      storage.fk = `${code.fk.table}.${code.fk.column}`;
      if (code.fk.onDelete !== null) storage.onDelete = code.fk.onDelete;
      pending.push({ from: id, store: st, label: code.fk.onDelete, code: code.fk });
    } else if (meta.fk !== undefined) {
      storage.fk = meta.fk;
      if (meta.onDelete !== undefined) storage.onDelete = meta.onDelete;
      pending.push({ from: id, store: st, label: meta.onDelete ?? null, plan: meta.fk });
    }
    n.storage = storage;
    if (origin === 'plan') n.planOnly = true;   // STOR-5w (b609): in the plan, not in the code (board link state, as arch ghosts)
    if (el) fromPlan(n, el);
    if (type !== undefined) n.meta = { ...n.meta, type };
    if (code) codeFieldId.set(code, id);
    return n;
  };

  // Nested fields: the plan's child fields when it lists any, else the code's children; no nested matching.
  const planField = (el: PlanElement, word: string, st: StoreState): ViewNode =>
    fieldNode(el.id, el.title, 'plan', word, st, el, null, declared(fieldsUnder(el.id)).map((c) => planField(c, word, st)));
  const codeField = (base: string, f: CodeField, word: string, st: StoreState): ViewNode => {
    const id = `${base}.${f.name}`;
    return fieldNode(id, f.name, 'code', word, st, null, f, (f.children ?? []).map((c) => codeField(id, c, word, st)));
  };
  const pairField = (el: PlanElement, f: CodeField, base: string, word: string, st: StoreState): ViewNode => {
    const planChildren = declared(fieldsUnder(el.id));
    const children = planChildren.length > 0
      ? planChildren.map((c) => planField(c, word, st))
      : (f.children ?? []).map((c) => codeField(`${base}.${f.name}`, c, word, st));
    return fieldNode(el.id, el.title, 'both', word, st, el, f, children);
  };

  const diffOf = (st: StoreState, record: string, field: string, kinds: (k: string) => boolean): NonNullable<ViewStorage['diff']> =>
    st.fieldDiffs.filter((d) => d.record === record && d.field === field && kinds(d.kind)).map((d) => d.kind);
  const setDiff = (n: ViewNode, diff: NonNullable<ViewStorage['diff']>): void => { if (diff.length > 0) n.storage!.diff = diff; };

  const codeIndexes = (r: CodeRecord): Pick<ViewStorage, 'indexes' | 'checks'> => ({
    ...(r.indexes.length > 0 ? { indexes: r.indexes.map((ix) => ({ name: ix.name, unique: ix.unique, columns: [...ix.columns], where: ix.where })) } : {}),
    ...(r.checks.length > 0 ? { checks: r.checks.map((c) => ({ name: c.name, expr: c.expr })) } : {}),
  });
  const planIndexes = (el: PlanElement): Pick<ViewStorage, 'indexes' | 'checks'> => {
    const keys = Object.keys(el.metadata);
    const indexes = keys.filter((k) => k.startsWith(INDEX_KEY_PREFIX)).flatMap((k) => {
      const spec = parseIndex(el.metadata[k]);
      return spec ? [{ name: k.slice(INDEX_KEY_PREFIX.length), ...spec }] : [];
    });
    const checks = keys.filter((k) => k.startsWith(CHECK_KEY_PREFIX)).map((k) => ({ name: k.slice(CHECK_KEY_PREFIX.length), expr: el.metadata[k] }));
    return { ...(indexes.length > 0 ? { indexes } : {}), ...(checks.length > 0 ? { checks } : {}) };
  };
  const withCode = (n: ViewNode, r: CodeRecord): ViewNode => {
    n.file = r.file;
    n.line = r.line;
    n.endLine = r.endLine;
    return n;
  };

  const storeNode = (el: PlanElement): ViewNode => {
    const st = stateOf.get(el.id);
    if (!st) throw new Error(`storageModel: store ${el.id} has no entry in the storage state`);
    const tech = el.technology;
    const recordWord = storageWord(tech, 'record');
    const word = (k: StorageKind): string => storageWord(tech, k);
    const matchedBy = new Map((st.matching?.matched ?? []).map((m) => [m.element, m.code] as const));

    const planRecords = declared(recordsOfStore(plan, el)).map((rec): ViewNode => {
      const code = matchedBy.get(rec);
      // Same plan-field order as buildStorageState gives fieldDiff, so the map and the rules pair the same fields.
      const planFields = fieldsUnder(rec.id);
      let fields: ViewNode[];
      let n: ViewNode;
      if (!code) {
        fields = declared(planFields).map((f) => planField(f, word('field'), st));
        n = node(rec.id, 'record', rec.title, '', fields);
        n.storage = { origin: 'plan', ...planIndexes(rec) };
        n.planOnly = true;
      } else {
        const base = `${code.file}#${code.name}`;
        const m = matchFields(planFields, code.fields);
        const pairOf = new Map(m.pairs.map((p) => [p.plan, p.code] as const));
        const planned = declared(planFields).map((f) => {
          const c = pairOf.get(f);
          const fn = c ? pairField(f, c, base, word('field'), st) : planField(f, word('field'), st);
          setDiff(fn, c ? diffOf(st, code.name, c.name, (k) => k !== 'extra' && k !== 'missing') : diffOf(st, code.name, f.title, (k) => k === 'extra'));
          return fn;
        });
        const codeOnly = m.codeOnly.map((f) => {
          const fn = codeField(base, f, word('field'), st);
          setDiff(fn, diffOf(st, code.name, f.name, (k) => k === 'missing'));
          return fn;
        });
        fields = [...planned, ...codeOnly];
        n = withCode(node(rec.id, 'record', rec.title, '', fields), code);
        n.storage = { origin: 'both', ...codeIndexes(code) };
      }
      n.word = recordWord;
      fromPlan(n, rec);
      return n;
    });
    const codeRecords = (st.matching?.unplanned ?? []).map((r): ViewNode => {
      const base = `${r.file}#${r.name}`;
      const n = withCode(node(base, 'record', r.name, '', r.fields.map((f) => codeField(base, f, word('field'), st))), r);
      n.word = recordWord;
      n.storage = { origin: 'code', ...codeIndexes(r) };
      return n;
    });

    const s = node(el.id, 'store', el.title, tech ?? '', [...planRecords, ...codeRecords]);
    s.word = word('store');
    const key = storageTechOf(tech);
    s.storage = { origin: 'plan', ...(key !== null ? { tech: key } : {}) };
    if (storeHasNoCode(st)) s.planOnly = true;   // b611: no code (checkStorage's missing-store), so a board link shows plan-only
    fromPlan(s, el);
    return s;
  };

  // Zones: the nearest container above each store, in the container's declaration order; '(no container)' last (as buildNav).
  const containerOf = (el: PlanElement): PlanElement | null => {
    let cur = el.parent === null ? undefined : byId.get(el.parent);
    while (cur) {
      if (cur.kind === 'container') return cur;
      cur = cur.parent === null ? undefined : byId.get(cur.parent);
    }
    return null;
  };
  const zoneStores = new Map<PlanElement | null, PlanElement[]>();
  for (const st of declared(stores)) {
    const c = containerOf(st);
    const list = zoneStores.get(c);
    if (list) list.push(st);
    else zoneStores.set(c, [st]);
  }
  const containers = declared([...zoneStores.keys()].filter((c): c is PlanElement => c !== null));
  const zones = containers.map((c) => node(c.id, 'container', c.title, c.technology ?? '', zoneStores.get(c)!.map(storeNode)));
  const homeless = zoneStores.get(null);
  if (homeless) zones.push(node(NO_CONTAINER, 'container', NO_CONTAINER, '', homeless.map(storeNode)));
  const root = node(STORAGE_ROOT, 'system', 'Storage view', '', zones);

  // FK edges: code FieldRef -> the record of the same store whose code name is `table` -> its field `column`;
  // plan `record.field` -> the plan record of the same store by title or local id -> its field. Unresolved: no edge.
  const edges: ViewEdge[] = [];
  for (const fk of pending) {
    let to: string | undefined;
    if ('code' in fk) {
      const target = fk.store.model?.records.find((r) => r.name === fk.code.table);
      const field = target?.fields.find((f) => f.name === fk.code.column);
      to = field ? codeFieldId.get(field) : undefined;
    } else {
      const ref = parseFk(fk.plan);
      const rec = ref ? recordsOfStore(plan, fk.store.element).find((r) => named(r, ref.record)) : undefined;
      to = ref && rec ? fieldsUnder(rec.id).find((f) => named(f, ref.field))?.id : undefined;
    }
    if (to !== undefined) edges.push({ from: fk.from, to, weight: 1, ...(fk.label !== null ? { label: fk.label } : {}) });
  }
  return { root, edges };
}
