import * as path from 'path';
import { parsePlanTexts } from '../src/plan/parser';
import { buildStorageState, storeHasNoCode } from '../src/storage/storageState';
import { checkStorage } from '../src/storage/checkStorage';
import { listStoreFiles } from '../src/schema/storeScan';
import { buildStorageView, STORAGE_ROOT } from '../src/view/storageModel';
import type { Plan, ViewNode } from '../src/types';

// STOR-5 (b338): the storage-view tree (zones > stores > records > fields, FK edges field to field) on the reader fixtures.
const FIX = path.join(__dirname, 'fixtures');
const SCAN = { ignore: [], languages: ['typescript'] };

const all = (n: ViewNode, out: ViewNode[] = []): ViewNode[] => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
const byId = (root: ViewNode, id: string): ViewNode => {
  const n = all(root).find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

const planOf = (root: string, store: string, extra = ''): Plan =>
  parsePlanTexts(root, new Map([['a.c4', `model {\n  app = system 'App' {\n${extra}    api = container 'Api' {\n      technology 'Node.js'\n${store}\n    }\n  }\n}\n`]]));
const viewOf = (root: string, plan: Plan) => buildStorageView(plan, buildStorageState(plan, { repoRoot: root, files: listStoreFiles(root, SCAN) }));

// `users` matched (one stated type that differs, a nested plan field), `classes` matched, `ghost_table` planned only (a plan FK).
const storeText = (reader: string, source: string, usersExtra: string) => [
  "      db = store 'Main DB' {",
  "        technology 'postgres'",
  `        metadata { reader '${reader}' source '${source}' uid 'u-store' }`,
  "        users = record 'users' {",
  "          metadata { uid 'u-users' status 'in-progress' }",
  "          email = field 'email' { metadata { type 'uuid' } }",
  "          prefs = field 'prefs' {",
  "            theme = field 'theme' { metadata { type 'text' } }",
  '          }',
  usersExtra,
  '        }',
  "        classes = record 'classes'",
  "        ghost = record 'ghost_table' {",
  "          metadata {",
  "            index.by_owner 'unique owner_id'",
  "            check.positive 'n > 0'",
  '          }',
  "          owner_id = field 'owner_id' { metadata { fk 'users.id' onDelete 'cascade' nullable 'true' uid 'u-owner' } }",
  '        }',
  '      }',
].join('\n');

describe('buildStorageView', () => {
  it('a plan without a store gives null', () => {
    const plan = planOf(FIX, "      web = component 'Web'");
    expect(buildStorageView(plan, { stores: [], hits: [] })).toBeNull();
  });

  describe('Drizzle fixture', () => {
    const root = path.join(FIX, 'schema-drizzle');
    const plan = planOf(root, storeText('drizzle', 'db/schema', "          created_by = field 'created_by'"));
    const view = viewOf(root, plan)!;

    it('root > zone (the container) > store, with the store words and tech', () => {
      expect(view.root).toMatchObject({ id: STORAGE_ROOT, kind: 'system', name: 'Storage view' });
      expect(view.root.children.map((z) => [z.id, z.kind, z.name, z.detail])).toEqual([['app.api', 'container', 'Api', 'Node.js']]);
      const store = view.root.children[0].children[0];
      expect(store).toMatchObject({ id: 'app.api.db', kind: 'store', name: 'Main DB', detail: 'postgres', word: 'database', uid: 'u-store', storage: { origin: 'plan', tech: 'postgres' } });
    });

    it('records: matched (both, code place), planned only (plan), code-only (file#name, code), plan order first', () => {
      const records = view.root.children[0].children[0].children;
      expect(records.slice(0, 3).map((r) => [r.id, r.storage!.origin])).toEqual([['app.api.db.users', 'both'], ['app.api.db.classes', 'both'], ['app.api.db.ghost', 'plan']]);
      const users = records[0];
      expect(users).toMatchObject({ kind: 'record', name: 'users', word: 'table', uid: 'u-users', meta: { status: 'in-progress' }, file: 'db/schema/users.ts', line: 18 });
      expect(users.storage!.checks!.map((c) => c.name)).toContain('users_role_check');
      const enrollments = byId(view.root, 'db/schema/enrollment.ts#enrollments');
      expect(enrollments).toMatchObject({ kind: 'record', name: 'enrollments', storage: { origin: 'code' }, file: 'db/schema/enrollment.ts' });
      expect(enrollments.storage!.indexes).toContainEqual({ name: 'enrollments_active_uniq', unique: true, columns: ['class_id', 'student_profile_id'], where: expect.stringContaining('IS NULL') });
      expect(records.slice(3).every((r) => r.storage!.origin === 'code' && r.id.includes('#'))).toBe(true);
      expect(byId(view.root, 'app.api.db.ghost').storage).toEqual({
        origin: 'plan', indexes: [{ name: 'by_owner', unique: true, columns: ['owner_id'], where: null }], checks: [{ name: 'positive', expr: 'n > 0' }],
      });
    });

    it('fields: pairs by plan fqn, code-only fields of a matched record by file#name.field, drift kinds in diff', () => {
      const users = byId(view.root, 'app.api.db.users');
      const ids = users.children.map((f) => f.id);
      expect(ids.slice(0, 3)).toEqual(['app.api.db.users.email', 'app.api.db.users.prefs', 'app.api.db.users.created_by']);
      expect(ids).toContain('db/schema/users.ts#users.id');
      const email = byId(view.root, 'app.api.db.users.email');
      expect(email).toMatchObject({ kind: 'field', word: 'column', meta: { type: 'text' }, storage: { origin: 'both', diff: ['type'] } });
      expect(byId(view.root, 'db/schema/users.ts#users.phone')).toMatchObject({ storage: { origin: 'code', nullable: true, diff: ['missing'] } });
      expect(byId(view.root, 'app.api.db.users.prefs').storage).toMatchObject({ origin: 'plan', diff: ['extra'] });
      // nested plan fields are the children of their field
      expect(byId(view.root, 'app.api.db.users.prefs').children.map((c) => [c.id, c.storage!.origin, c.meta?.type])).toEqual([['app.api.db.users.prefs.theme', 'plan', 'text']]);
      const ghostOwner = byId(view.root, 'app.api.db.ghost.owner_id');
      expect(ghostOwner).toMatchObject({ uid: 'u-owner', storage: { origin: 'plan', nullable: true, fk: 'users.id', onDelete: 'cascade' } });
    });

    it('STOR-5w (b609): records and fields only in the plan are planOnly; matched and code-only ones are not', () => {
      const store = view.root.children[0].children[0];
      expect(all(store).filter((n) => n.planOnly).map((n) => n.id)).toEqual([
        'app.api.db.users.prefs', 'app.api.db.users.prefs.theme', 'app.api.db.ghost', 'app.api.db.ghost.owner_id',
      ]);
      // planOnly = origin 'plan', for records and fields (the store keeps its plan origin and is not planOnly)
      for (const n of all(store).slice(1)) expect(n.planOnly === true).toBe(n.storage!.origin === 'plan');
      expect(store.planOnly).toBeUndefined();
    });

    it('FK edges go field to field: a self FK once, a code FK to a matched record, a plan FK; every id is unique', () => {
      const edge = (from: string) => view.edges.filter((e) => e.from === from);
      // users.created_by -> users.id (users.ts:31), a self FK: one edge to the code-only id field of the same record
      expect(edge('app.api.db.users.created_by')).toEqual([{ from: 'app.api.db.users.created_by', to: 'db/schema/users.ts#users.id', weight: 1 }]);
      // enrollments.class_id -> classes.id: classes is matched, so its code-only id field is the target
      expect(edge('db/schema/enrollment.ts#enrollments.class_id')).toEqual([{ from: 'db/schema/enrollment.ts#enrollments.class_id', to: 'db/schema/classes.ts#classes.id', weight: 1 }]);
      // the plan's fk 'users.id' names a field the plan does not list: no edge, the text stays
      expect(edge('app.api.db.ghost.owner_id')).toEqual([]);
      const ids = all(view.root).map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(view.edges.every((e) => ids.includes(e.from) && ids.includes(e.to))).toBe(true);
    });

    it('a plan FK to a field the plan lists is an edge with onDelete as label', () => {
      const p = planOf(root, storeText('drizzle', 'db/schema', "          uid_f = field 'id'"));
      const v = viewOf(root, p)!;
      expect(v.edges.filter((e) => e.from === 'app.api.db.ghost.owner_id')).toEqual([{ from: 'app.api.db.ghost.owner_id', to: 'app.api.db.users.uid_f', weight: 1, label: 'cascade' }]);
      // the code FK of users.created_by now ends on the matched plan field
      expect(v.edges.filter((e) => e.from === 'db/schema/users.ts#users.created_by').map((e) => e.to)).toEqual(['app.api.db.users.uid_f']);
    });
  });

  it('a store that cannot be read shows its plan records as plan-only', () => {
    const plan = planOf(path.join(FIX, 'schema-drizzle'), storeText('nope', 'x', ''));
    const view = viewOf(path.join(FIX, 'schema-drizzle'), plan)!;
    const records = view.root.children[0].children[0].children;
    expect(records.map((r) => [r.id, r.storage!.origin])).toEqual([['app.api.db.users', 'plan'], ['app.api.db.classes', 'plan'], ['app.api.db.ghost', 'plan']]);
    expect(records[0].file).toBeUndefined();
    expect(all(view.root.children[0].children[0]).slice(1).every((n) => n.planOnly === true)).toBe(true);   // STOR-5w (b609)
    // b611: an unreadable store (error) is not "no code", so the store itself is not planOnly
    expect(view.root.children[0].children[0].planOnly).toBeUndefined();
  });

  it('b611: a store with no code (missing-store) is planOnly, as its records and fields', () => {
    const root = path.join(FIX, 'schema-drizzle');
    const plan = planOf(root, storeText('drizzle', 'no/such/dir', ''));
    const state = buildStorageState(plan, { repoRoot: root, files: listStoreFiles(root, SCAN) });
    expect(storeHasNoCode(state.stores[0])).toBe(true);
    expect(checkStorage(plan, state).map((f) => f.rule)).toContain('missing-store');
    const store = buildStorageView(plan, state)!.root.children[0].children[0];
    expect(all(store).every((n) => n.planOnly === true)).toBe(true);
  });

  it('SQL migrations (schema-sql/pg) give the same shape', () => {
    const root = path.join(FIX, 'schema-sql', 'pg');
    const plan = planOf(root, storeText('sql-migrations', 'migrations', ''));
    const view = viewOf(root, plan)!;
    const records = view.root.children[0].children[0].children;
    expect(records.slice(0, 3).map((r) => [r.id, r.storage!.origin])).toEqual([['app.api.db.users', 'both'], ['app.api.db.classes', 'both'], ['app.api.db.ghost', 'plan']]);
    const codeOnly = records.slice(3);
    expect(codeOnly.length).toBeGreaterThan(0);
    expect(codeOnly.every((r) => r.storage!.origin === 'code' && /^migrations\/.+#.+/.test(r.id))).toBe(true);
    const members = codeOnly.find((r) => r.name === 'class_members')!;
    // a self FK (users.manager_id -> users.id ON DELETE SET NULL) and class_members.class_id -> classes.id (ON DELETE CASCADE)
    const usersFile = byId(view.root, 'app.api.db.users').file;
    expect(view.edges).toContainEqual({ from: `${usersFile}#users.manager_id`, to: `${usersFile}#users.id`, weight: 1, label: expect.stringMatching(/set null/i) });
    expect(view.edges).toContainEqual({ from: `${members.id}.class_id`, to: `${byId(view.root, 'app.api.db.classes').file}#classes.id`, weight: 1, label: expect.stringMatching(/cascade/i) });
    expect(byId(view.root, 'app.api.db.users.email').storage!.diff).toEqual(['type']);
    const ids = all(view.root).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
