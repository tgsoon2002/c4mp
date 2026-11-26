import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { CLASSES } from './helpers/storage-view';
import { simHtml } from './helpers/sim-view';

// Phase 25 UI11 (b761): the storage view with a selected s-item (viewer/storageView.js setSample, draw, drawSample; sim.js
// sampleSizes -> setSample on select / clear). The page is simHtml() opened at #storage (test/helpers/sim-view.ts): s-1 names
// the record classes at step 5 (target + rows [c-1 Yoga 10]) and step 6 (rows [c-1 Yoga 9, c-2 Pilates 12]), so classes holds
// 2 sample rows; no other record has rows.

const BGLOW = '#FFB020', BGLOW_INK = '#2A1D00';
const FLOW = '#0E9F01', ADDED = '#0A0A01', CHANGED = '#0C0C01', PANEL = '#F0F0F3', PANEL2 = '#E0E0E3', ACCENT = '#ACC0FF';
const COLORS: Record<string, string> = {
  '--accent': ACCENT, '--muted': '#B30003', '--edge': '#E10004', '--c2': '#C20002', '--screen': '#5B4FC9',
  '--flow': FLOW, '--added': ADDED, '--changed': CHANGED, '--panel': PANEL, '--panel2': PANEL2,
};
const SRH = 17, SHEAD = 20;
const sampleH = (n: number) => (n ? SHEAD + (n + 1) * SRH + 8 : 0);

function load(): HarnessResult {
  const getComputedStyle = () => ({ getPropertyValue: (k: string) => COLORS[k] ?? '#888888' });
  return runViewerScripts(simHtml(), {
    extraIds: ['btn-gear', 'settings-pop'],
    globals: { getComputedStyle, location: { href: 'file:///x.html#storage', hash: '#storage' } },
  });
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const V = (h: HarnessResult) => win(h).C4PM_STORAGEVIEW;
type Rect = { x: number; y: number; w: number; h: number };
const recordIds = (h: HarnessResult): string[] => {
  const out: string[] = [];
  (function walk(n: any) { if (n.kind === 'record') out.push(n.id); (n.children || []).forEach(walk); })(win(h).C4PM_DATA.storageView.root);
  return out;
};
const rects = (h: HarnessResult): Record<string, Rect> => Object.fromEntries(recordIds(h).map(id => [id, V(h).rect(id)]));

type Op = { op: string; style: string; lineWidth: number; alpha: number; shadowBlur: number; text?: string; font?: string };
/** One storageView.draw into a recording ctx (save / restore keep a state stack); map.sim is the page's own (sim.js). */
function drawOnce(h: HarnessResult, opts: { selectedId?: string | null; s?: number; sim?: unknown } = {}) {
  const ops: Op[] = [];
  let state: Record<string, any> = { globalAlpha: 1, font: '', lineWidth: 1, shadowBlur: 0 };
  const stack: Record<string, any>[] = [];
  const rec = (op: string, style: unknown, extra: Partial<Op> = {}) =>
    ops.push({ op, style: String(style), lineWidth: Number(state.lineWidth), alpha: Number(state.globalAlpha), shadowBlur: Number(state.shadowBlur || 0), ...extra });
  const ctx: any = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'save') return () => { stack.push({ ...state }); };
      if (k === 'restore') return () => { state = stack.pop() || state; };
      if (k === 'fillText') return (q: string) => rec('text', state.fillStyle, { text: String(q), font: String(state.font) });
      if (k === 'fill') return () => rec('fill', state.fillStyle);
      if (k === 'stroke') return () => rec('stroke', state.strokeStyle);
      if (k === 'fillRect') return () => rec('fillRect', state.fillStyle);
      if (k === 'measureText') return (q: string) => ({ width: String(q).length * (parseFloat(String(state.font).split(' ')[1]) || 10) * 0.55 });
      if (k in state) return state[k];
      return () => undefined;
    },
    set: (_t, k: string, v) => { state[k] = v; return true; },
  });
  const ST = win(h).C4PM_STATE;
  const map: any = {
    ctx, cam: { s: opts.s ?? 1, tx: 100, ty: 100 }, cw: 1e6, ch: 1e6, selectedId: opts.selectedId ?? null, hi: null,
    sim: opts.sim === undefined ? ST.map.sim : opts.sim,
  };
  V(h).draw(map, win(h).C4PM_RENDER.theme.readColors(), 0);
  return { ops, texts: ops.filter(o => o.op === 'text').map(o => o.text as string) };
}
/** Record titles (font 600 15px) drawn at full alpha. */
const litNames = (ops: Op[]) => ops.filter(o => o.op === 'text' && (o.font || '').startsWith('600 15px') && o.alpha === 1).map(o => o.text).sort();
const rings = (ops: Op[]) => ops.filter(o => o.op === 'stroke' && o.style === BGLOW);
const label = (texts: string[]) => texts.filter(t => /^(rows|no rows yet) · /.test(t));

