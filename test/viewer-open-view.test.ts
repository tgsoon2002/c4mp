import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// P20-T5-G (b261): C4PM_OPEN opens a view in its own named window and shows a toast in #view-toast.

const HREF = 'file:///x.html?a=1#io';
const BLOCKED = 'The browser blocked the new window - allow pop-ups for this page';

function setup(open: (...a: unknown[]) => unknown, extraIds: string[] = ['view-toast']) {
  const calls: unknown[][] = [];
  const h = runViewerScripts(renderViewHtml(loadSample()), {
    extraIds,
    globals: { location: { href: HREF, hash: '#io' }, open: (...a: unknown[]) => { calls.push(a); return open(...a); } },
  });
  const doc = h.sandbox.document as any;
  return { h, calls, toast: doc.getElementById('view-toast'), run: (m: string) => (h.sandbox.window as any).C4PM_OPEN(m) };
}

describe('C4PM_OPEN', () => {
  it.each([
    ['io', 'file:///x.html?a=1#io&bare', 'Opened the IO view in its own window'],
    ['arch', 'file:///x.html?a=1#arch&bare','Opened the Architecture view in its own window'],
  ])('%s: url, name, features, focus, toast', (mode, url, text) => {
    const focus = jest.fn();
    const s = setup(() => ({ focus }));
    s.run(mode);
    expect(s.calls).toEqual([[url, 'c4pm-' + mode, 'popup,width=1280,height=800']]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(s.toast.textContent).toBe(text);
    expect(s.toast.hidden).toBe(false);
  });

  it.each([
    ['null', () => null],
    ['throw', () => { throw new Error('nope'); }],
  ])('open %s gives the blocked toast', (_n, open) => {
    const s = setup(open);
    s.run('io');
    expect(s.toast.textContent).toBe(BLOCKED);
    expect(s.toast.hidden).toBe(false);
  });

  it('toast hides after the timer; a second call restarts the one timer', () => {
    const s = setup(() => ({ focus() {} }));
    s.run('io');
    s.run('arch');
    expect(s.toast.textContent).toBe('Opened the Architecture view in its own window');
    s.h.flushTimers();
    expect(s.toast.hidden).toBe(true);
  });

  it('without #view-toast nothing breaks and the window is still opened', () => {
    const focus = jest.fn();
    const s = setup(() => ({ focus }), []);
    expect(() => s.run('io')).not.toThrow();
    expect(focus).toHaveBeenCalled();
  });

  it('a throwing focus is not swallowed', () => {
    const s = setup(() => ({ focus() { throw new Error('f'); } }));
    expect(() => s.run('io')).toThrow('f');
  });
});
