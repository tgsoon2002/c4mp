import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';

// b645 (SV11b): Save of the Kanban pending bar in a served page. C4PM_LIVE.request is a fake that the test answers by hand.

let p: BoardPage;
let B: any;

const PRELUDE = `window.__calls = []; window.__dirty = [];
window.C4PM_LIVE = { generation: 1, stamps: { plan: 'p1', board: 's1' }, settings: {}, error: null,
  dirty: function (f) { window.__dirty.push(f); },
  isDirty: function () { return window.__dirty.some(function (f) { return f(); }); },
  request: function (m, p, b) { return new Promise(function (res, rej) { window.__calls.push({ m: m, p: p, b: b, res: res, rej: rej }); }); } };`;

const body = () => (p.sandbox.document as any).getElementById('board-drawer-body');
const find = (root: any, pred: (n: any) => boolean): any[] => {
  const out: any[] = [];
  const walk = (n: any) => (n.children || []).forEach((c: any) => { if (c.tagName && pred(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const byClass = (root: any, cls: string) => find(root, n => n.classList.contains(cls));
const col = (gid: string) => byClass(body(), 'kb-col').find((c: any) => c.dataset.gid === gid);
const head = (gid: string) => byClass(col(gid), 'kb-head')[0];
const card = (id: string) => byClass(body(), 'kb-card').find((c: any) => c.dataset.id === id);
const bar = () => byClass(body(), 'kb-pending')[0];
const pres = (): string[] => find(bar(), n => n.tagName === 'PRE').map((n: any) => n.textContent);
const cmds = (): string[] => (pres()[0] ? pres()[0].split('\n') : []);
const button = (label: string) => find(bar(), n => n.tagName === 'BUTTON').find((b: any) => b.textContent === label);
const calls = (): any[] => (p.sandbox.__calls as any[]).filter(c => c.p === 'api/board');
const live = () => p.sandbox.C4PM_LIVE;
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function drag(id: string, gid: string) {
  const dt = { effectAllowed: '', dropEffect: '', setData: jest.fn() };
  card(id).dispatch('dragstart', { dataTransfer: dt });
  col(gid).dispatch('dragover', { dataTransfer: dt, preventDefault: jest.fn() });
  col(gid).dispatch('drop', { dataTransfer: dt, preventDefault: jest.fn() });
}
function addGroup(name: string) {
  find(body(), n => n.tagName === 'BUTTON').find((b: any) => b.textContent === '+ Group').click();
  const input = find(body(), n => n.tagName === 'INPUT')[0];
  input.value = name;
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
}
function dragHead(gid: string, onto: string, right: boolean) {
  const dt = { setData() {} };
  head(gid).dispatch('dragstart', { dataTransfer: dt });
  const target = col(onto);
  (target as any).getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
  target.dispatch('dragover', { dataTransfer: dt, clientX: right ? 90 : 10, preventDefault() {} });
  target.dispatch('drop', { dataTransfer: dt, clientX: right ? 90 : 10, preventDefault() {} });
}

function load(opts: { prelude?: string; mutate?: (e: any) => void } = {}) {
  const e = sampleBoard(p.model);
  e.boards[0].groups = [...e.boards[0].groups];
  if (opts.mutate) opts.mutate(e.boards[0]);
  p = boardPage({ board: () => e, prelude: opts.prelude });
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
  p.sandbox.C4PM_DATA.repoPath = '/work/repo';
  B.open();
  B.setView('kanban');
}

beforeEach(() => { p = boardPage(); });

describe('b645 Save in the kanban bar', () => {
  it('a static page has no Save and keeps its text', () => {
    load();
    drag('b3', 'done');
    expect(button('Save')).toBeUndefined();
    expect(find(bar(), n => n.tagName === 'SPAN')[0].textContent).toBe('- this page cannot write files. Copy the commands and run them in a terminal.');
  });

  it('live: one move sends one request with the board stamp', () => {
    load({ prelude: PRELUDE, mutate: e => { e.items[3].group = 'triage'; e.groups.push({ id: 'triage', name: 'Triage' }); } });
    drag('b4', 'planned');
    expect(find(bar(), n => n.tagName === 'BUTTON').map((b: any) => b.textContent)).toEqual(['Save', 'Copy commands', 'Discard']);
    expect(find(bar(), n => n.tagName === 'SPAN')[0].textContent).toBe('- not saved yet.');
    button('Save').click();
    expect(calls().length).toBe(1);
    expect(calls()[0].m).toBe('POST');
    expect(calls()[0].b).toEqual({ expect: 's1', ops: [{ op: 'set', id: 'b4', fields: { group: 'none' } }] });
    expect(button('Saving ...')).toBeDefined();
  });

  it('ops go in the run order of the commands', () => {
    load({ prelude: PRELUDE, mutate: e => { e.groups.push({ id: 'spare', name: 'Spare' }); } });
    addGroup('Extra');
    drag('b3', 'done');
    byClass(head('spare'), 'kb-x')[0].click();
    dragHead('done', 'planned', false);
    const list = cmds();
    button('Save').click();
    const ops = calls()[0].b.ops;
    expect(ops.map((o: any) => o.op)).toEqual(['group-add', 'set', 'group-remove', 'group-order']);
    expect(list.map(c => c.split(' ').slice(0, 3).join(' '))).toEqual(['c4mp board group', 'c4mp board set', 'c4mp board group', 'c4mp board group']);
    expect(ops[0]).toEqual({ op: 'group-add', board: 'sprint', name: 'Extra' });
    expect(ops[1]).toEqual({ op: 'set', id: 'b3', fields: { status: 'done' } });
    expect(ops[2]).toEqual({ op: 'group-remove', board: 'sprint', name: 'Spare' });
    expect(ops[3].names).toEqual(['Done', 'Planned', 'In progress', 'Extra']);
  });

  it('all written: pending empty, report shown, stamp kept', async () => {
    load({ prelude: PRELUDE });
    drag('b3', 'in-progress');
    drag('b6', 'done');
    expect(live().isDirty()).toBe(true);
    button('Save').click();
    calls()[0].res({ status: 200, json: { ok: true, results: [{ ok: true }, { ok: true }], stoppedAt: null, stamp: 's2', error: null } });
    await flush();
    expect(bar().hidden).toBe(false);
    expect(pres()[0].split('\n')[0]).toBe('Saved 2 change(s).');
    expect(pres()[0].split('\n').filter(l => l.startsWith('written: ')).length).toBe(2);
    expect(live().isDirty()).toBe(false);
    expect(live().stamps.board).toBe('s2');
    expect(button('Save')).toBeUndefined();
  });

  it('stopped: written, refused, not run; dirty until Close; Copy has the not-run commands', async () => {
    load({ prelude: PRELUDE });
    drag('b3', 'in-progress');
    drag('b6', 'done');
    drag('b1', 'done');
    const all = cmds();
    button('Save').click();
    calls()[0].res({ status: 422, json: { ok: false, results: [{ ok: true }, { ok: false, error: { message: 'no item b6' } }], stoppedAt: 1, stamp: 's2', error: null } });
    await flush();
    const lines = pres()[0].split('\n');
    expect(lines).toEqual(['Saved 1 of 3 change(s); stopped at a refusal.', 'written: ' + all[0], 'refused: ' + all[1], '  no item b6', 'not run: ' + all[2]]);
    expect(live().isDirty()).toBe(true);
    const copy = button('Copy commands');
    const written: string[] = [];
    (p.sandbox.navigator as any) = { clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } };
    copy.click();
    expect(written).toEqual([all[2]]);
    button('Close').click();
    expect(bar().hidden).toBe(true);
    expect(live().isDirty()).toBe(false);
  });

  it('409 changed: pending kept, text shown, still dirty', async () => {
    load({ prelude: PRELUDE });
    drag('b3', 'in-progress');
    const before = cmds();
    button('Save').click();
    calls()[0].res({ status: 409, json: { ok: false, error: { message: 'changed' } } });
    await flush();
    expect(cmds()).toEqual(before);
    expect(pres()[1]).toBe('The board changed since this page loaded. Nothing was written; your changes are kept. Copy the commands, or Discard and reload.');
    expect(live().isDirty()).toBe(true);
  });

  it('rejected request: serve not running, pending kept', async () => {
    load({ prelude: PRELUDE });
    drag('b3', 'in-progress');
    const before = cmds();
    button('Save').click();
    calls()[0].rej(new Error('down'));
    await flush();
    expect(pres()[1]).toBe('Save failed: c4mp serve is not running. Nothing was written; your changes are kept.');
    expect(cmds()).toEqual(before);
  });

  it('writes text only (no innerHTML in the bar)', async () => {
    load({ prelude: PRELUDE });
    drag('b3', 'in-progress');
    button('Save').click();
    calls()[0].res({ status: 200, json: { ok: true, results: [{ ok: true }], stoppedAt: null, stamp: 's2', error: null } });
    await flush();
    expect(find(bar(), () => true).every((n: any) => !n._html)).toBe(true);
  });
});
