import path from 'path';
import { buildView } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { FakeEl } from './helpers/viewer-harness';

// b914 slice 3: the Export section of the gear popup (viewer/live-export.js) and the shared downloadText of controls.js.

const IDS = ['btn-details', 'details-pop', 'btn-gear', 'settings-pop', 'search-mode', 'search-hint', 'hud-bl'];
const START = 'Writes C4MP/<id>/c4mpView.html and downloads a copy that works offline.';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

interface Call { method: string; path: string; body: unknown }

function setup(opts: { live?: boolean; dirty?: boolean; blobThrows?: boolean } = {}) {
  const calls: Call[] = [];
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const blobs: Array<{ parts: unknown[]; opts: { type: string } }> = [];
  const anchors: Array<{ download: string; clicked: boolean }> = [];
  const revoked: string[] = [];
  const live = {
    generation: 1, stamps: {}, settings: {}, error: null, dirty: () => {}, isDirty: () => !!opts.dirty,
    request: (method: string, p: string, body: unknown) => {
      if (p !== 'api/export') return new Promise(() => {});   // live.js long-poll: never answers
      calls.push({ method, path: p, body });
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    },
  };
  class FakeBlob { parts: unknown[]; opts: { type: string }; constructor(parts: unknown[], o: { type: string }) { this.parts = parts; this.opts = o; blobs.push(this); } }
  const globals: Record<string, unknown> = {
    Blob: FakeBlob,
    URL: {
      createObjectURL: () => { if (opts.blobThrows) throw new Error('blocked'); return 'blob:1'; },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    },
  };
  if (opts.live !== false) globals.C4PM_LIVE = live;
  const { html } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  const h = runViewerScripts(html, { extraIds: IDS, globals });
  const doc = h.sandbox.document as { getElementById: (id: string) => FakeEl; createElement: (t: string) => FakeEl };
  const pop = doc.getElementById('settings-pop');
  const origCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const e = origCreate(tag) as FakeEl & { download?: string };
    if (tag === 'a') { const rec = { download: '', clicked: false }; anchors.push(rec); e.click = () => { rec.download = e.download ?? ''; rec.clicked = true; }; }
    return e;
  };
  const find = (id: string) => pop.querySelector('#' + id) as (FakeEl & { checked?: boolean; disabled?: boolean }) | null;
  return { h, pop, calls, pending, blobs, anchors, revoked, find };
}

