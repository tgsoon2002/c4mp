import { parseC4 } from '../src/plan/parser';
import { buildViewModel } from '../src/view/model';
import { buildSnapshot } from '../src/snapshot/build';
import { attachBoard } from '../src/board/view';
import { buildStorageView } from '../src/view/storageModel';
import { Plan, BuildInput, Component, Container, FileOutline, SnapshotMeta, ViewNode, BoardFile } from '../src/types';

// P16-B17b: a board link to ANY plan element with a uid resolves to its map node when that node is drawn.
const C4_FILE = '.c4pm/projects/p/plan/arch.c4';   // links resolve against the plan file: '../../../../x' = repo-root x
const UID_SYS = '00000000-0000-4000-8000-000000000001';
const UID_WEB = '00000000-0000-4000-8000-000000000002';
const UID_AUTH = '00000000-0000-4000-8000-000000000003';
const UID_BILL = '00000000-0000-4000-8000-000000000004';   // a plan-only component (no code)
const UID_NONE = '00000000-0000-4000-8000-0000000000ff';   // in no plan

function c4Text(links: { auth: string[]; bill: string[] }): string {
  const lines = (ls: string[]) => ls.map((l) => `        link ${l}`);
  return [
    'model {',
    "  app = system 'Claim App' {",
    `    metadata { uid '${UID_SYS}' }`,
    "    web = container 'Web' {",
    `      metadata { uid '${UID_WEB}' }`,
    "      auth = component 'Auth' {",
    `        metadata { uid '${UID_AUTH}' }`,
    ...lines(links.auth),
    '      }',
    "      bill = component 'Billing' {",
    `        metadata { uid '${UID_BILL}' }`,
    ...lines(links.bill),
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function snapshotFor(plan: Plan) {
  const meta: SnapshotMeta = { tool: 'c4pm@0.1.0', repoPath: '/test/repo', repoName: 'Claim App', createdAt: '2026-01-01T00:00:00.000Z', git: null };
  const containers: Container[] = [{ id: 'web', name: 'Web', path: '.', tech: 'Node.js', manifest: 'package.json' }];
  const fn = (name: string, s: number, e: number) => ({ name, kind: 'function' as const, startLine: s, endLine: e, lineCount: e - s + 1 });
  const outlines: FileOutline[] = [{ file: 'src/util.ts', lineCount: 5, parseError: false, elements: [fn('formatDate', 1, 5)] }];
  // Folder mode (no #function link anywhere): a scanned folder component (id 'web/src') owns the file.
  const claim = plan.elements.some((e) => e.kind === 'component' && e.links?.some((l) => l.raw.includes('#')));
  const components: Component[] = claim ? [] : [{ id: 'web/src', name: 'Src', containerId: 'web', path: 'src', files: ['src/util.ts'] }];
  const input: BuildInput = { meta, containers, components, outlines, imports: [], componentEdges: [], fileEdges: [] };
  return buildSnapshot(input, plan);
}

const all = (n: ViewNode, out: ViewNode[] = []): ViewNode[] => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
const find = (n: ViewNode, id: string): ViewNode | undefined => all(n).find((x) => x.id === id);

const file = (links: string[]): BoardFile => ({
  schemaVersion: 1,
  boards: [{ id: 'main', name: 'Main', items: [
    { id: 'b1', title: 'one', kind: 'task', status: 'planned', dependsOn: [], links, tags: [] },
  ] }],
});

describe('board links and component uids (P16-B17b)', () => {
  it('claim mode: links to system, container, component and a plan-only component all resolve and badge their node', () => {
    const plan = planFrom(c4Text({ auth: ['../../../../src/util.ts#formatDate'], bill: [] }));
    const model = buildViewModel(snapshotFor(plan), 's', plan);
    attachBoard(model, file([UID_SYS, UID_WEB, UID_AUTH, UID_BILL, UID_NONE]), []);
    const it = model.board!.boards[0].items[0];
    expect(it.linked.map((l) => [l.uid, l.nodeId, l.kind])).toEqual([
      [UID_SYS, model.root.id, 'system'],
      [UID_WEB, 'web', 'container'],
      [UID_AUTH, 'app.web.auth', 'component'],
      [UID_BILL, 'app.web.bill', 'component'],
    ]);
    expect(it.deadLinks).toEqual([UID_NONE]);
    for (const id of ['web', 'app.web.auth', 'app.web.bill']) expect(find(model.root, id)!.boardCount).toBe(1);
  });

  it('folder mode: a plan component that stands for a scanned folder component links to that box', () => {
    const plan = planFrom(c4Text({ auth: ['../../../../src/'], bill: [] }));
    const model = buildViewModel(snapshotFor(plan), 's', plan);
    const scanned = find(model.root, 'web/src')!;
    expect(scanned).toBeDefined();
    expect(scanned.uid).toBe(UID_AUTH);
    expect(find(model.root, 'app.web.auth')).toBeUndefined();   // the plan component is not drawn twice
    attachBoard(model, file([UID_AUTH, UID_BILL]), []);
    const it = model.board!.boards[0].items[0];
    expect(it.linked.map((l) => [l.nodeId, l.state])).toEqual([['web/src', 'has-code'], ['app.web.bill', 'planned-no-code']]);
    expect(it.deadLinks).toEqual([]);
    expect(scanned.boardCount).toBe(1);
  });

  it('folder mode without uids in the plan: no node gets a uid', () => {
    const text = c4Text({ auth: ['../../../../src/'], bill: [] }).split('\n').filter((l) => !l.includes('metadata')).join('\n');
    const plan = planFrom(text);
    const model = buildViewModel(snapshotFor(plan), 's', plan);
    expect(all(model.root).some((n) => 'uid' in n)).toBe(false);
  });

  it('STOR-5 (b338): links to a store, a record and a field resolve to their storage-view nodes; an arch uid still links the arch node', () => {
    const UID_STORE = '00000000-0000-4000-8000-000000000011';
    const UID_REC = '00000000-0000-4000-8000-000000000012';
    const UID_FIELD = '00000000-0000-4000-8000-000000000013';
    const store = [
      "      db = store 'DB' {",
      `        metadata { uid '${UID_STORE}' }`,
      "        users = record 'users' {",
      `          metadata { uid '${UID_REC}' }`,
      `          email = field 'email' { metadata { uid '${UID_FIELD}' } }`,
      '        }',
      '      }',
    ];
    const lines = c4Text({ auth: ['../../../../src/util.ts#formatDate'], bill: [] }).split('\n');
    lines.splice(lines.indexOf("    web = container 'Web' {") + 2, 0, ...store);
    const plan = planFrom(lines.join('\n'));
    const model = buildViewModel(snapshotFor(plan), 's', plan);
    const element = plan.elements.find((e) => e.id === 'app.web.db')!;
    // a store no reader read (no code, no error): the store and its records are plan-only, still linkable
    model.storageView = buildStorageView(plan, { stores: [{ element, reader: null, model: null, files: [], matching: null, fieldDiffs: [] }], hits: [] })!;
    attachBoard(model, file([UID_STORE, UID_REC, UID_FIELD, UID_WEB]), []);
    const it = model.board!.boards[0].items[0];
    expect(it.linked.map((l) => [l.uid, l.nodeId, l.kind])).toEqual([
      [UID_STORE, 'app.web.db', 'store'],
      [UID_REC, 'app.web.db.users', 'record'],
      [UID_FIELD, 'app.web.db.users.email', 'field'],
      [UID_WEB, 'web', 'container'],
    ]);
    // STOR-5w (b609): a record and a field only in the plan link as planned-no-code, as an arch ghost does;
    // b611: so does a store with no code (missing-store)
    expect(it.linked.filter((l) => l.uid === UID_STORE || l.uid === UID_REC || l.uid === UID_FIELD).map((l) => l.state))
      .toEqual(['planned-no-code', 'planned-no-code', 'planned-no-code']);
    expect(it.deadLinks).toEqual([]);
    expect(find(model.storageView.root, 'app.web.db.users')!.boardCount).toBe(1);
  });
});
