import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildView } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult, OpCall } from './helpers/viewer-harness';

// C1 C1 (b833): persons and externals drawn as the Phase 25 demo draws them (render.js drawPerson, drawExternal, shapePath), the
// system open at the C1 Fit on any window shape (camera.js openness), and the tree in plan order (model.ts buildContextRoot).
// Folder-mode greenfield plan, fake DOM. The plan order differs from the id order on purpose: persons zoe, adam; externals
// zbank (planned), abank (done). zoe is done too: a person never shows a pill.

const PLAN = [
  'model {',
  "  zoe = person 'Zoe' {",
  "    metadata { status 'done' owner 'K' }",
  '  }',
  "  adam = person 'Adam' {",
  '  }',
  "  shop = system 'Shop' {",
  "    api = container 'API' {",
  "      orders = component 'Orders' {",
  '      }',
  '    }',
  "    web = container 'Web' {",
  '    }',
  '  }',
  "  zbank = external 'Zed bank' {",
  "    metadata { status 'planned' }",
  '  }',
  "  abank = external 'A bank' {",
  "    technology 'Card API'",
  "    metadata { status 'done' owner 'K' }",
  '  }',
  "  zoe -> shop.api.orders 'buys'",
  "  zoe -> shop.api 'pays'",   // C1 D1 (b835): merges with 'buys' into one arrow at C1 (both roll up to shop.api)
  "  adam -> shop.web 'reads'",
  "  shop.api.orders -> zbank 'charges'",
  "  shop.api -> abank 'logs'",
  '}',
].join('\n');

const PERSON = '#11AA01', EXTERNAL = '#22AA02', EXT_LINE = '#33AA03', ACTOR_INK = '#44AA04', ACCENT = '#ACC0FF', BGLOW = '#FFB020';
const COLORS: Record<string, string> = {
  '--accent': ACCENT, '--person': PERSON, '--external': EXTERNAL, '--external-line': EXT_LINE, '--actor-ink': ACTOR_INK,
};

// C1 C2 (b834): the same plan plus a person with plan metadata shape 'robot' (an AI agent)
const ROBOT_PLAN = PLAN.replace('model {', "model {\n  bot = person 'Bot' {\n    metadata { shape 'robot' }\n  }\n  bot -> shop.api 'runs'");

const dirs: string[] = [];
function pageOf(plan: string, name = 'c1-actors'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-c1-actors-')));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, 'plans'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'plans', 'shop.c4'), plan);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  return buildView({ repo: dir }).html;
}
let page: string;
let robotPage: string;
beforeAll(() => {
  page = pageOf(PLAN);
  robotPage = pageOf(ROBOT_PLAN);
});
afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

interface Arc { x: number; y: number; r: number }
interface Frame { ops: OpCall[]; text: string[]; arcs: Arc[]; dashes: Array<{ dash: number[]; style: string }> }

function load(size?: { cw: number; ch: number }, html = page): { h: HarnessResult; w: any; frame: () => Frame } {
  const getComputedStyle = () => ({ getPropertyValue: (k: string) => COLORS[k] ?? '#888888' });
  const h = runViewerScripts(html, { extraIds: ['btn-gear', 'settings-pop'], globals: { getComputedStyle, location: { href: 'file:///x.html#arch', hash: '#arch' } } });
  const w = h.sandbox.window as any;
  if (size) {   // another window shape, then Fit again (map.js fitRoot: fitCam(root, 0.85))
    const map = w.C4PM_STATE.map;
    Object.assign(map, size);
    map.cam = w.C4PM_CAM.fitCam(w.C4PM_DATA.root, 0.85);
  }
  h.frames.runToCompletion();
  for (let i = 0; i < 60; i++) h.frames.flush();
  const frame = (): Frame => {
    const ctx = w.C4PM_STATE.map.ctx;
    const arcs: Arc[] = [];
    const dashes: Array<{ dash: number[]; style: string }> = [];
    ctx.arc = (x: number, y: number, r: number) => { arcs.push({ x, y, r }); };
    ctx.setLineDash = (d: number[]) => { dashes.push({ dash: d.slice(), style: String(ctx.strokeStyle) }); };
    h.opLog.length = 0;
    h.fillTextLog.length = 0;
    w.C4PM_MAP.draw();
    return { ops: h.opLog.slice(), text: h.fillTextLog.slice(), arcs, dashes };
  };
  return { h, w, frame };
}
const node = (w: any, id: string) => w.C4PM_STATE.nodeById[id];
const system = (w: any) => w.C4PM_DATA.root.children.find((c: any) => c.kind === 'system');   // folder mode: id '<project>::system'
/** The arc of a person's head (or of a ring around it, grown by d), from its drawn rect. */
const head = (R: { x: number; y: number; w: number; h: number }, d = 0): Arc => ({ x: R.x + R.w / 2, y: R.y + R.h * 0.2, r: R.h * 0.2 + d });
const near = (a: Arc, b: Arc) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.r - b.r) < 1e-6;

