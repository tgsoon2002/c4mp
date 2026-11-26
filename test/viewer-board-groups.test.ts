import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';

// P16-B32b: Kanban group editing (+ Group, delete an empty custom group, drag heads to reorder) and the
// `c4mp board group ...` commands it prints (fake DOM). Real syntax: src/cli/boardWrite.ts.

let p: BoardPage;
let B: any;

const body = () => (p.sandbox.document as any).getElementById('board-drawer-body');
const find = (root: any, pred: (n: any) => boolean): any[] => {
  const out: any[] = [];
  const walk = (n: any) => (n.children || []).forEach((c: any) => { if (c.tagName && pred(c)) out.push(c); walk(c); });
  walk(root);
  return out;
};
const byClass = (root: any, cls: string) => find(root, n => n.classList.contains(cls));
const cols = () => byClass(body(), 'kb-col').filter((c: any) => c.dataset.gid);
const order = () => cols().map((c: any) => c.dataset.gid);
const col = (gid: string) => cols().find((c: any) => c.dataset.gid === gid);
const head = (gid: string) => byClass(col(gid), 'kb-head')[0];
const bar = () => byClass(body(), 'kb-pending')[0];
const cmds = (): string[] => {
  const pre = find(bar(), n => n.tagName === 'PRE')[0];
  return pre ? pre.textContent.split('\n') : [];
};
const button = (label: string) => find(body(), n => n.tagName === 'BUTTON').find((b: any) => b.textContent === label);
const REPO = ' --repo /work/repo --yes';

function addGroup(name: string) {
  if (!find(body(), n => n.tagName === 'INPUT').length) button('+ Group').click();
  const input = find(body(), n => n.tagName === 'INPUT')[0];
  input.value = name;
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
}
/** drag the head of `gid` onto column `onto`, left or right half (box is 100 px wide, clientX 10 or 90) */
function dragHead(gid: string, onto: string, right: boolean) {
  const dt = { setData() {} };
  head(gid).dispatch('dragstart', { dataTransfer: dt });
  const target = col(onto);
  (target as any).getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
  target.dispatch('dragover', { dataTransfer: dt, clientX: right ? 90 : 10, preventDefault() {} });
  target.dispatch('drop', { dataTransfer: dt, clientX: right ? 90 : 10, preventDefault() {} });
}

function load(mutate?: (e: any) => void) {
  const e = sampleBoard(p.model);
  e.boards[0].groups = [...e.boards[0].groups];   // own array: the fixture shares one between boards
  if (mutate) mutate(e.boards[0]);
  p = boardPage({ board: () => e });
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
  p.sandbox.C4PM_DATA.repoPath = '/work/repo';
  B.open();
  B.setView('kanban');
}

beforeEach(() => { p = boardPage(); load(); });

describe('P16-B32b + Group', () => {
  it('adds a column at the end and prints `board group add` with --board, --repo and --yes', () => {
    addGroup('Needs triage');
    expect(order()).toEqual(['planned', 'in-progress', 'done', 'needs-triage']);
    expect(cmds()).toEqual(["c4mp board group add 'Needs triage' --board sprint" + REPO]);
    expect(B.entry().groups.length).toBe(3);   // the saved board is untouched
  });

  it('refuses an empty name, a comma, a line break and a duplicate (any case); nothing pending', () => {
    for (const bad of ['  ', 'a,b', 'a\nb', 'DONE', 'planned']) {
      addGroup(bad);
      expect(find(body(), n => n.tagName === 'INPUT').length).toBe(1);   // input stays open
      expect(byClass(body(), 'kb-err')[0].textContent).not.toBe('');
      expect(cmds()).toEqual([]);
    }
  });

  it('Escape closes the input; Discard removes the added group', () => {
    button('+ Group').click();
    find(body(), n => n.tagName === 'INPUT')[0].dispatch('keydown', { key: 'Escape' });
    expect(find(body(), n => n.tagName === 'INPUT').length).toBe(0);
    addGroup('X');
    button('Discard').click();
    expect(order()).toEqual(['planned', 'in-progress', 'done']);
    expect(cmds()).toEqual([]);
  });

  it('a card moved into the new group prints add first, then the set command', () => {
    addGroup('Needs triage');
    const dt = { setData() {} };
    const card = byClass(body(), 'kb-card').find((c: any) => c.dataset.id === 'b3');
    card.dispatch('dragstart', { dataTransfer: dt });
    col('needs-triage').dispatch('dragover', { dataTransfer: dt, preventDefault() {} });
    col('needs-triage').dispatch('drop', { dataTransfer: dt, preventDefault() {} });
    expect(cmds()).toEqual([
      "c4mp board group add 'Needs triage' --board sprint" + REPO,
      'c4mp board set b3 --repo /work/repo --group needs-triage --yes',
    ]);
  });
});