describe('Export in the gear popup (b914 slice 3)', () => {
  it('static page: no Export row, no export controls', () => {
    const s = setup({ live: false });
    expect(s.find('btn-export-page')).toBeNull();
    expect(s.find('export-nosource')).toBeNull();
    expect(s.pop.children.some(c => c.className.includes('set-export'))).toBe(false);
  });

  it('live page: the Export row ends the popup, checkbox unchecked, start text', () => {
    const s = setup();
    const row = s.pop.children[s.pop.children.length - 1];
    expect(row.className).toContain('set-export');
    expect(row.children[0].textContent).toBe('Export');
    expect(row.children[1].children[0]).toBe(s.find('export-nosource'));
    expect(row.children[1].children[1].textContent).toBe('Leave source code out');
    expect(s.find('export-nosource')!.checked).toBe(false);
    expect(row.children[2].textContent).toBe('Board and plan text are kept as written.');
    expect(s.find('btn-export-page')!.textContent).toBe('Export');
    expect(s.find('export-status')!.textContent).toBe(START);
    expect(s.pop.children[s.pop.children.length - 2].textContent).toMatch(/^Kept in your c4mp settings file/);
  });

  it('click: one request, button disabled, Exporting ...; a second click sends nothing', () => {
    const s = setup();
    s.find('btn-export-page')!.click();
    s.find('btn-export-page')!.click();
    expect(s.calls).toEqual([{ method: 'POST', path: 'api/export', body: { noSource: false } }]);
    expect(s.find('btn-export-page')!.disabled).toBe(true);
    expect(s.find('export-status')!.textContent).toBe('Exporting ...');
  });

  it('ticked box: body noSource true', () => {
    const s = setup();
    s.find('export-nosource')!.checked = true;
    s.find('btn-export-page')!.click();
    expect(s.calls[0].body).toEqual({ noSource: true });
  });

  it('200: downloads the html as text/html, says so, enables the button', async () => {
    const s = setup();
    s.find('btn-export-page')!.click();
    s.pending[0].resolve({ status: 200, json: { file: '/r/C4PM/x/c4pmView.html', name: 'c4pm-x-2026-11-23.html', noSource: true, html: '<html></html>' } });
    await settle();
    expect(s.blobs).toHaveLength(1);
    expect(s.blobs[0].parts).toEqual(['<html></html>']);
    expect(s.blobs[0].opts.type).toBe('text/html');
    expect(s.anchors).toEqual([{ download: 'c4pm-x-2026-11-23.html', clicked: true }]);
    (s.h as any).flushTimers();
    expect(s.revoked).toEqual(['blob:1']);
    expect(s.find('export-status')!.textContent).toBe('Exported: wrote /r/C4PM/x/c4pmView.html and downloaded c4pm-x-2026-11-23.html (no source code).');
    expect(s.find('btn-export-page')!.disabled).toBe(false);
  });

  it('unsaved edits: the status ends with the warning', async () => {
    const s = setup({ dirty: true });
    s.find('btn-export-page')!.click();
    s.pending[0].resolve({ status: 200, json: { file: 'f', name: 'n.html', noSource: false, html: 'h' } });
    await settle();
    expect(s.find('export-status')!.textContent).toBe('Exported: wrote f and downloaded n.html. Unsaved edits on this page are not in it.');
  });

  it.each([
    [409, { message: 'still rebuilding' }, 'Export failed: still rebuilding'],
    [500, null, 'Export failed: c4mp serve answered 500'],
    [401, { message: 'x' }, 'Export failed: the key is from an earlier c4mp serve run. Open the link it printed.'],
  ])('answer %i: failure text, no download', async (status, json, text) => {
    const s = setup();
    s.find('btn-export-page')!.click();
    s.pending[0].resolve({ status, json });
    await settle();
    expect(s.find('export-status')!.textContent).toBe(text);
    expect(s.blobs).toHaveLength(0);
    expect(s.find('btn-export-page')!.disabled).toBe(false);
  });

  it('request rejects: server not running', async () => {
    const s = setup();
    s.find('btn-export-page')!.click();
    s.pending[0].reject(new Error('net'));
    await settle();
    expect(s.find('export-status')!.textContent).toBe('Export failed: c4mp serve is not running.');
    expect(s.find('btn-export-page')!.disabled).toBe(false);
  });

  it('the browser refuses the download: wrote the file, download failed', async () => {
    const s = setup({ blobThrows: true });
    s.find('btn-export-page')!.click();
    s.pending[0].resolve({ status: 200, json: { file: 'f.html', name: 'n.html', noSource: false, html: 'h' } });
    await settle();
    expect(s.find('export-status')!.textContent).toBe('Wrote f.html; the download failed: blocked');
  });

  it('no innerHTML write on the new nodes', () => {
    const s = setup();
    const all = (e: FakeEl): FakeEl[] => [e, ...e.children.flatMap(all)];
    const row = s.pop.children[s.pop.children.length - 1];
    expect(all(row).every(e => e._html === '')).toBe(true);
  });

  it('Export layout still downloads c4mp-layout.json through downloadText (static page; a served page saves, b644)', () => {
    const s = setup({ live: false });
    (s.h.sandbox as any).C4PM_EDIT.exportLayout = () => ({ version: 2, nodes: { api: { rx: 1, ry: 2, rw: 3, rh: 4 } } });
    (s.h.sandbox as any).C4PM_CONTROLS.downloadLayout();
    expect(s.blobs).toHaveLength(1);
    expect(s.blobs[0].opts.type).toBe('application/json');
    expect(s.anchors).toEqual([{ download: 'c4mp-layout.json', clicked: true }]);
  });
});
