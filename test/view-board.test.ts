import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { boardFileFor } from '../src/board/load';
import { tryResolveProject } from '../src/outputs';
import { initProject } from '../src/init';
import type { ViewNode } from '../src/types';

// P16-B18: buildView carries the board (model.board) and the board scripts/styles are registered.
const UID_APP = '00000000-0000-4000-8000-000000000001';

function makeRepo(withBoard: boolean): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-view-board-')));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'board-demo' }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  initProject(repo);
  // the project id comes from package.json (name 'board-demo'), so resolve the way the loader does
  const project = tryResolveProject(repo)!;
  fs.mkdirSync(project.planDir, { recursive: true });
  fs.writeFileSync(path.join(project.planDir, 'arch.c4'), [
    'model {',
    "  app = system 'App' {",
    "    web = container 'Web' {",
    "      auth = component 'Auth' {",
    `        metadata { uid '${UID_APP}' }`,
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n'));
  if (withBoard) {
    const file = boardFileFor(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const items = [
      { id: 'b1', title: 'Linked', kind: 'feature', status: 'planned', links: [UID_APP] },
      { id: 'b2', title: 'Dead', kind: 'bug', status: 'planned', links: ['nope'] },
    ];
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, boards: [{ id: 'main', name: 'Main', items }] }));
  }
  return repo;
}

const find = (n: ViewNode, id: string): ViewNode | undefined =>
  n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean);

describe('buildView and the board (P16-B18)', () => {
  it('a repo with a board file gets model.board, links and findings', () => {
    const { model, html } = buildView({ repo: makeRepo(true) });
    expect(model.board?.boards[0].items.map((i) => i.id)).toEqual(['b1', 'b2']);
    expect(model.board!.boards[0].items[0].linked[0]).toMatchObject({ uid: UID_APP, nodeId: 'app.web.auth', kind: 'component', state: 'planned-no-code' });
    expect(model.board!.boards[0].items[1].deadLinks).toEqual(['nope']);
    expect(model.board!.findings.map((f) => f.rule)).toEqual(['board-dead-link']);
    expect(find(model.root, 'app.web.auth')!.boardCount).toBe(1);
    expect(html).toContain('"board":{');
    expect((html.match(/<script>/g) ?? []).length).toBe(2);
  });

  it('a repo without a board file: no model.board, no board data in the page', () => {
    const { model, html } = buildView({ repo: makeRepo(false) });
    expect(model.board).toBeUndefined();
    expect(html).not.toContain('"board":');
    expect(html).not.toMatch(/"boardCount"\s*:/);   // no node carries the key (render.js reads it by name since P16-B29, so the bare word is in the page)
    expect((html.match(/<script>/g) ?? []).length).toBe(2);
  });

  it('board scripts and styles are inlined in the registered order, after tree.js', () => {
    const { html } = buildView({ repo: makeRepo(false) });
    const names = ['board.js', 'board-map.js', 'board-drawer.js', 'board-panel.js', 'board-list.js', 'board-kanban.js',
      'board-timeline-math.js', 'board-timeline.js', 'board-dashboard.js', 'board-search.js'];
    // Each viewer file starts with a first-line comment naming itself (the stubs do; real files keep the habit or this list is updated).
    const at = names.map((n) => html.indexOf(`// ${n}:`));
    at.forEach((i) => expect(i).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]);
    expect(at[0]).toBeGreaterThan(html.indexOf('window.C4PM_TREE'));
    const css = ['board-drawer.css', 'board-panel.css', 'board-list.css', 'board-kanban.css', 'board-timeline.css', 'board-dashboard.css', 'sim.css', 'panel.css']
      .map((n) => html.indexOf(`/* ${n}:`));
    css.forEach((i) => expect(i).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < css.length; i++) expect(css[i]).toBeGreaterThan(css[i - 1]);
  });
});