describe('C1 C1 (b833): the tree follows the plan order', () => {
  it('top rows: persons, the system, externals, each group in declaration order (not by id)', () => {
    const { w } = load();
    const rows = (w.document.getElementById('left').querySelectorAll('.lt-row') as any[])
      .filter(r => r.dataset.id && r.style.paddingLeft === '8px').map(r => r.dataset.id);
    const sys = w.C4PM_DATA.root.children.find((c: any) => c.kind === 'system').id;
    expect(rows).toEqual(['zoe', 'adam', sys, 'zbank', 'abank']);
    expect(w.C4PM_DATA.root.children.map((c: any) => c.id)).toEqual(['zoe', 'adam', sys, 'zbank', 'abank']);
  });
});

describe('C1 C1 (b833): a person is a head and a body, with no pill', () => {
  it('one head arc per person on its rect, filled in the person colour; the name and "person" in the actor ink; no status pill', () => {
    const { w, frame } = load();
    const f = frame();
    ['zoe', 'adam'].forEach(id => expect(f.arcs.filter(a => near(a, head(node(w, id)._R)))).toHaveLength(1));
    expect(f.ops.filter(o => o.op === 'fill' && o.style === PERSON)).toHaveLength(2);
    expect(f.text).toEqual(expect.arrayContaining(['Zoe', 'Adam']));
    expect(f.text.filter(t => t === 'person')).toHaveLength(2);
    expect(f.text).not.toContain('Done');   // zoe is done: no pill on a person
  });

  it('too small for text inside: the name goes below the figure', () => {
    const { w, frame } = load();
    const map = w.C4PM_STATE.map;
    map.cam = { ...map.cam, s: map.cam.s * 0.15 };
    const f = frame();
    expect(f.text).toEqual(expect.arrayContaining(['Zoe', 'Adam']));
    expect(f.text).not.toContain('person');
  });

  it('selected: an accent ring around the head and the body (3 px out); a click on the head selects the person', () => {
    const { w, frame } = load();
    const R = node(w, 'zoe')._R;
    expect(w.C4PM_CAM.hitTest(R.x + R.w / 2, R.y + R.h * 0.2)).toBe(node(w, 'zoe'));
    w.C4PM_MAP.select('zoe');
    const f = frame();
    expect(f.arcs.filter(a => near(a, head(R, 3)))).toHaveLength(1);
    expect(f.ops.some(o => o.op === 'stroke' && o.style === ACCENT)).toBe(true);
  });

  it('the board ring follows the figure: a lit person gets an arc 4 px around its head', () => {
    const { w, frame } = load();
    w.C4PM_STATE.map.hi = new Set(['zoe']);
    const f = frame();
    const R = node(w, 'zoe')._R;
    expect(f.arcs.filter(a => near(a, head(R, 4)))).toHaveLength(1);
    expect(f.ops.some(o => o.op === 'stroke' && o.style === BGLOW)).toBe(true);
  });
});