describe('setSample: the cards make room for the sample rows', () => {
  it('select grows only classes by sampleH(2) and moves the records below it; the SAME nodes; clear restores every rect', () => {
    const h = load();
    expect(win(h).C4PM_MODE.get()).toBe('storage');
    const before = rects(h), root0 = V(h).bounds();
    const node = win(h).C4PM_STATE.nodeById[CLASSES];
    SIM(h).select('s-1');
    const after = rects(h), grow = sampleH(2);
    expect(after[CLASSES].h - before[CLASSES].h).toBe(grow);
    expect(win(h).C4PM_STATE.nodeById[CLASSES]).toBe(node);   // laid out in place: map.js nodeById stays valid
    expect([node.h, node.bubble.h]).toEqual([after[CLASSES].h, after[CLASSES].h]);
    const c = before[CLASSES];
    let moved = 0;
    recordIds(h).filter(id => id !== CLASSES).forEach(id => {
      const b = before[id], a = after[id];
      expect(a.h).toBe(b.h);
      if (b.x === c.x && b.y > c.y) { expect(a.y - b.y).toBe(grow); moved++; }   // below classes in its column
      else if (b.x === c.x) expect(a.y).toBe(b.y);
    });
    expect(moved).toBeGreaterThan(0);
    expect(V(h).bounds().h).toBeGreaterThanOrEqual(root0.h);
    SIM(h).select(null);
    expect(rects(h)).toEqual(before);
    expect(V(h).bounds()).toEqual(root0);
  });

  it('setSample by hand: unknown ids and 0 change nothing; null clears', () => {
    const h = load();
    const before = rects(h);
    V(h).setSample({ nope: 3, [CLASSES]: 0 });
    expect(rects(h)).toEqual(before);
    V(h).setSample({ [CLASSES]: 1 });
    expect(V(h).rect(CLASSES).h - before[CLASSES].h).toBe(sampleH(1));
    V(h).setSample(null);
    expect(rects(h)).toEqual(before);
  });
});

