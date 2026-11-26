import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';

// P16-B32a: Kanban card drag and the pending-commands bar (fake DOM). Drag events are dispatched by hand.

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
const col = (gid: string) => byClass(body(), 'kb-col').find((c: any) => c.dataset.gid === gid);
const cardIds = (gid: string) => byClass(col(gid), 'kb-card').map((c: any) => c.dataset.id);
const card = (id: string) => byClass(body(), 'kb-card').find((c: any) => c.dataset.id === id);
const bar = () => byClass(body(), 'kb-pending')[0];
const cmds = (): string[] => {
  const pre = find(bar(), n => n.tagName === 'PRE')[0];
  return pre ? pre.textContent.split('\n') : [];
};
const button = (label: string) => find(bar(), n => n.tagName === 'BUTTON').find((b: any) => b.textContent === label);

/** a whole drag: dragstart on the card, dragover and drop on the column */
function drag(id: string, gid: string) {
  const dt = { effectAllowed: '', dropEffect: '', setData: jest.fn() };
  card(id).dispatch('dragstart', { dataTransfer: dt });
  const over = { dataTransfer: dt, preventDefault: jest.fn() };
  col(gid).dispatch('dragover', over);
  const dropEv = { dataTransfer: dt, preventDefault: jest.fn() };
  col(gid).dispatch('drop', dropEv);
  return { over, dropEv, dt };
}

const openKanban = () => { B.open(); B.setView('kanban'); };

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  B.setToday(TODAY);
  p.sandbox.C4PM_DATA.repoPath = '/work/repo';
  // module state of board-kanban.js is per page (fresh sandbox), nothing to reset
});