describe('C1 C1 (b833): an external is a dashed box with only a Planned pill', () => {
  it('filled in the external colour, dashed [5, 3] in the external line colour, the technology, else "external system" (C3 b838); Planned on zbank only', () => {
    const { frame } = load();
    const f = frame();
    expect(f.ops.filter(o => o.op === 'fill' && o.style === EXTERNAL)).toHaveLength(2);
    expect(f.dashes.filter(d => d.style === EXT_LINE && d.dash.join(',') === '5,3')).toHaveLength(2);
    expect(f.ops.filter(o => o.op === 'stroke' && o.style === EXT_LINE)).toHaveLength(2);
    expect(f.text.filter(t => t === 'external system')).toHaveLength(1);   // zbank: no technology
    expect(f.text).toContain('Card API');                                 // abank: its technology (C3 b838)
    expect(f.text.filter(t => t === 'Planned')).toHaveLength(1);
    expect(f.text).not.toContain('Done');   // abank is done: an external shows only Planned
    expect(f.text).toEqual(expect.arrayContaining(['Zed bank', 'A bank']));
  });
});

describe('C1 C1 (b833): the system is open at the C1 Fit on any window shape', () => {
  const shapes = [{ cw: 1300, ch: 950 }, { cw: 830, ch: 760 }, { cw: 2200, ch: 520 }, { cw: 500, ch: 1400 }];
  it.each(shapes)('%o: the system is fully open, the containers are closed, the persons are bubbles', (size) => {
    const { w } = load(size);
    const CAM = w.C4PM_CAM;
    expect(CAM.openness(system(w))).toBe(1);
    expect(CAM.openness(node(w, 'shop.api'))).toBe(0);
  });

  it('zoomed out past the C1 picture (Up: fitCam(root, 0.3)) the system closes again', () => {
    const { w } = load();
    const map = w.C4PM_STATE.map;
    map.cam = w.C4PM_CAM.fitCam(w.C4PM_DATA.root, 0.3);
    expect(w.C4PM_CAM.openness(system(w))).toBe(0);
  });
});

// C1 D1 (b835): at the C1 Fit the arrows that touch a person or external show the plan relation labels; two relations that roll
// up into one arrow (zoe -> shop.api.orders 'buys', zoe -> shop.api 'pays') show the first label plus " +1" (K's Q1), and the
// hover title (map.edgeLabels) lists both.
describe('C1 D1 (b835): relation labels on the arrows of persons and externals', () => {
  it('each actor arrow shows its label; the merged one "buys +1" with both labels in the hover title; no count on them', () => {
    const { w, frame } = load();
    const f = frame();
    expect(f.text).toEqual(expect.arrayContaining(['buys +1', 'reads', 'charges', 'logs']));
    expect(f.text).not.toContain('pays');
    expect(f.text.filter(t => /^\d+$/.test(t))).toEqual([]);
    expect(w.C4PM_STATE.map.edgeLabels).toEqual(expect.arrayContaining([expect.objectContaining({ full: 'buys\npays' })]));
  });

  it('labelText: the first label plus " +N", the first cut so the whole text fits; one label alone; empty when nothing fits', () => {
    const { w } = load();
    const { labelText } = w.C4PM_RENDER.edges;
    const ctx = { measureText: (s: string) => ({ width: String(s).length * 6 }) };
    expect(labelText(ctx, ['Browses and buys'], 200)).toBe('Browses and buys');
    expect(labelText(ctx, ['HTTPS /api/v1', 'a', 'b', 'c', 'd', 'e', 'f'], 200)).toBe('HTTPS /api/v1 +6');
    const cut = labelText(ctx, ['HTTPS /api/v1', 'a', 'b'], 90);
    expect(cut).toMatch(/^HTTPS.*… \+2$/);
    expect(cut.length * 6).toBeLessThanOrEqual(90);
    expect(labelText(ctx, ['HTTPS /api/v1', 'a'], 40)).toBe('');
  });
});

