import * as fs from 'fs';
import * as path from 'path';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { storageModel, drizzleStorageView, CLASSES, ENROLLMENTS, CLASS_ID, CLASSES_ID } from './helpers/storage-view';
import type { ViewModel } from '../src/types';

// STOR-6a (b339): viewer/storageView.js in the fake DOM: registration, the #storage tree, layout, hit, selection light, arrows.

type Rect = { x: number; y: number; w: number; h: number };

function page(model: ViewModel, hash = '#storage') {
  const loc = { href: 'file:///x.html' + hash, hash };
  const h = runViewerScripts(renderViewHtml(model), { extraIds: ['btn-gear', 'settings-pop'], globals: { location: loc } });
  const w = h.sandbox.window as any;
  return { h, w, V: w.C4PM_STORAGEVIEW, loc };
}
const all = (n: any): any[] => [n, ...(n.children || []).flatMap(all)];

// One draw into a recording ctx: every fillText with its font and alpha.
function drawOnce(w: any, opts: { selectedId?: string | null; hi?: Set<string> | null; s?: number } = {}) {
  const texts: { text: string; font: string; alpha: number; x: number; y: number; align: string }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, font: '' };
  const ctx: any = new Proxy(state, {
    get: (t, k: string) => {
      if (k === 'fillText') return (q: string, x: number, y: number) =>
        texts.push({ text: String(q), font: String(t.font), alpha: Number(t.globalAlpha), x, y, align: String(t.textAlign || 'left') });
      // a fixed-width font: 0.55 of the font size per character (RENDER.edges.fitText measures the titles)
      if (k === 'measureText') return (q: string) => ({ width: String(q).length * (parseFloat(String(t.font).split(' ')[1]) || 10) * 0.55 });
      if (k in t) return t[k];
      return () => undefined;
    },
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  const map: any = { ctx, cam: { s: opts.s ?? 1, tx: 100, ty: 100 }, cw: 1e6, ch: 1e6, selectedId: opts.selectedId ?? null, hi: opts.hi ?? null };
  w.C4PM_STORAGEVIEW.draw(map, w.C4PM_RENDER.theme.readColors(), 0);
  return { texts, map };
}
// Record header names drawn at full alpha (lit) when a selection or a board highlight dims the rest.
const litNames = (texts: { text: string; font: string; alpha: number }[]) =>
  texts.filter(t => t.font.startsWith('600 15px') && t.alpha === 1).map(t => t.text).sort();

describe('STOR-6a storage view: registration', () => {
  it('has("storage") with a storageView; #storage loads its tree and the storage renderer', () => {
    const model = storageModel();
    const { w, V } = page(model);
    expect(w.C4PM_MODE.has('storage')).toBe(true);
    expect(w.C4PM_MODE.get()).toBe('storage');
    expect(w.C4PM_STATE.data.root).toBe(w.C4PM_DATA.storageView.root);
    expect(w.C4PM_STATE.data.edges).toBe(w.C4PM_DATA.storageView.edges);
    expect(w.C4PM_MODE.renderer()).toBe(V);
    expect(Object.keys(V).sort()).toEqual(['arrows', 'bounds', 'draw', 'focus', 'hit', 'hud', 'layout', 'rect', 'setSample']);
    expect(Object.keys(w.C4PM_VIEWS)).toEqual(['arch', 'io', 'storage']);
    expect(w.C4PM_VIEWS.storage).toMatchObject({ label: 'Storage view', short: 'Storage', color: 'c2' });
    const records = all(model.storageView!.root).filter(n => n.kind === 'record').length;
    expect(w.C4PM_VIEWS.storage.chips(w.C4PM_DATA)).toBe(`1 store · ${records} records · ${model.storageView!.edges.length} links`);
  });

  it('no storageView: has("storage") false, #storage ignored, the switch segment disabled', () => {
    const { w, h } = page(storageModel(null));
    expect(w.C4PM_MODE.has('storage')).toBe(false);
    expect(w.C4PM_MODE.get()).toBe('arch');
    expect(w.C4PM_STORAGEVIEW.bounds()).toBeNull();
    const seg = (h.sandbox as any).document.getElementById('view-switch').children.find((b: any) => b.getAttribute('data-mode') === 'storage');
    expect(seg.disabled).toBe(true);
  });
});

describe('STOR-6a storage view: layout', () => {
  it('writes a world rect (and the same bubble) into every node; rows stack inside their record; layout is idempotent', () => {
    const { w, V } = page(storageModel());
    const nodes = all(w.C4PM_DATA.storageView.root);
    nodes.forEach(n => {
      expect(n.w).toBeGreaterThan(0);
      expect(n.bubble).toEqual({ x: n.x, y: n.y, w: n.w, h: n.h });
      expect(V.rect(n.id)).toEqual({ x: n.x, y: n.y, w: n.w, h: n.h });
    });
    expect(V.bounds()).toEqual(V.rect('(storage)'));
    const cls = nodes.find(n => n.id === CLASSES);
    cls.children.forEach((f: any, i: number) => {
      expect(f.x).toBe(cls.x);
      expect(f.y).toBeGreaterThanOrEqual(cls.y);
      expect(f.y + f.h).toBeLessThanOrEqual(cls.y + cls.h);
      if (i) expect(f.y).toBe(cls.children[i - 1].y + cls.children[i - 1].h);
    });
    const before = JSON.stringify(nodes.map(n => [n.id, n.x, n.y, n.w, n.h]));
    const arrows = JSON.stringify(V.arrows());
    V.layout();
    expect(JSON.stringify(nodes.map(n => [n.id, n.x, n.y, n.w, n.h]))).toBe(before);
    expect(JSON.stringify(V.arrows())).toBe(arrows);
    expect(V.rect('nope')).toBeNull();
  });

  it('a node of a kind the layout cannot place throws with its id', () => {
    const view = drizzleStorageView();
    view.root.children[0].children[0].children[0].kind = 'component';
    expect(() => page(storageModel(view))).toThrow(`"${CLASSES}" is a "component"`);
  });

  it('arrows(): one per edge, from the from row side to the to row side; enrollments.class_id ends on the id row of classes', () => {
    const { w, V } = page(storageModel());
    const arrows = V.arrows();
    expect(arrows.map((a: any) => [a.from, a.to])).toEqual(w.C4PM_DATA.storageView.edges.map((e: any) => [e.from, e.to]));
    const onSide = (x: number, y: number, r: Rect) =>
      (Math.abs(x - r.x) <= 1.5 || Math.abs(x - (r.x + r.w)) <= 1.5) && y > r.y && y < r.y + r.h;
    arrows.forEach((a: any) => {
      expect(onSide(a.x1, a.y1, V.rect(a.from))).toBe(true);
      expect(onSide(a.x2, a.y2, V.rect(a.to))).toBe(true);
    });
    const a = arrows.find((x: any) => x.from === CLASS_ID);
    expect(a.to).toBe(CLASSES_ID);
    expect(a.label).toBeNull();
    expect(arrows.filter((x: any) => x.label === 'cascade').length).toBe(2);
  });
});

describe('STOR-6a storage view: hit, selection, hud', () => {
  it('hit: a field row centre -> { field, its record } when rows are readable; the record when they are not; stores and zones', () => {
    const { w, V } = page(storageModel());
    const m = w.C4PM_STATE.map;
    const at = (id: string, s: number) => {
      m.cam = { s, tx: 7, ty: 9 };
      const r = V.rect(id);
      return V.hit((r.x + r.w / 2) * s + 7, (r.y + r.h / 2) * s + 9);
    };
    expect(at(CLASS_ID, 1)).toEqual({ id: CLASS_ID, entryId: ENROLLMENTS });
    expect(at(CLASS_ID, 0.1)).toEqual({ id: ENROLLMENTS, entryId: null });
    expect(at(CLASS_ID, 0.35)).toEqual({ id: ENROLLMENTS, entryId: null });   // b631: rows off until field names are readable (0.35 * 22 < 8.46)
    expect(at(ENROLLMENTS, 1)).toEqual({ id: CLASS_ID.replace('class_id', 'joined_at'), entryId: ENROLLMENTS });   // the middle row
    m.cam = { s: 1, tx: 0, ty: 0 };
    const st = V.rect('app.api.db'), z = V.rect('app.api');
    expect(V.hit(st.x + 5, st.y + 5)).toEqual({ id: 'app.api.db', entryId: null });   // the store's title band
    expect(V.hit(z.x + 5, z.y + 5)).toEqual({ id: 'app.api', entryId: null });
    expect(V.hit(z.x - 500, z.y - 500)).toBeNull();
  });

  it('a selected record lights exactly itself and the records an FK edge joins it to; a field lights its record the same way', () => {
    const { w } = page(storageModel());
    const D = w.C4PM_DATA.storageView;
    const recOf: Record<string, string> = {};
    all(D.root).filter(n => n.kind === 'record').forEach(r => all(r).forEach(f => { recOf[f.id] = r.id; }));
    const nameOf: Record<string, string> = {};
    all(D.root).forEach(n => { nameOf[n.id] = n.name; });
    const linked = new Set([ENROLLMENTS]);
    D.edges.forEach((e: any) => { if (recOf[e.from] === ENROLLMENTS) linked.add(recOf[e.to]); if (recOf[e.to] === ENROLLMENTS) linked.add(recOf[e.from]); });
    const expected = [...linked].map(id => nameOf[id]).sort();
    expect(expected).toEqual(['classes', 'enrollments', 'student_profiles', 'users']);
    expect(litNames(drawOnce(w, { selectedId: ENROLLMENTS }).texts)).toEqual(expected);
    expect(litNames(drawOnce(w, { selectedId: CLASS_ID }).texts)).toEqual(expected);
    // nothing selected: every record at full alpha
    const none = drawOnce(w).texts.filter(t => t.font.startsWith('600 15px'));
    expect(none.every(t => t.alpha === 1)).toBe(true);
    // a board highlight (map.hi) alone lights only the records it names
    expect(litNames(drawOnce(w, { hi: new Set(['db/schema/files.ts#files.key']) }).texts)).toEqual(['files']);
  });

  it('draws field names, types, PK / FK chips and the cascade label; no text under 5 px', () => {
    const { w } = page(storageModel());
    const t = drawOnce(w).texts.map(x => x.text);
    ['enrollments', 'class_id', 'uuid', 'PK', 'FK', '?', 'cascade', 'Main DB', 'database', 'Api', 'table'].forEach(s => expect(t).toContain(s));
    // s 0.05: only the store title, wide enough on screen (b631: titles draw at 10 px when the box leaves >= 28 px); records are 12 px wide
    const tiny = drawOnce(w, { s: 0.05 }).texts;
    expect(tiny.map(t => t.text)).toEqual(['Main DB']);
    tiny.forEach(t => expect(parseFloat(t.font.split(' ')[1]) * 0.05).toBeGreaterThanOrEqual(5));
  });

  it('b631: at Fit (s 0.226) record and store names draw at 10 px on screen, cut to the box, without words or field rows; at 0.4 rows and 15 px names', () => {
    const { w } = page(storageModel());
    const records = all(w.C4PM_DATA.storageView.root).filter(n => n.kind === 'record').map(n => n.name);
    const fit = drawOnce(w, { s: 0.226 }).texts;
    const big = '600 ' + 10 / 0.226 + 'px';
    const fitNames = fit.filter(t => t.font.startsWith(big)).map(t => t.text.replace(/…$/, ''));
    records.forEach(r => expect(fitNames.some(t => r.startsWith(t) && t.length > 0)).toBe(true));
    expect(fitNames.some(t => 'Main DB'.startsWith(t))).toBe(true);   // the store title too
    fit.forEach(t => expect(['class_id', 'uuid', 'PK', 'FK', 'table', 'database']).not.toContain(t.text));
    // a long title is cut with an ellipsis to the record box (216 world units of room)
    fit.filter(t => t.font.startsWith(big)).forEach(t => expect(t.text.length * (10 / 0.226) * 0.55).toBeLessThanOrEqual(216));
    const near = drawOnce(w, { s: 0.4 }).texts;
    expect(near.map(t => t.text)).toContain('class_id');
    expect(near.filter(t => t.font.startsWith('600 25px')).map(t => t.text)).toContain('enrollments');   // 10 / 0.4 = 25 > 15
    const close = drawOnce(w, { s: 1 }).texts;
    expect(close.filter(t => t.font.startsWith('600 15px')).map(t => t.text)).toContain('enrollments');
  });

  it('b636: a field row cuts its type first (a few characters + …), then its name; name end + gap <= type start; short ones are whole', () => {
    const { w, V } = page(storageModel());
    const field = all(w.C4PM_DATA.storageView.root).find(n => n.id === CLASS_ID);
    const textW = (t: { text: string; font: string }) => t.text.length * parseFloat(t.font.split(' ')[1]) * 0.55;   // the drawOnce font
    const row = () => {
      const r = V.rect(CLASS_ID)!, cy = r.y + 22 / 2 + 0.5;
      const at = drawOnce(w).texts.filter(t => t.y === cy);
      const name = at.find(t => / 13px /.test(t.font) && t.align === 'left')!, type = at.find(t => / 12px /.test(t.font))!;
      return { name, type, nameEnd: name.x + textW(name), typeStart: type.x - textW(type) };
    };
    // short: drawn whole
    const short = row();
    expect([short.name.text, short.type.text]).toEqual(['class_id', 'uuid']);
    expect(short.type.align).toBe('right');
    // C4PM's own case (History > the snapshot record): the whole name, the type cut to what is left
    field.name = 'componentEdges'; field.meta = { ...(field.meta || {}), type: 'ComponentEdge[]' };
    const own = row();
    expect(own.name.text).toBe('componentEdges');
    expect(own.type.text).toMatch(/^ComponentEd.*…$/);
    expect(own.nameEnd + 8).toBeLessThanOrEqual(own.typeStart + 1e-9);
    // both long: the type keeps a few characters, the name is cut too; never overlapping
    field.name = 'aVeryLongFieldNameThatCannotFitInARecordRowAtAll'; field.meta = { ...field.meta, type: 'Map<string, ComponentEdge[]>' };
    const long = row();
    expect(long.type.text).toMatch(/^Map<.+…$/);
    expect(long.name.text).toMatch(/^aVeryLong.*…$/);
    expect(long.nameEnd + 8).toBeLessThanOrEqual(long.typeStart + 1e-9);
  });

  it('hud: the store word with no focus; the word of the record that fills the view', () => {
    const { w, V } = page(storageModel());
    const m = w.C4PM_STATE.map;
    m.cw = 1200; m.ch = 800;
    m.cam = { s: 1e-4, tx: 600, ty: 400 };
    expect(V.focus()).toBeNull();
    expect(V.hud()).toBe('database');
    const r = V.rect(ENROLLMENTS), s = 800 / r.h;
    m.cam = { s, tx: 600 - (r.x + r.w / 2) * s, ty: 400 - (r.y + r.h / 2) * s };
    expect(V.focus()).toEqual({ id: ENROLLMENTS, entryId: null });
    expect(V.hud()).toBe('table');
  });

  it('colours come from the tokens only: no raw colour and no element.style in storageView.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'viewer', 'storageView.js'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/);
    expect(src).not.toMatch(/\.style\b/);
  });
});
