import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';

// b645 (SV12): the Edit section of the b-item panel in a served page. C4PM_LIVE.request is a fake that the test answers by hand.

let p: BoardPage;
let B: any;

const PRELUDE = `window.__calls = []; window.__dirty = [];
window.C4PM_LIVE = { generation: 1, stamps: { plan: 'p1', board: 's1' }, settings: {}, error: null,
  dirty: function (f) { window.__dirty.push(f); },
  isDirty: function () { return window.__dirty.some(function (f) { return f(); }); },
  request: function (m, p, b) { return new Promise(function (res, rej) { window.__calls.push({ m: m, p: p, b: b, res: res, rej: rej }); }); } };`;

const find = (root: any, pred: (n: any) => boolean): any[] => {
  const out: any[] = [];
  const walk = (n: any) => (n.children || []).forEach((c: any) => { if (c.tagName && pred(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const panel = () => p.h.panel;
const byClass = (cls: string) => find(panel(), n => n.classList.contains(cls));
const btn = (label: string) => find(panel(), n => n.tagName === 'BUTTON').find((b: any) => b.textContent === label);
const ctl = (field: string) => find(panel(), n => n.dataset && n.dataset.field === field)[0];
const statusText = () => byClass('set-status').map((n: any) => n.textContent).join('|');
const calls = (): any[] => (p.sandbox.__calls as any[]).filter(c => c.p === 'api/board');
const live = () => p.sandbox.C4PM_LIVE;
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function load(live: boolean) {
  const e = sampleBoard(p.model);
  p = boardPage({ board: () => e, prelude: live ? PRELUDE : undefined });
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
  B.select('b1');
}
beforeEach(() => { p = boardPage(); });
function open() { btn('Edit fields').click(); }
const answer = async (status: number, json: any) => { calls()[0].res({ status, json }); await flush(); };

describe('b645 Edit fields in the b-item panel', () => {
  it('a static page has no Edit section', () => {
    load(false);
    expect(btn('Edit fields')).toBeUndefined();
    expect(byClass('bd-edit')).toHaveLength(0);
  });

  it('the form has nine controls in order, with the item values', () => {
    load(true);
    open();
    const fields = find(panel(), n => !!(n.dataset && n.dataset.field)).map((n: any) => n.dataset.field);
    expect(fields).toEqual(['title', 'status', 'priority', 'owner', 'start', 'due', 'size', 'sprint', 'tags']);
    expect(find(ctl('status'), n => n.tagName === 'OPTION').map((o: any) => o.textContent)).toEqual(p.model.board!.statuses);
    expect(ctl('title').value).toBe('Quiz generator');
    expect(ctl('status').value).toBe('in-progress');
    expect(ctl('owner').value).toBe('kim');
    expect(ctl('due').value).toBe('2026-10-30');
    expect(ctl('tags').value).toBe('quiz, api');
    expect(ctl('priority').tagName).toBe('INPUT');   // the fixture has no priorities list: a text input
  });

  it('Save sends one set op with only the changed fields', async () => {
    load(true);
    open();
    ctl('status').value = 'done';
    ctl('owner').value = ' Ann ';
    btn('Save').click();
    expect(calls()).toHaveLength(1);
    expect(calls()[0].m).toBe('POST');
    expect(calls()[0].p).toBe('api/board');
    expect(calls()[0].b).toEqual({ expect: 's1', ops: [{ op: 'set', id: 'b1', fields: { status: 'done', owner: 'Ann' } }] });
  });

  it('a cleared due date is none; a changed tag list is sent as typed', () => {
    load(true);
    open();
    ctl('due').value = '';
    ctl('tags').value = 'quiz, api, new';
    btn('Save').click();
    expect(calls()[0].b.ops[0].fields).toEqual({ due: 'none', tags: 'quiz, api, new' });
  });

  it('no change: Nothing to change, no request', () => {
    load(true);
    open();
    btn('Save').click();
    expect(calls()).toHaveLength(0);
    expect(statusText()).toBe('Nothing to change.');
  });

  it('200: shows what was written, updates the stamp, closes the form', async () => {
    load(true);
    open();
    ctl('status').value = 'done';
    expect(live().isDirty()).toBe(true);
    btn('Save').click();
    await answer(200, { ok: true, stoppedAt: null, stamp: 's2', results: [{ ok: true, changes: ['b1:', '  status: in-progress -> done', '  owner: kim -> Ann'] }] });
    expect(statusText()).toBe('Saved: status: in-progress -> done; owner: kim -> Ann');
    expect(live().stamps.board).toBe('s2');
    expect(find(panel(), n => n.classList.contains('bd-edit'))[0].hidden).toBe(true);
    expect(live().isDirty()).toBe(false);
  });

  it('422: the refusal text is shown and the form stays open', async () => {
    load(true);
    open();
    ctl('due').value = '2026-13-01';
    btn('Save').click();
    await answer(422, { ok: false, stoppedAt: 0, stamp: 's1', results: [{ ok: false, error: { code: 'invalid', message: "--due '2026-13-01' is not a date YYYY-MM-DD", reasons: [] } }] });
    expect(statusText()).toBe("Not saved: --due '2026-13-01' is not a date YYYY-MM-DD");
    expect(find(panel(), n => n.classList.contains('bd-edit'))[0].hidden).toBe(false);
    expect(live().stamps.board).toBe('s1');
  });

  it('409, 400 and a failed request', async () => {
    load(true);
    open();
    ctl('owner').value = 'Ann';
    btn('Save').click();
    await answer(409, { ok: false });
    expect(statusText()).toBe('The board changed since this page loaded. Nothing was written; reload, then edit again.');
    btn('Save').click();
    calls()[1].res({ status: 400, json: { message: 'bad body' } });
    await flush();
    expect(statusText()).toBe('Not saved: bad body');
    btn('Save').click();
    calls()[2].rej(new Error('down'));
    await flush();
    expect(statusText()).toBe('Not saved: c4mp serve is not running.');
  });

  it('Cancel closes the form and clears the dirty state', () => {
    load(true);
    open();
    ctl('owner').value = 'Ann';
    expect(live().isDirty()).toBe(true);
    btn('Cancel').click();
    expect(live().isDirty()).toBe(false);
    expect(find(panel(), n => n.classList.contains('bd-edit'))[0].hidden).toBe(true);
  });
});