// C1 D2 (b836): relation labels are drawn last (map.js pass 4, render.js drawLabels), after the bubbles, at the first spot along the
// arrow (t = 0.5, 0.4, 0.6, ...) that is off every drawn box and every earlier label; a label with no free spot is left out.
// Count labels keep today's inline path (drawEdges, the middle of the arrow, before the bubbles).
describe('C1 D2 (b836): labels drawn last, off every box', () => {
  interface Rect { x: number; y: number; w: number; h: number }
  const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  /** One frame: every fillText with its centre, the bubbles drawLabels got, and the fillText count when drawLabels started. */
  function shoot(w: any) {
    const map = w.C4PM_STATE.map, ctx = map.ctx, E = w.C4PM_RENDER.edges;
    const texts: Array<{ s: string; x: number; y: number }> = [];
    let bubbles: Array<{ R: Rect; a: number }> = [];
    let mark = -1;
    ctx.fillText = (s: string, x: number, y: number) => { texts.push({ s: String(s), x, y }); };
    const orig = E.drawLabels;
    E.drawLabels = (b: Array<{ R: Rect; a: number }>) => { bubbles = b; mark = texts.length; orig(b); };
    w.C4PM_MAP.draw();
    E.drawLabels = orig;
    // the label box drawLabelBox draws around a text (harness measureText: 6 px a character; + 12 px padding; 20 px high)
    const box = (t: { s: string; x: number; y: number }): Rect => ({ x: t.x - (t.s.length * 6 + 12) / 2, y: t.y - 0.5 - 10, w: t.s.length * 6 + 12, h: 20 });
    return { texts, bubbles, mark, box };
  }
  const LABELS = ['buys +1', 'reads', 'charges', 'logs'];

  it.each([{ cw: 1300, ch: 950 }, { cw: 830, ch: 760 }, { cw: 2200, ch: 520 }])('%o: every relation label is drawn after the bubbles and overlaps no drawn box and no other label', (size) => {
    const { w } = load(size);
    const { texts, bubbles, mark, box } = shoot(w);
    const drawn = texts.filter(t => LABELS.includes(t.s));
    expect(drawn.length).toBeGreaterThan(0);
    expect(texts.slice(0, mark).filter(t => LABELS.includes(t.s))).toEqual([]);   // none before pass 4
    const boxes = bubbles.filter(b => b.a >= 0.01).map(b => b.R);
    expect(boxes.length).toBeGreaterThanOrEqual(6);   // 2 persons, 2 externals, the closed containers
    drawn.forEach(t => boxes.forEach(b => expect(hits(box(t), b)).toBe(false)));
    drawn.forEach((t, i) => drawn.slice(i + 1).forEach(u => expect(hits(box(t), box(u))).toBe(false)));
    // the boxes are the drawn ones: each person's and external's rect is among them
    ['zoe', 'adam', 'zbank', 'abank'].forEach(id => expect(boxes).toContainEqual(node(w, id)._R));
  });

  it('a label whose spot is taken moves along its arrow; a label with no free spot is left out', () => {
    const { w } = load();
    const E = w.C4PM_RENDER.edges, map = w.C4PM_STATE.map;
    const { texts, box } = shoot(w);
    const first = texts.find(t => t.s === 'reads')!;
    expect(first).toBeDefined();
    const again = (boxes: Rect[]) => {
      const out: Array<{ s: string; x: number; y: number }> = [];
      map.ctx.fillText = (s: string, x: number, y: number) => { out.push({ s: String(s), x, y }); };
      E.drawEdges(0);
      E.drawLabels(boxes.map(R => ({ n: {}, R, a: 1 })));
      return out;
    };
    const block = box(first);   // a box where 'reads' was: it goes to another spot on its arrow, off that box
    const moved = again([block]).find(t => t.s === 'reads')!;
    expect(moved).toBeDefined();
    expect(moved.x !== first.x || moved.y !== first.y).toBe(true);
    expect(hits(box(moved), block)).toBe(false);
    const all = again([{ x: -1e5, y: -1e5, w: 2e5, h: 2e5 }]);   // one box over the whole screen: no free spot anywhere
    expect(all.filter(t => LABELS.includes(t.s))).toEqual([]);
  });

  // b841: the open system's header text ("Shop  C1 SYSTEM") is no free spot either: drawRegion records its rects in map.headerRects
  // (reset each frame beside map.opens) and drawLabels keeps off them, as off the bubbles.
  it('b841: a label keeps off the header text of an open region', () => {
    const { w } = load();
    const map = w.C4PM_STATE.map, E = w.C4PM_RENDER.edges;
    const { texts, box } = shoot(w);
    const sys = node(w, w.C4PM_DATA.root.children.find((c: any) => c.kind === 'system').id)._R;
    expect(map.headerRects.length).toBeGreaterThan(0);   // the open system's name and kind word
    expect(map.headerRects.some((r: Rect) => r.x >= sys.x && r.y >= sys.y && r.y < sys.y + sys.h / 4)).toBe(true);
    texts.filter(t => LABELS.includes(t.s)).forEach(t => map.headerRects.forEach((r: Rect) => expect(hits(box(t), r)).toBe(false)));
    const first = texts.find(t => t.s === 'reads')!;
    map.headerRects = [box(first)];   // a header where 'reads' was: it moves along its arrow, off that header
    const out: Array<{ s: string; x: number; y: number }> = [];
    map.ctx.fillText = (s: string, x: number, y: number) => { out.push({ s: String(s), x, y }); };
    E.drawEdges(0);
    E.drawLabels([]);
    const moved = out.find(t => t.s === 'reads')!;
    expect(moved).toBeDefined();
    expect(hits(box(moved), box(first))).toBe(false);
  });

  it('a count label keeps its inline path: drawn by drawEdges at the middle of the arrow, before the bubbles', () => {
    const { w } = load();
    w.C4PM_DATA.edges.push({ from: 'shop.api', to: 'shop.web', weight: 3 });   // a code arrow inside the system
    const { texts, mark } = shoot(w);
    const i = texts.findIndex(t => t.s === '3');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(mark);
  });
});

