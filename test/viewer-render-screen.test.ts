import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import type { HarnessResult } from './helpers/viewer-harness';
import { ioModel, loadSample } from './helpers/nav-view';
import type { ViewModel } from '../src/types';

// P20-T5-C (b257): the 'screen' kind word is SCREEN; arch draws no screen colour. Runs the real scripts in the fake-DOM harness.

const SCREEN = '#5B4FC9';          // --screen in the harness's fake getComputedStyle (distinct)

interface Api { draw(): void; flyTo(id: string): void }

function settle(r: HarnessResult) {
  r.frames.runToCompletion();
  for (let i = 0; i < 60; i++) r.frames.flush();
}

function load(model: ViewModel, focusId: string, hash = '') {
  const h = runViewerScripts(renderViewHtml(model), hash ? { globals: { location: { href: 'file:///x.html' + hash, hash } } } : undefined);
  settle(h);
  const api = h.sandbox.C4PM_MAP as unknown as Api;
  api.flyTo(focusId);   // open the region so its children draw as bubbles
  settle(h);
  h.opLog.length = 0; h.pathLog.length = 0; h.fillTextLog.length = 0;
  api.draw();
  return h;
}

describe('P20-T5-C screen kind', () => {
  it('the region word of the screen kind is SCREEN (kind table, b142)', () => {
    const h = load(ioModel(loadSample()), 'shop.web');
    expect((h.sandbox.window as any).C4PM_MODE.region('screen')).toBe('SCREEN');
  });

  it('IO view region headers never use C1/C2/C3 words (b263); the IO drawing itself is ioView (viewer-io-screens, viewer-io-boxes)', () => {
    const h = load(loadSample(), 'shop.web', '#io');   // a page opened at #io: mode io
    expect(h.fillTextLog.some(t => /C[123] /.test(t))).toBe(false);
  });

  it('arch sample: arch region header words unchanged (b263)', () => {
    const h = load(loadSample(), 'sample-shop');
    expect(h.fillTextLog.some(t => t.startsWith('C1 SYSTEM'))).toBe(true);
  });

  it('arch sample: no screen colour anywhere, arch nodes still drawn', () => {
    const h = load(loadSample(), 'sample-shop');
    expect(h.opLog.some(o => o.style === SCREEN)).toBe(false);
    expect(h.opLog.length).toBeGreaterThan(0);
  });
});
