import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';
import { BOARD_EXTRA_IDS } from './helpers/viewer-board-fixture';
import { drizzleStorageView, storageModel } from './helpers/storage-view';
import type { ViewBoard, ViewModel, ViewNode } from '../src/types';

// STOR-6b (b340): the side panel of the storage view (renderStorageNode, viewer/panel.js) in the fake DOM. Page: the Drizzle reader
// fixture (test/fixtures/schema-drizzle) with a plan of one store, opened at '#storage'. login_identities is matched (plan uid, its
// plan field user_id says type 'text', the code 'uuid': type drift), ghost is plan-only, classes and the rest are code-only.

const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      db = store 'Main DB' {",
  "        technology 'postgres'",
  "        metadata { reader 'drizzle' source 'db/schema' }",
  "        login = record 'login_identities' {",
  "          metadata { uid 'uid-login' }",
  "          id = field 'id' { metadata { type 'uuid' pk 'true' } }",
  "          user_id = field 'user_id' { metadata { type 'text' fk 'users.id' onDelete 'cascade' } }",
  '        }',
  "        ghost = record 'ghost' {",
  "          owner = field 'owner' { metadata { type 'uuid' } }",
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const STORE = 'app.api.db';
const LOGIN = 'app.api.db.login';
const USER_ID = 'app.api.db.login.user_id';
const GHOST = 'app.api.db.ghost';
const CLASSES = 'db/schema/classes.ts#classes';
const USERS = 'db/schema/users.ts#users';

function board(): ViewBoard {
  const groups = [{ id: 'planned', name: 'Planned', status: 'planned' }];
  return {
    statuses: ['planned', 'in-progress', 'done', 'abandoned'], kinds: ['task', 'feature', 'issue', 'bug'], findings: [],
    boards: [{ id: 'sprint', name: 'Sprint', groups, items: [
      { id: 'b7', title: 'Add login audit', kind: 'task', status: 'planned', dependsOn: [], links: ['uid-login'], tags: [], linked: [], deadLinks: [] },
    ] }],
  };
}

function model(edit: (m: ViewModel) => void = () => undefined): ViewModel {
  const m = storageModel(drizzleStorageView(PLAN));
  m.files.push({ path: 'db/schema/auth.ts', kind: 'source', owners: ['api/routes'] });
  m.board = board();
  edit(m);
  return m;
}

function page(m: ViewModel = model()) {
  const loc = { href: 'file:///x.html#storage', hash: '#storage' };
  const h = runViewerScripts(renderViewHtml(m), { extraIds: ['btn-gear', 'settings-pop', ...BOARD_EXTRA_IDS], globals: { location: loc } });
  const w = h.sandbox.window as any;
  const select = (id: string) => { expect(w.C4PM_MAP.select(id)).not.toBe(false); };
  return { h, w, select, loc };
}

const all = (root: FakeEl, cls: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const text = (el: FakeEl) => serializeText(el).replace(/\s+/g, ' ').trim();
const label = (sec: FakeEl) => text(sec.children[0]);
const sectionOf = (panel: FakeEl, name: string): FakeEl => {
  const sec = all(panel, 'pn-section').find(s => label(s) === name || label(s).startsWith(name + ' '));
  if (!sec) throw new Error('no section ' + name + ' in: ' + all(panel, 'pn-section').map(label).join(' | '));
  return sec;
};
const chips = (el: FakeEl) => all(el, 'pn-dep-chip');
const pills = (panel: FakeEl) => all(panel, 'pn-badge').map(b => b.textContent);
const nodeOf = (m: ViewModel, id: string): ViewNode => {
  const walk = (n: ViewNode): ViewNode | null => (n.id === id ? n : n.children.map(walk).find(Boolean) || null);
  const n = walk(m.storageView!.root);
  if (!n) throw new Error('no node ' + id);
  return n;
};

describe('STOR-6b storage panel', () => {
  it('nothing selected: the summary is the storage view line, not the repo summary', () => {
    const { h, w } = page();
    expect(w.C4PM_MODE.get()).toBe('storage');
    const t = text(h.panel);
    expect(t).toContain('Storage view: ' + w.C4PM_VIEWS.storage.chips(w.C4PM_DATA));
    expect(t).not.toContain(w.C4PM_DATA.title);
  });

  it('store: technology and word, the record count, the records as links that select them', () => {
    const m = model();
    const { h, w, select } = page(m);
    select(STORE);
    const recs = nodeOf(m, STORE).children;
    expect(all(h.panel, 'pn-kind')[0].textContent).toBe('database');
    expect(pills(h.panel)).toEqual(['postgres', recs.length + ' tables']);
    const contents = sectionOf(h.panel, 'Contents');
    expect(chips(contents).map(c => c.textContent)).toEqual(recs.map(r => r.name));
    chips(contents).find(c => c.textContent === 'ghost')!.onclick!();
    expect(w.C4PM_MAP.selectedId()).toBe(GHOST);
  });

  it('matched record: word + tech, origin, file:line, the Fields table (PK, FK on delete, drift), indexes, checks', () => {
    const { h, select } = page();
    select(LOGIN);
    const t = text(h.panel);
    expect(all(h.panel, 'pn-kind')[0].textContent).toBe('table');
    expect(pills(h.panel)).toEqual(['table', 'postgres']);
    expect(t).toContain('in the plan and the code');
    expect(t).toContain('db/schema/auth.ts:9');
    expect(all(h.panel, 'pn-vscode-link')[0].href).toMatch(/db\/schema\/auth\.ts:9$/);
    const rows = all(sectionOf(h.panel, 'Fields'), 'pn-child-row');
    const row = (name: string) => rows.find(r => r.children[0].children[0].textContent === name)!;
    expect(text(row('id'))).toContain('PK');
    expect(row('id').children[1].textContent).toBe('uuid');
    const uid = text(row('user_id'));
    expect(uid).toContain('not null');
    expect(uid).toContain('FK users.id on delete cascade');
    expect(uid).toContain('drift: type differs from the plan');
    expect(text(row('email'))).toContain('nullable');
    expect(text(row('email'))).toContain('drift: not in the plan');
    expect(text(sectionOf(h.panel, 'Indexes'))).toContain('login_identities_provider_subject_uniq: unique (provider, subject)');
    expect(text(sectionOf(h.panel, 'Checks'))).toContain('login_identities_password_hash_check');
  });

  it('a Fields row selects its field', () => {
    const { h, w, select } = page();
    select(LOGIN);
    all(sectionOf(h.panel, 'Fields'), 'pn-child-row').find(r => r.title === USER_ID)!.onclick!();
    expect(w.C4PM_MAP.selectedId()).toBe(USER_ID);
  });

  it('a code-only record says code-only; a plan-only record says not in the code', () => {
    const { h, select } = page();
    select(CLASSES);
    expect(text(h.panel)).toContain('code-only: in the code, not in the plan');
    select(GHOST);
    const t = text(h.panel);
    expect(t).toContain('plan-only: in the plan, not in the code');
    expect(t).toContain('no owner (no code file)');
  });

  it('field with drift: type, flags, its record (a link), the drift, its FK out', () => {
    const { h, w, select } = page();
    select(USER_ID);
    expect(all(h.panel, 'pn-kind')[0].textContent).toBe('column');
    expect(pills(h.panel)).toEqual(['column', 'uuid', 'not null', 'FK users.id on delete cascade']);
    expect(text(sectionOf(h.panel, 'Drift'))).toContain('type differs from the plan');
    const out = sectionOf(h.panel, 'References (out)');
    expect(text(out)).toContain('login_identities.user_id → users.id · on delete cascade');
    expect(chips(out).map(c => c.textContent)).toEqual(['users.id']);
    expect(text(sectionOf(h.panel, 'Referenced by (in)'))).toContain('none');
    chips(sectionOf(h.panel, 'In'))[0].onclick!();
    expect(w.C4PM_MAP.selectedId()).toBe(LOGIN);
  });

  it('References (out) and Referenced by (in) link the other record', () => {
    const { h, w, select } = page();
    select(LOGIN);
    const out = sectionOf(h.panel, 'References (out)');
    expect(chips(out).map(c => c.textContent)).toEqual(['users']);
    chips(out)[0].onclick!();
    expect(w.C4PM_MAP.selectedId()).toBe(USERS);
    const inn = sectionOf(h.panel, 'Referenced by (in)');
    const back = chips(inn).find(c => c.textContent === 'login_identities')!;
    expect(back).toBeDefined();
    back.onclick!();
    expect(w.C4PM_MAP.selectedId()).toBe(LOGIN);
  });

  it('owner: the component that claims the record file; its link opens the architecture view on it', () => {
    const { h, w, select } = page();
    select(LOGIN);
    const owner = sectionOf(h.panel, 'Owner');
    expect(chips(owner).map(c => c.textContent)).toEqual(['Routes']);
    w.C4PM_SETTINGS.set('openIn', 'here');
    chips(owner)[0].onclick!();
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect(w.C4PM_MAP.selectedId()).toBe('api/routes');
  });

  it('owner: a record file the page does not list has no owner', () => {
    const { h, select } = page();
    select(CLASSES);
    expect(text(sectionOf(h.panel, 'Owner'))).toContain('no owner (db/schema/classes.ts is not in the scanned files)');
  });

  it('a b-item linked to the record uid is listed (board-panel.js, by uid)', () => {
    const { h, select } = page();
    select(LOGIN);
    const sec = sectionOf(h.panel, 'Board items (1)');
    expect(text(sec)).toContain('b7');
    expect(text(sec)).toContain('Add login audit');
    expect(text(h.panel)).toContain('uid uid-login');
  });

  it('a storage node without storage data is a console error with its id, not an empty panel', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { h, select } = page(model(m => { delete nodeOf(m, GHOST).storage; }));
      select(GHOST);
      expect(spy).toHaveBeenCalledWith('[c4pm panel]', 'storage node without storage data', GHOST);
      expect(text(h.panel)).toContain('no storage data for ' + GHOST);
    } finally {
      spy.mockRestore();
    }
  });

  it('names and types are text, never markup', () => {
    const { h, select } = page(model(m => { const f = nodeOf(m, USER_ID); f.meta = { ...f.meta, type: '<img src=x onerror=alert(1)>' }; }));
    select(LOGIN);
    const tags: string[] = [];
    (function walk(n: FakeEl) { (n.children || []).forEach(c => { if (c.tagName) tags.push(c.tagName); walk(c); }); })(h.panel);
    expect(tags).not.toContain('IMG');
    expect(text(sectionOf(h.panel, 'Fields'))).toContain('<img src=x onerror=alert(1)>');
  });
});