// C1 C2 (b834): a person whose plan metadata has shape 'robot' gets a square head (the same size as the round one), and every
// ring around it (selection, board, simulation: render.js shapePath) is square at the head too.
describe('C1 C2 (b834): a robot person has a square head', () => {
  it('the model carries meta.shape; the robot draws no head arc but a rounded square at the head, the others keep the circle', () => {
    const { h, w, frame } = load(undefined, robotPage);
    expect(node(w, 'bot').meta).toMatchObject({ shape: 'robot' });
    h.pathLog.length = 0;
    const f = frame();
    const R = node(w, 'bot')._R, hr = R.h * 0.2, hx = R.x + R.w / 2;
    expect(f.arcs.filter(a => Math.abs(a.x - hx) < 1e-6)).toEqual([]);   // no arc on the robot's centre line
    // rr(hx - hr, R.y, 2 hr, 2 hr, hr / 4) starts at (hx - hr + hr / 4, R.y)
    expect(h.pathLog.some(p => p.op === 'moveTo' && Math.abs(p.x - (hx - hr + hr * 0.25)) < 1e-6 && Math.abs(p.y - R.y) < 1e-6)).toBe(true);
    ['zoe', 'adam'].forEach(id => expect(f.arcs.filter(a => near(a, head(node(w, id)._R)))).toHaveLength(1));
    expect(f.text.filter(t => t === 'person')).toHaveLength(3);
  });

  it('selected: the accent ring is square at the head too (3 px out)', () => {
    const { h, w, frame } = load(undefined, robotPage);
    w.C4PM_MAP.select('bot');
    h.pathLog.length = 0;
    const f = frame();
    const R = node(w, 'bot')._R, hr = R.h * 0.2, hx = R.x + R.w / 2;
    expect(f.arcs.filter(a => Math.abs(a.x - hx) < 1e-6)).toEqual([]);
    expect(h.pathLog.some(p => p.op === 'moveTo' && Math.abs(p.x - (hx - hr - 3 + hr * 0.25 + 3)) < 1e-6 && Math.abs(p.y - (R.y - 3)) < 1e-6)).toBe(true);
  });
});