describe('draw with a selected s-item', () => {
  it('nothing selected: the records the s-item names are lit, the rest dimmed; a selection wins over the sim', () => {
    const h = load();
    expect(litNames(drawOnce(h).ops).length).toBeGreaterThan(1);   // no s-item: nothing dims
    SIM(h).select('s-1');
    expect(litNames(drawOnce(h).ops)).toEqual(['classes']);
    const sel = drawOnce(h, { selectedId: recordIds(h).find(id => id !== CLASSES) });
    expect(litNames(sel.ops)).not.toContain('classes');
    expect(rings(sel.ops)).toEqual([]);
    expect(label(sel.texts)).toEqual([]);
  });

  it('a map.sim computed for another view draws nothing of the sim', () => {
    const h = load();
    SIM(h).select('s-1');
    const sim = { ...win(h).C4PM_STATE.map.sim, view: 'arch' };
    const { ops, texts } = drawOnce(h, { sim });
    expect(litNames(ops).length).toBeGreaterThan(1);
    expect(rings(ops)).toEqual([]);
    expect(label(texts)).toEqual([]);
  });

  it('ring + pill: whole path ring 2.5, teal pill "5 · 6"; on the current step ring 4 with glow, amber pill with BGLOW_INK', () => {
    const h = load();
    SIM(h).select('s-1');
    const whole = drawOnce(h);
    expect(rings(whole.ops)).toHaveLength(1);
    expect(rings(whole.ops)[0]).toMatchObject({ lineWidth: 2.5, shadowBlur: 0, alpha: 1 });
    const pill = whole.ops.find(o => o.op === 'text' && o.text === '5 · 6')!;
    expect(pill).toMatchObject({ style: PANEL });
    expect(pill.font).toMatch(/^700 11\.5px /);
    expect(whole.ops.some(o => o.op === 'fill' && o.style === FLOW)).toBe(true);
    SIM(h).go(4);
    const cur = drawOnce(h);
    expect(rings(cur.ops)[0]).toMatchObject({ lineWidth: 4, shadowBlur: 12 });
    expect(cur.ops.find(o => o.op === 'text' && o.text === '5 · 6')).toMatchObject({ style: BGLOW_INK });
    expect(cur.ops.some(o => o.op === 'fill' && o.style === BGLOW)).toBe(true);
    // zoomed out: the pill keeps 11.5 px on screen (world size 11.5 / s)
    expect(drawOnce(h, { s: 0.5 }).ops.find(o => o.text === '5 · 6')!.font).toMatch(/^700 23px /);
  });

  it.each([
    [null, 'rows · end of s-1 · as after step 6'],
    [2, 'no rows yet · step 3'],
    [4, 'rows · step 5 · changed here'],
    [5, 'rows · step 6 · changed here'],
    [6, 'rows · step 7 · as after step 6'],
  ])('cursor %s: the label "%s"', (i, text) => {
    const h = load();
    SIM(h).select('s-1');
    if (i !== null) SIM(h).go(i);
    expect(label(drawOnce(h).texts)).toEqual([text]);
  });

  it('"unchanged": the rows of this step equal the step before', () => {
    const h = load();
    SIM(h).select('s-1');
    SIM(h).go(5);
    const sim = win(h).C4PM_STATE.map.sim;
    const tables = { [CLASSES]: { ...sim.tables[CLASSES], touched: false, rows: sim.tables[CLASSES].rows.map((r: any) => ({ ...r, ins: false, old: {} })) } };
    const { ops, texts } = drawOnce(h, { sim: { ...sim, tables } });
    expect(label(texts)).toEqual(['rows · step 6 · unchanged']);
    expect(texts).not.toContain('+');
    expect(ops.find(o => o.text === 'rows · step 6 · unchanged')).toMatchObject({ style: COLORS['--muted'] });
  });

  it('step 5: a new row gets the green tint and "+"; step 6: the changed cell "10→9" bold on amber, the new c-2 row "+"', () => {
    const h = load();
    SIM(h).select('s-1');
    SIM(h).go(4);
    const s5 = drawOnce(h);
    expect(s5.texts.filter(t => t === '+')).toHaveLength(1);
    expect(s5.ops.some(o => o.op === 'fillRect' && o.style === ADDED && Math.abs(o.alpha - 0.22) < 1e-9)).toBe(true);
    expect(s5.texts).toEqual(expect.arrayContaining(['id', 'name', 'seats', 'c-1', 'Yoga', '10']));
    expect(s5.ops.find(o => o.text === 'rows · step 5 · changed here')).toMatchObject({ style: FLOW });
    expect(s5.ops.some(o => o.op === 'fillRect' && o.style === PANEL2)).toBe(true);   // the rows band
    SIM(h).go(5);
    const s6 = drawOnce(h);
    const chg = s6.ops.find(o => o.text === '10→9')!;
    expect(chg.font).toMatch(/^700 10\.5px /);
    expect(s6.ops.some(o => o.op === 'fillRect' && o.style === CHANGED && Math.abs(o.alpha - 0.4) < 1e-9)).toBe(true);
    expect(s6.texts.filter(t => t === '+')).toHaveLength(1);   // c-2 is new; c-1 is changed, not new
    expect(s6.texts).toEqual(expect.arrayContaining(['c-2', 'Pilates', '12']));
    expect(s6.ops.find(o => o.text === 'c-2')!.font).toMatch(/^400 10\.5px /);
  });

  it('rows not readable (zoomed out): no sample rows, the ring and the pill stay', () => {
    const h = load();
    SIM(h).select('s-1');
    SIM(h).go(5);
    const { ops, texts } = drawOnce(h, { s: 0.3 });
    expect(label(texts)).toEqual([]);
    expect(texts).not.toContain('10→9');
    expect(rings(ops)).toHaveLength(1);
    expect(texts).toContain('5 · 6');
  });
});
