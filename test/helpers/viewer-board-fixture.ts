import path from 'path';
import { buildView, renderViewHtml } from '../../src/page/html';
import type { ViewBoard, ViewBoardEntry, ViewBoardItem, ViewBoardLink, ViewModel, ViewNode } from '../../src/types';
import { runViewerScripts } from './viewer-harness';
import type { HarnessResult } from './viewer-harness';

// Shared by the Phase 16 viewer-board tests (P16-B22 and later): the real sample-v2 map plus a hand-written
// ViewBoard (2 boards, nested items, links to real node ids), rendered to a page and run in the fake DOM.
// The map ids are real (api/routes, api/payments, api/services); uids are put on those nodes here.

export const BOARD_EXTRA_IDS = ['center', 'board-drawer', 'board-drawer-edge', 'board-drawer-bar', 'board-drawer-body', 'btn-board', 'board-chips'];
export const TODAY = '2026-10-21';

const walk = (n: ViewNode, fn: (n: ViewNode) => void) => { fn(n); n.children.forEach(c => walk(c, fn)); };

function link(model: ViewModel, nodeId: string): ViewBoardLink {
  let found: ViewNode | undefined;
  walk(model.root, n => { if (n.id === nodeId) found = n; });
  if (!found) throw new Error('fixture: no node ' + nodeId);
  return { uid: 'uid-' + nodeId, nodeId, name: found.name, kind: found.kind, state: 'has-code', findingCount: 0 };
}

function bitem(model: ViewModel, over: Partial<ViewBoardItem> & { id: string; title: string }, nodeIds: string[] = []): ViewBoardItem {
  return { kind: 'task', status: 'planned', dependsOn: [], links: nodeIds.map(n => 'uid-' + n), tags: [], linked: nodeIds.map(n => link(model, n)), deadLinks: [], ...over };
}

export function sampleBoard(model: ViewModel): ViewBoard {
  const groups = [{ id: 'planned', name: 'Planned', status: 'planned' }, { id: 'in-progress', name: 'In progress', status: 'in-progress' }, { id: 'done', name: 'Done', status: 'done' }];
  const sprint: ViewBoardEntry = {
    id: 'sprint', name: 'Sprint S12', groups,
    items: [
      bitem(model, { id: 'b1', title: 'Quiz generator', kind: 'feature', status: 'in-progress', owner: 'kim', tags: ['quiz', 'api'], start: '2026-10-12', due: '2026-10-30' }, ['api/routes']),
      bitem(model, { id: 'b2', title: 'Define format', parent: 'b1', status: 'done', start: '2026-10-12', due: '2026-10-14', closed: '2026-10-14' }, ['api/payments']),
      bitem(model, { id: 'b3', title: 'Build makeQuiz', parent: 'b1', dependsOn: ['b2'], start: '2026-10-15', due: '2026-10-20' }),
      bitem(model, { id: 'b4', title: 'Fix refund bug', kind: 'bug', status: 'planned', due: '2026-10-01', deadLinks: ['gone-uid'] }, ['api/services']),
      bitem(model, { id: 'b6', title: '<img src=x onerror=alert(1)>', tags: ['<b>x</b>'], owner: '<i>o</i>' }),
    ],
  };
  const backlog: ViewBoardEntry = {
    id: 'backlog', name: 'Backlog', groups,
    items: [bitem(model, { id: 'b5', title: 'Batch translate', kind: 'feature', dependsOn: ['b3'] }, ['api/payments'])],
  };
  const old: ViewBoardEntry = { id: 'old', name: 'Old', archived: true, groups, items: [bitem(model, { id: 'b9', title: 'Archived item' }, ['api/routes'])] };
  return { statuses: ['planned', 'in-progress', 'done', 'abandoned'], kinds: ['task', 'feature', 'issue', 'bug'], boards: [sprint, backlog, old],
    // what `c4pm check` reports for b4's link (message shape of src/board/check.ts); P16-B17b reads it to tell a dead link from an undrawn element
    findings: [{ severity: 'warning', rule: 'board-dead-link', id: 'b4', message: "b4: link 'gone-uid' matches no plan element" }] };
}

export interface BoardPage { h: HarnessResult; model: ViewModel; html: string; sandbox: Record<string, any> }

/** Page for the sample-v2 map. `board` false = no ViewModel.board at all (the page must be unchanged). */
export function boardPage(opts: { board?: boolean | ((m: ViewModel) => ViewBoard); extraIds?: string[]; uids?: boolean; prelude?: string } = {}): BoardPage {
  const built = buildView({ repo: path.join(__dirname, '..', 'fixtures/sample-v2') });
  const model = built.model;
  if (opts.uids !== false) walk(model.root, n => { if (n.kind === 'component') n.uid = 'uid-' + n.id; });
  if (opts.board !== false) model.board = typeof opts.board === 'function' ? opts.board(model) : sampleBoard(model);
  let html = renderViewHtml(model);
  // `prelude`: script text run before the viewer scripts (e.g. a fake localStorage; the sandbox has none)
  if (opts.prelude) { const at = html.lastIndexOf('<script>') + '<script>'.length; html = html.slice(0, at) + opts.prelude + '\n' + html.slice(at); }
  const h = runViewerScripts(html, { extraIds: [...BOARD_EXTRA_IDS, ...(opts.extraIds ?? [])] });
  h.frames.runToCompletion();
  return { h, model, html, sandbox: h.sandbox };
}
