import path from 'path';
import { buildView } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// b644 (SV10): Save layout in a served page (controls.js downloadLayout -> saveLayout -> POST api/layout).

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const LAYOUT = { version: 2, nodes: { api: { rx: 1, ry: 2, rw: 3, rh: 4 } } };

interface Call { method: string; path: string; body: any }

function setup(opts: { live?: boolean; nodes?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const blobs: Array<{ opts: { type: string } }> = [];
  const anchors: Array<{ download: string; clicked: boolean }> = [];
  const live: any = {
    generation: 1, stamps: { plan: 'p1' }, settings: {}, error: null, dirty: () => {}, isDirty: () => false,
    request: (method: string, p: string, body: unknown) => {
      if (p !== 'api/layout') return new Promise(() => {});
      calls.push({ method, path: p, body });
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    },
  };
  class FakeBlob { opts: { type: string }; constructor(_p: unknown[], o: { type: string }) { this.opts = o; blobs.push(this); } }
  const globals: Record<string, unknown> = { Blob: FakeBlob, URL: { createObjectURL: () => 'blob:1', revokeObjectURL: () => {} } };
  if (opts.live !== false) globals.C4PM_LIVE = live;
  const { html } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  const h = runViewerScripts(html, { globals });
  const sb = h.sandbox as any;
  const doc = sb.document as { getElementById: (id: string) => FakeEl; createElement: (t: string) => FakeEl };
  const origCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const e = origCreate(tag) as FakeEl & { download?: string };
    if (tag === 'a') { const rec = { download: '', clicked: false }; anchors.push(rec); e.click = () => { rec.download = e.download ?? ''; rec.clicked = true; }; }
    return e;
  };
  sb.C4PM_EDIT.exportLayout = () => (opts.nodes ? { version: 2, nodes: opts.nodes } : LAYOUT);
  sb.C4PM_STATE.map.history.undo.push({});
  const hint = doc.getElementById('hud-bl');
  const btn = doc.getElementById('btn-export');
  return { sb, live, calls, pending, blobs, anchors, hint, btn, click: () => btn.onclick!() };
}

const answer = (status: number, json: unknown) => ({ status, json });

describe('Save layout in a served page (b644 SV10)', () => {
  it('button text follows the page kind', () => {
    expect(setup().btn.textContent).toBe('Save layout');
    expect(setup({ live: false }).btn.textContent).not.toBe('Save layout');
  });

  it('static page: downloadLayout downloads', () => {
    const s = setup({ live: false });
    s.sb.C4PM_CONTROLS.downloadLayout();
    expect(s.blobs).toHaveLength(1);
    expect(s.anchors).toEqual([{ download: 'c4mp-layout.json', clicked: true }]);
  });

  it('click Save: one POST with the plan stamp, no download', () => {
    const s = setup();
    s.click();
    expect(s.calls).toEqual([{ method: 'POST', path: 'api/layout', body: { expect: 'p1', layout: LAYOUT } }]);
    expect(s.hint.textContent).toBe('Saving the layout ...');
    expect(s.blobs).toHaveLength(0);
  });

  it('200 ok: says what was written, clears history, takes the new stamp', async () => {
    const s = setup();
    s.click();
    s.pending[0].resolve(answer(200, { ok: true, report: { applied: 1, files: [{ file: 'a.c4' }], failed: [] }, stamp: 'p2' }));
    await settle();
    expect(s.hint.textContent).toBe('Saved 1 shape(s) to a.c4. The map reloads with the plan.');
    expect(s.sb.C4PM_STATE.map.history.undo).toHaveLength(0);
    expect(s.live.stamps.plan).toBe('p2');
  });

  it('200 ok without files and with failures', async () => {
    const s = setup();
    s.click();
    s.pending[0].resolve(answer(200, { ok: true, report: { applied: 0, files: [], failed: [] }, stamp: null }));
    await settle();
    expect(s.hint.textContent).toBe('Nothing changed: the plan already has this layout.');
    expect(s.live.stamps.plan).toBe('p1');
    const t = setup();
    t.click();
    t.pending[0].resolve(answer(200, { ok: true, report: { applied: 1, files: [{ file: 'a.c4' }], failed: [{ reason: 'no such box' }] }, stamp: 'p2' }));
    await settle();
    expect(t.hint.textContent).toBe('Saved 1 shape(s) to a.c4. The map reloads with the plan. 1 shape(s) failed: no such box.');
  });

  it.each([
    [409, {}, 'The plan changed since this page loaded. Your edits are kept: download them, then reload.'],
    [401, {}, 'Save failed: the key is from an earlier c4mp serve run. Your edits are kept.'],
    [422, { write: { error: { message: 'outside .c4pm/ (use --force): c4/a.c4' } } }, 'Save refused: outside .c4pm/ (use --force): c4/a.c4. Your edits are kept.'],
    [500, {}, 'Save refused: c4mp serve answered 500. Your edits are kept.'],
  ])('status %i keeps the edits and offers the download', async (status, json, text) => {
    const s = setup();
    s.click();
    s.pending[0].resolve(answer(status, json));
    await settle();
    expect(s.hint.textContent).toBe(text);
    expect(s.sb.C4PM_STATE.map.history.undo).toHaveLength(1);
    const b = s.hint.children.find(c => c.textContent === 'Download c4mp-layout.json')!;
    expect(b).toBeDefined();
    b.onclick!();
    expect(s.blobs).toHaveLength(1);
    expect(s.blobs[0].opts.type).toBe('application/json');
    expect(s.anchors).toEqual([{ download: 'c4mp-layout.json', clicked: true }]);
  });

  it('rejected request: server not running', async () => {
    const s = setup();
    s.click();
    s.pending[0].reject(new Error('x'));
    await settle();
    expect(s.hint.textContent).toBe('Save failed: c4mp serve is not running. Your edits are kept.');
    expect(s.sb.C4PM_STATE.map.history.undo).toHaveLength(1);
  });

  it('nothing moved: says so, no request', () => {
    const s = setup({ nodes: {} });
    s.click();
    expect(s.hint.textContent).toBe('Nothing to save: no shape has been moved or resized.');
    expect(s.calls).toHaveLength(0);
  });

  it('no innerHTML write on the hint', async () => {
    const s = setup();
    s.click();
    s.pending[0].resolve(answer(409, {}));
    await settle();
    expect(s.hint._html).toBe('');
  });
});
