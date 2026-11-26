import { boardPage, sampleBoard, TODAY } from './helpers/viewer-board-fixture';
import type { BoardPage } from './helpers/viewer-board-fixture';
import { serializeText } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// P16-B23: the detail of a selected b-item in the right panel (fake DOM).

let p: BoardPage;
let B: any;
let M: any;

const panel = () => p.h.panel;
const text = () => serializeText(panel());
const all = (root: FakeEl, cls: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) => (n.children || []).forEach(c => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); });   // text nodes have no children
  walk(root);
  return out;
};
const chipTexts = (root: FakeEl) => all(root, 'pn-dep-chip').map(c => serializeText(c).trim());
const sectionOf = (label: string): FakeEl => all(panel(), 'pn-section').find(s => serializeText(s.children[0]).trim() === label || serializeText(s.children[0]).startsWith(label))!;

beforeEach(() => {
  p = boardPage();
  B = p.sandbox.C4PM_BOARD;
  M = p.sandbox.C4PM_MAP;
  B.setToday(TODAY);
});

describe('P16-B23 b-item panel', () => {
  it('no selected b-item leaves #panel as panel.js drew it', () => {
    const before = text();
    B.open();
    B.close();
    B.toggleCollapsed('sprint', 'planned');
    expect(text()).toBe(before);
    M.select('api/routes');
    const afterC = text();
    B.open();
    expect(text()).toBe(afterC);
  });

  it('b1 shows breadcrumb, title, kind, id, tags, pills and the two linked c-items', () => {
    B.select('b1');
    const t = text();
    expect(t).toContain('Sprint S12');
    expect(t).toContain('Quiz generator');
    expect(all(panel(), 'pn-kind')[0].textContent).toBe('feature');
    expect(all(panel(), 'pn-detail')[0].textContent).toBe('b1 · quiz, api');
    expect(all(panel(), 'pn-badge').map(b => b.textContent)).toEqual(['in-progress', 'Owner: kim']);
    const lights = sectionOf('Lights up');
    expect(serializeText(lights.children[0]).trim()).toBe('Lights up (2 c-items)');
    expect(chipTexts(lights).sort()).toEqual([M.nodeById('api/payments').name, M.nodeById('api/routes').name].sort());
  });

  it('b910: no owner -> a faint "Unassigned" pill; an owner -> the Owner pill only', () => {
    B.select('b2');
    expect(all(panel(), 'bd-unassigned').map(b => b.textContent)).toEqual(['Unassigned']);
    B.select('b1');
    expect(all(panel(), 'bd-unassigned')).toEqual([]);
    expect(all(panel(), 'pn-badge').map(b => b.textContent)).toContain('Owner: kim');
  });

  it('Time block: dates present are shown, absent ones are not; "no dates yet" when none', () => {
    B.select('b1');
    const dts = all(sectionOf('Time'), 'bd-time')[0].children;
    expect(dts.filter(c => c.tagName === 'DT').map(c => c.textContent)).toEqual(['Start', 'Due']);
    expect(serializeText(sectionOf('Time'))).toContain('2026-10-30  (in 9 days)');
    B.select('b2');
    expect(serializeText(sectionOf('Time'))).toContain('Closed');
    expect(serializeText(sectionOf('Time'))).toContain('2026-10-14');   // done: no "overdue" or "in N days"
    expect(serializeText(sectionOf('Time'))).not.toContain('overdue');
    B.select('b5');
    expect(serializeText(sectionOf('Time'))).toContain('no dates yet');
  });

  it('an overdue item says so, once, with the over class; due today and "1 day" wording', () => {
    B.select('b4');
    expect(serializeText(sectionOf('Time'))).toContain('2026-10-01  (20 days overdue)');
    expect(all(sectionOf('Time'), 'over').length).toBe(1);
    B.setToday('2026-10-02');
    B.select('b4');
    expect(serializeText(sectionOf('Time'))).toContain('(1 day overdue)');
    B.setToday('2026-10-01');
    B.select('b4');
    expect(serializeText(sectionOf('Time'))).toContain('(due today)');
    expect(all(sectionOf('Time'), 'over').length).toBe(0);
  });

  it('relations: Part of, Contains, Depends on, Blocks (including across boards); chips select the item', () => {
    B.select('b3');
    expect(chipTexts(sectionOf('Part of'))).toEqual(['b1 Quiz generator']);
    expect(chipTexts(sectionOf('Depends on'))).toEqual(['b2 Define format']);
    expect(chipTexts(sectionOf('Blocks'))).toEqual(['b5 Batch translate']);   // b5 is on another board
    expect(sectionOf('Contains')).toBeUndefined();
    B.select('b1');
    expect(chipTexts(sectionOf('Contains'))).toEqual(['b2 Define format', 'b3 Build makeQuiz']);
    all(sectionOf('Contains'), 'pn-dep-chip')[1].click();
    expect(B.selectedId()).toBe('b3');
    expect(serializeText(panel())).toContain('Build makeQuiz');
  });

  it('breadcrumb walks the parent chain and its crumbs select', () => {
    B.select('b3');
    const crumbs = all(panel(), 'pn-crumb');
    expect(crumbs.map(c => c.textContent)).toEqual(['Quiz generator', 'Build makeQuiz']);
    crumbs[0].click();
    expect(B.selectedId()).toBe('b1');
  });

  it('a dead link is shown with the marker and not counted; a missing dependsOn target is shown dead', () => {
    B.select('b4');
    const lights = sectionOf('Lights up');
    expect(serializeText(lights.children[0]).trim()).toBe('Lights up (1 c-item)');
    const dead = all(lights, 'bd-dead');
    expect(dead.map(d => d.textContent)).toEqual(['✗ gone-uid']);
    const q = boardPage({ board: m => { const b = sampleBoard(m); b.boards[0].items[2].dependsOn = ['ghost']; return b; } });
    (q.sandbox.C4PM_BOARD as any).select('b3');
    expect(serializeText(q.h.panel)).toContain('ghost (missing)');
  });

  it('an item with no links says so and has no Zoom button; one with links has it', () => {
    B.select('b3');
    expect(serializeText(sectionOf('Lights up'))).toContain('no c-items linked');
    expect(all(panel(), 'bd-zoom').length).toBe(0);
    B.select('b1');
    expect(all(panel(), 'bd-zoom').length).toBe(1);
  });

  it('light-up chips only fly (flyTo) and keep the highlight; Zoom calls zoomToLinked', () => {
    const flown: string[] = [];
    M.flyTo = (id: string) => { flown.push(id); };
    B.select('b1');
    all(sectionOf('Lights up'), 'pn-dep-chip')[0].click();
    expect(flown).toEqual(['api/routes']);
    expect(B.selectedId()).toBe('b1');
    expect(M.state.hi.size).toBe(2);
    all(panel(), 'bd-zoom')[0].click();
    expect(flown).toEqual(['api/routes', 'api']);
  });

  it('escape returns the panel to the summary (panel.js, not this file)', () => {
    const summary = text();
    B.select('b1');
    expect(text()).not.toBe(summary);
    B.select(null);
    expect(text()).toBe(summary);
  });

  it('XSS: a title, tag or owner with markup is text only', () => {
    B.select('b6');
    const walk = (n: FakeEl): FakeEl[] => [n, ...(n.children || []).flatMap(walk)];
    const nodes = walk(panel());
    expect(nodes.every(n => !n._html)).toBe(true);                // nothing went in as innerHTML
    expect(nodes.some(n => n.tagName === 'IMG' || n.tagName === 'B' || n.tagName === 'I')).toBe(false);
    const t = text();
    expect(t).toContain('<img src=x onerror=alert(1)>');
    expect(t).toContain('<b>x</b>');
    expect(t).toContain('Owner: <i>o</i>');
  });

  it('a b-item of an archived board can still be selected and shown', () => {
    B.select('b9');
    expect(text()).toContain('Archived item');
  });
});
