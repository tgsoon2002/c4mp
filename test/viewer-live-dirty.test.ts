import path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { BOARD_EXTRA_IDS, sampleBoard } from './helpers/viewer-board-fixture';

// SV8 (b795): controls.js and board-kanban.js register an unsaved-edits check with C4PM_LIVE.dirty at their load.

type Check = () => boolean;

function fakeLive(checks: Check[]) {
  return { generation: 1, stamps: {}, settings: {}, error: null, request: () => new Promise(() => {}),
    dirty: (fn: Check) => { checks.push(fn); }, isDirty: () => false };
}

function samplePage(globals?: Record<string, unknown>) {
  const html = buildView({ repo: path.join(__dirname, 'fixtures/sample') }).html;
  return runViewerScripts(html, globals ? { globals } : {});
}

function boardPageWith(globals: Record<string, unknown>) {
  const { model } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  model.board = sampleBoard(model);
  return runViewerScripts(renderViewHtml(model), { extraIds: BOARD_EXTRA_IDS, globals });
}

describe('C4PM_LIVE.dirty checks (SV8)', () => {
  it('sample page: controls.js registers one check; undo history makes it true', () => {
    const checks: Check[] = [];
    const h = samplePage({ C4PM_LIVE: fakeLive(checks) });
    expect(checks).toHaveLength(1);
    expect(checks[0]()).toBe(false);
    (h.sandbox as any).C4PM_STATE.map.history.undo.push({});
    expect(checks[0]()).toBe(true);
  });

  it('board page: three checks; the kanban and panel-edit ones are false at load', () => {
    const checks: Check[] = [];
    boardPageWith({ C4PM_LIVE: fakeLive(checks) });
    // The three checks: controls layout history, kanban pending, panel edit (SV12).
    expect(checks).toHaveLength(3);
    expect(checks[1]()).toBe(false);
    expect(checks[2]()).toBe(false);
  });

  it('without C4PM_LIVE nothing throws', () => {
    expect(() => samplePage()).not.toThrow();
  });
});