describe('P16-B32a card drag', () => {
  it('no move, no bar content', () => {
    openKanban();
    expect(bar().hidden).toBe(true);
    expect(cmds()).toEqual([]);
  });

  it('dropping on a status group moves the card and prints one set command with --status', () => {
    openKanban();
    const { over, dropEv, dt } = drag('b3', 'in-progress');
    expect(over.preventDefault).toHaveBeenCalled();   // what allows the drop
    expect(dropEv.preventDefault).toHaveBeenCalled();
    expect(dt.effectAllowed).toBe('move');
    expect(cardIds('in-progress').sort()).toEqual(['b1', 'b3']);
    expect(cardIds('planned')).toEqual(['b4', 'b6']);
    expect(card('b3').classList.contains('moved')).toBe(true);
    expect(bar().hidden).toBe(false);
    expect(cmds()).toEqual(['c4mp board set b3 --repo /work/repo --status in-progress --yes']);
    // the saved data is untouched
    expect(B.item('b3').status).toBe('planned');
  });

  it('moving a card and moving it back leaves no pending command', () => {
    openKanban();
    drag('b3', 'done');
    expect(cmds().length).toBe(1);
    drag('b3', 'planned');
    expect(cmds()).toEqual([]);
    expect(bar().hidden).toBe(true);
    expect(card('b3').classList.contains('moved')).toBe(false);
    expect(cardIds('planned')).toEqual(['b3', 'b4', 'b6']);
  });

  it('the drop mark is cleared at dragend and never strips the red overdue chip (found in real Chrome)', () => {
    openKanban();
    const dt = { setData() {} };
    card('b1').dispatch('dragstart', { dataTransfer: dt });
    col('done').dispatch('dragover', { dataTransfer: dt, preventDefault() {} });
    expect(col('done').classList.contains('drop-over')).toBe(true);
    card('b1').dispatch('dragend', {});
    expect(col('done').classList.contains('drop-over')).toBe(false);
    const chip = byClass(card('b4'), 'bd-due')[0];   // b4: planned, due 2026-10-01, today 2026-10-21
    expect(chip.classList.contains('over')).toBe(true);
    drag('b3', 'done');
    card('b3').dispatch('dragend', {});
    expect(byClass(card('b4'), 'bd-due')[0].classList.contains('over')).toBe(true);
  });

  it('dropping on the column the card is already in changes nothing', () => {
    openKanban();
    drag('b3', 'planned');
    expect(cmds()).toEqual([]);
  });

  it('a custom group keeps the status and sets --group; leaving it to a status group sets status and --group none', () => {
    const e = sampleBoard(p.model);
    e.boards[0].groups.push({ id: 'triage', name: 'Needs triage' });
    p = boardPage({ board: () => e });
    B = p.sandbox.C4PM_BOARD;
    B.setToday(TODAY);
    p.sandbox.C4PM_DATA.repoPath = '/work/repo';
    openKanban();
    drag('b1', 'triage');
    expect(cmds()).toEqual(['c4mp board set b1 --repo /work/repo --group triage --yes']);   // status stays in-progress
    expect(cardIds('triage')).toEqual(['b1']);
    drag('b1', 'done');
    expect(cmds()).toEqual(['c4mp board set b1 --repo /work/repo --status done --yes']);   // group never saved: only the status differs
    drag('b1', 'in-progress');
    expect(cmds()).toEqual([]);
  });

  it('a card that is saved in a custom group and leaves it prints --group none', () => {
    const e = sampleBoard(p.model);
    e.boards[0].groups.push({ id: 'triage', name: 'Needs triage' });
    e.boards[0].items[3].group = 'triage';   // b4, status planned
    p = boardPage({ board: () => e });
    B = p.sandbox.C4PM_BOARD;
    p.sandbox.C4PM_DATA.repoPath = '/work/repo';
    openKanban();
    expect(cardIds('triage')).toEqual(['b4']);
    drag('b4', 'planned');
    expect(cmds()).toEqual(['c4mp board set b4 --repo /work/repo --group none --yes']);
    drag('b4', 'done');
    expect(cmds()).toEqual(['c4mp board set b4 --repo /work/repo --status done --group none --yes']);
    drag('b4', 'triage');
    expect(cmds()).toEqual([]);
  });

  it('several moves list several commands; Discard restores the columns and hides the bar', () => {
    openKanban();
    drag('b3', 'done');
    drag('b4', 'in-progress');
    expect(cmds().length).toBe(2);
    expect(bar().children[0].children[0].textContent).toBe('2 pending changes');
    button('Discard').click();
    expect(cmds()).toEqual([]);
    expect(bar().hidden).toBe(true);
    expect(cardIds('planned')).toEqual(['b3', 'b4', 'b6']);
    expect(cardIds('done')).toEqual(['b2']);
  });

  it('a pending move to done unblocks a dependent card; a move away from done blocks it', () => {
    openKanban();
    const blocked = (id: string) => byClass(card(id), 'kb-blocked').length;
    expect(blocked('b3')).toBe(0);   // waits for b2 (done)
    drag('b2', 'planned');
    expect(blocked('b3')).toBe(1);
    button('Discard').click();
    expect(blocked('b3')).toBe(0);
  });

  it('a collapsed strip accepts drops', () => {
    openKanban();
    B.toggleCollapsed('sprint', 'done');
    expect(col('done').classList.contains('closed')).toBe(true);
    drag('b3', 'done');
    expect(cmds()).toEqual(['c4mp board set b3 --repo /work/repo --status done --yes']);
    expect(col('done').classList.contains('closed')).toBe(true);
    expect(cardIds('done').sort()).toEqual(['b2', 'b3']);
  });

  it('an extra (status-only) column is not a drop target; a card can leave it', () => {
    const e = sampleBoard(p.model);
    e.boards[0].items[3].status = 'abandoned';   // b4
    p = boardPage({ board: () => e });
    B = p.sandbox.C4PM_BOARD;
    p.sandbox.C4PM_DATA.repoPath = '/work/repo';
    openKanban();
    const ev = { dataTransfer: {}, preventDefault: jest.fn() };
    card('b3').dispatch('dragstart', { dataTransfer: {} });
    col('status:abandoned').dispatch('dragover', ev);
    col('status:abandoned').dispatch('drop', ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(cmds()).toEqual([]);
    drag('b4', 'planned');
    expect(cmds()).toEqual(['c4mp board set b4 --repo /work/repo --status planned --yes']);
  });

  it('a drop without a card drag, or a card of another board, does nothing', () => {
    openKanban();
    const ev = { preventDefault: jest.fn() };
    col('done').dispatch('dragover', ev);
    col('done').dispatch('drop', ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(cmds()).toEqual([]);
  });

  it('pending moves survive a view switch and a board switch (module state), and the drag ends cleanly', () => {
    openKanban();
    drag('b3', 'done');
    B.setView('list');
    B.setView('kanban');
    expect(cmds().length).toBe(1);
    B.setBoard('backlog');
    expect(cmds().length).toBe(1);   // the bar lists every pending command
    B.setBoard('sprint');
    expect(cardIds('done').sort()).toEqual(['b2', 'b3']);
    card('b1').dispatch('dragstart', { dataTransfer: {} });
    card('b1').dispatch('dragend', {});
    col('done').dispatch('drop', { preventDefault: jest.fn() });   // drag was ended: no drop
    expect(cmds().length).toBe(1);
  });

  it('keyboard: Alt+Right / Alt+Left moves the focused card to the next / previous group, not onto extras', () => {
    openKanban();
    const k = (key: string) => card('b3').dispatch('keydown', { key, altKey: true, target: card('b3'), preventDefault() {} });
    k('ArrowRight');
    expect(cardIds('in-progress')).toContain('b3');
    k('ArrowRight');
    expect(cardIds('done')).toContain('b3');
    k('ArrowRight');   // last column: stays
    expect(cardIds('done')).toContain('b3');
    expect(cmds()).toEqual(['c4mp board set b3 --repo /work/repo --status done --yes']);
    k('ArrowLeft');
    k('ArrowLeft');
    expect(cmds()).toEqual([]);
  });
});

describe('P16-B32a commands are shell safe', () => {
  const e = (title: string) => title;
  it('quotes ids, the repo path and group ids with spaces, quotes, $(), backticks and newlines', () => {
    const nasty = ["it's", 'a b', '$(touch x)', '`id`', 'line1\nline2', '', '; rm -rf /'];
    const board = sampleBoard(p.model);
    const base = board.boards[0].items[3];
    board.boards[0].groups.push(...nasty.map((n, i) => ({ id: n || 'empty' + i, name: 'G' + i })));
    board.boards[0].items = nasty.map((n, i) => ({ ...base, id: 'i' + i, title: e('t' + i), status: 'planned', dependsOn: [], parent: undefined }));
    p = boardPage({ board: () => board });
    B = p.sandbox.C4PM_BOARD;
    p.sandbox.C4PM_DATA.repoPath = "/tmp/my 'repo' $HOME";
    openKanban();
    drag('i0', "it's");
    drag('i1', 'a b');
    drag('i2', '$(touch x)');
    drag('i3', '`id`');
    drag('i4', 'line1\nline2');
    drag('i6', '; rm -rf /');
    const text = find(bar(), n => n.tagName === 'PRE')[0].textContent;
    const q = "'/tmp/my '\\''repo'\\'' $HOME'";
    expect(text).toContain('c4mp board set i0 --repo ' + q + " --group 'it'\\''s' --yes");
    expect(text).toContain("--group 'a b' --yes");
    expect(text).toContain("--group '$(touch x)' --yes");
    expect(text).toContain("--group '`id`' --yes");
    expect(text).toContain("--group 'line1\nline2' --yes");
    expect(text).toContain("--group '; rm -rf /' --yes");
    // every non-plain value is inside single quotes: removing quoted spans leaves no shell metacharacter
    const stripped = text.replace(/'(?:[^']|'\\'')*'/g, '');
    expect(/[$`;()\n]/.test(stripped.replace(/\n(?=c4mp board set )/g, ''))).toBe(false);
  });

  it('a plain id or group id is printed bare; an id like __proto__ works', () => {
    const board = sampleBoard(p.model);
    board.boards[0].items[0] = { ...board.boards[0].items[0], id: '__proto__', title: 'P', parent: undefined, linked: [], links: [] };
    board.boards[0].items = board.boards[0].items.filter((i: any) => !i.parent || i.parent !== 'b1');
    p = boardPage({ board: () => board });
    B = p.sandbox.C4PM_BOARD;
    p.sandbox.C4PM_DATA.repoPath = '/r';
    openKanban();
    drag('__proto__', 'done');
    expect(cmds()).toEqual(['c4mp board set __proto__ --repo /r --status done --yes']);
  });
});

describe('P16-B32a copy', () => {
  const setup = () => { openKanban(); drag('b3', 'done'); };
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('Copy uses navigator.clipboard and says Copied', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    p.sandbox.navigator = { clipboard: { writeText } };
    setup();
    const b = button('Copy commands');
    b.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('c4mp board set b3 --repo /work/repo --status done --yes');
    expect(b.textContent).toBe('Copied');
  });

  it('a rejected clipboard falls back to selecting the text; with no selection API it says Copy failed', async () => {
    p.sandbox.navigator = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } };
    const select = jest.fn();
    p.sandbox.getSelection = () => ({ removeAllRanges: select, addRange: select });
    (p.sandbox.document as any).createRange = () => ({ selectNodeContents: jest.fn() });
    setup();
    const b = button('Copy commands');
    b.click();
    await flush();
    expect(select).toHaveBeenCalled();
    expect(b.textContent).toContain('text selected');
    // no clipboard object at all, no selection API
    delete p.sandbox.navigator;
    delete p.sandbox.getSelection;
    delete (p.sandbox.document as any).createRange;
    b.click();
    await flush();
    expect(b.textContent).toBe('Copy failed');
  });
});