describe('P16-B32b delete an empty group', () => {
  it('only an empty custom group has a delete button; status groups never do', () => {
    load(b => b.groups.push({ id: 'triage', name: 'Needs triage' }, { id: 'busy', name: 'Busy' }));
    expect(byClass(head('planned'), 'kb-x').length).toBe(0);
    expect(byClass(head('done'), 'kb-x').length).toBe(0);
    expect(byClass(head('triage'), 'kb-x').length).toBe(1);
    load(b => { b.groups.push({ id: 'busy', name: 'Busy' }); b.items[3].group = 'busy'; });
    expect(byClass(head('busy'), 'kb-x').length).toBe(0);   // has an item
  });

  it('delete prints `board group remove`; the column goes; deleting a just-added group prints nothing', () => {
    load(b => b.groups.push({ id: 'triage', name: 'Needs triage' }));
    byClass(head('triage'), 'kb-x')[0].click();
    expect(order()).toEqual(['planned', 'in-progress', 'done']);
    expect(cmds()).toEqual(["c4mp board group remove 'Needs triage' --board sprint" + REPO]);
    button('Discard').click();
    expect(order()).toContain('triage');
    addGroup('Temp');
    byClass(head('temp'), 'kb-x')[0].click();
    expect(cmds()).toEqual([]);
  });

  it('a group emptied by a pending move can be deleted; the card command runs before the remove', () => {
    load(b => { b.groups.push({ id: 'busy', name: 'Busy' }); b.items[3].group = 'busy'; });
    const dt = { setData() {} };
    const card = byClass(body(), 'kb-card').find((c: any) => c.dataset.id === 'b4');
    card.dispatch('dragstart', { dataTransfer: dt });
    col('planned').dispatch('dragover', { dataTransfer: dt, preventDefault() {} });
    col('planned').dispatch('drop', { dataTransfer: dt, preventDefault() {} });
    byClass(head('busy'), 'kb-x')[0].click();
    expect(cmds()).toEqual([
      'c4mp board set b4 --repo /work/repo --group none --yes',
      'c4mp board group remove Busy --board sprint' + REPO,
    ]);
  });
});

describe('P16-B32b reorder', () => {
  it('dragging a head to the right half of another column prints `board group order` with every name', () => {
    dragHead('planned', 'done', true);
    expect(order()).toEqual(['in-progress', 'done', 'planned']);
    expect(cmds()).toEqual(["c4mp board group order 'In progress,Done,Planned' --board sprint" + REPO]);
  });

  it('left half goes before; moving back leaves nothing pending', () => {
    dragHead('done', 'planned', false);
    expect(order()).toEqual(['done', 'planned', 'in-progress']);
    dragHead('done', 'in-progress', true);
    expect(order()).toEqual(['planned', 'in-progress', 'done']);
    expect(cmds()).toEqual([]);
  });

  it('adding a group and moving it prints add then order', () => {
    addGroup('Triage');
    dragHead('triage', 'planned', false);
    expect(cmds()).toEqual([
      'c4mp board group add Triage --board sprint' + REPO,
      "c4mp board group order 'Triage,Planned,In progress,Done' --board sprint" + REPO,
    ]);
  });

  it('Alt+Right on a head moves the group one place; a card drag is not taken for a head drag', () => {
    head('planned').dispatch('keydown', { key: 'ArrowRight', altKey: true, target: head('planned'), preventDefault() {} });
    expect(order()).toEqual(['in-progress', 'planned', 'done']);
    const ev = { preventDefault: jest.fn() };
    col('done').dispatch('dragover', ev);   // no drag at all
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('a head dropped on itself changes nothing', () => {
    dragHead('planned', 'planned', true);
    expect(cmds()).toEqual([]);
  });
});