// C1 B2 (b832): the holder is not a level. buildParents marks it (n.holder, root only); edit.js isTop is true for its children
// (the system and every actor), so edit mode gives the open system no resize grips (render.js drawHandles).
describe('C1 B2 (b832): edit mode ignores the holder, the system and the actors', () => {
  it('holder set on the root only; isTop true for the system and each actor, false for a container; no grip on the open system', () => {
    const { w, frame } = load();
    const root = w.C4PM_DATA.root, E = w.C4PM_EDIT;
    expect(root.holder).toBe(true);
    const all: any[] = [];
    const walk = (n: any) => { all.push(n); (n.children || []).forEach(walk); };
    walk(root);
    expect(all.filter(n => n.holder).map(n => n.id)).toEqual([root.id]);
    [system(w), node(w, 'zoe'), node(w, 'adam'), node(w, 'zbank'), node(w, 'abank')].forEach(n => expect(E.isTop(n)).toBe(true));
    expect(E.isTop(node(w, 'shop.api'))).toBe(false);

    w.C4PM_MAP.setEdit(true);
    expect(w.C4PM_STATE.map.edit).toBe(true);
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    w.C4PM_STATE.map.ctx.fillRect = (x: number, y: number, rw: number, rh: number) => { rects.push({ x, y, w: rw, h: rh }); };
    frame();
    expect(w.C4PM_STATE.map.opens).toContain(system(w));   // drawHandles visits the open system
    const R = system(w)._R;
    const grip = (r: { x: number; y: number; w: number; h: number }) =>   // render.js drawHandles: right-edge grip 10 x 28
      Math.abs(r.x - (R.x + R.w - 5)) < 1e-6 && Math.abs(r.y - (R.y + R.h / 2 - 14)) < 1e-6 && r.w === 10 && r.h === 28;
    expect(rects.filter(grip)).toEqual([]);
  });
});

// b837: a second plan system (bank, holding its ledger) beside ours. The repo is named shop, so the plan system shop is ours
// (mapNodeToElement, as the system title); bank is outside: a closed bubble with its name at the C1 Fit, a top tree row after ours.
describe('b837: another plan system at C1', () => {
  const BANK_PLAN = PLAN.replace(/\}\s*$/, [
    "  bank = system 'Bank' {",
    "    ledger = container 'Ledger' {",
    '    }',
    '  }',
    "  shop.api -> bank 'posts'",
    "  shop.web -> bank.ledger 'reads'",
    '}',
  ].join('\n'));
  let bankPage: string;
  beforeAll(() => { bankPage = pageOf(BANK_PLAN, 'shop'); });

  it('at the C1 Fit our system is open and bank is a closed bubble drawn with its name; its arrow carries its label', () => {
    const { w, frame } = load(undefined, bankPage);
    const CAM = w.C4PM_CAM;
    const ours = system(w);
    expect(ours.name).toBe('Shop');
    expect(CAM.openness(ours)).toBe(1);
    const bank = node(w, 'bank');
    expect(bank).toMatchObject({ kind: 'system', name: 'Bank' });
    expect(bank.children.map((c: any) => c.id)).toEqual(['bank.ledger']);
    expect(CAM.openness(bank)).toBe(0);
    const f = frame();
    expect(f.text).toContain('Bank');
    expect(f.text).toContain('posts');
  });

  it('tree rows: persons, our system, Bank, then the externals', () => {
    const { w } = load(undefined, bankPage);
    const rows = (w.document.getElementById('left').querySelectorAll('.lt-row') as any[])
      .filter(r => r.dataset.id && r.style.paddingLeft === '8px').map(r => r.dataset.id);
    expect(rows).toEqual(['zoe', 'adam', system(w).id, 'bank', 'zbank', 'abank']);
  });
});
