import { renderViewHtml } from '../src/page/html';
import { runViewerScripts } from './helpers/viewer-harness';
import { loadSample } from './helpers/nav-view';

// b269: drag-to-resize for the side panels. Width in --left-w / --right-w on #root, stored in c4mp.leftWidth / c4mp.rightWidth.

function load(storage: Record<string, string> = {}, ls?: unknown) {
  const h = runViewerScripts(renderViewHtml(loadSample()), {
    globals: { localStorage: ls ?? { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => { storage[k] = v; }, removeItem: (k: string) => { delete storage[k]; } } },
  });
  const doc = h.sandbox.document as any;
  return { doc, root: doc.getElementById('root'), main: doc.getElementById('main'), gl: doc.getElementById('grip-left'), gr: doc.getElementById('grip-right'), storage };
}

describe('side panel resize', () => {
  it.each([
    ['300', '300px'], ['50', '180px'], ['9999', '480px'],
  ])('stored left %s is applied clamped to %s', (v, out) => {
    expect(load({ 'c4mp.leftWidth': v }).root.style['--left-w']).toBe(out);
  });

  it.each([
    ['500', '500px'], ['100', '280px'], ['9999', '720px'],
  ])('stored right %s is applied clamped to %s', (v, out) => {
    expect(load({ 'c4mp.rightWidth': v }).root.style['--right-w']).toBe(out);
  });

  it.each([['abc'], [''], ['NaN'], ['Infinity']])('bad stored value %j leaves the default', (v) => {
    const { root } = load({ 'c4mp.leftWidth': v, 'c4mp.rightWidth': v });
    expect(root.style['--left-w']).toBeUndefined();
    expect(root.style['--right-w']).toBeUndefined();
  });

  it('a throwing localStorage keeps the default and the page works', () => {
    const boom = () => { throw new Error('blocked'); };
    const { root, gl } = load({}, { getItem: boom, setItem: boom, removeItem: boom });
    expect(root.style['--left-w']).toBeUndefined();
    gl.dispatch('dblclick');   // must not throw
    expect(root.style['--left-w']).toBeUndefined();
  });

  it('dragging sets the var and stores it on release; the centre keeps at least 320px', () => {
    const { main, gl, root, storage } = load();
    main.clientWidth = 1000;
    main.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 0, right: 1000, bottom: 0 });
    gl.dispatch('pointerdown', { button: 0, pointerId: 1 });
    gl.dispatch('pointermove', { clientX: 350 });
    expect(root.style['--left-w']).toBe('350px');
    gl.dispatch('pointermove', { clientX: 990 });   // cap = 1000 - 320 = 680, then the 480 maximum applies
    expect(root.style['--left-w']).toBe('480px');
    gl.dispatch('pointerup', {});
    expect(storage['c4mp.leftWidth']).toBe('480');
  });

  it('the centre minimum caps a narrow window', () => {
    const { main, gl, root } = load();
    main.clientWidth = 600;
    main.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 0, right: 600, bottom: 0 });
    gl.dispatch('pointerdown', { button: 0, pointerId: 1 });
    gl.dispatch('pointermove', { clientX: 450 });   // 600 - 320 = 280
    expect(root.style['--left-w']).toBe('280px');
  });

  it('double-click resets to the default and removes the stored key', () => {
    const { gr, root, storage } = load({ 'c4mp.rightWidth': '600' });
    expect(root.style['--right-w']).toBe('600px');
    gr.dispatch('dblclick');
    expect(root.style['--right-w']).toBeUndefined();
    expect('c4mp.rightWidth' in storage).toBe(false);
  });

  it('arrow keys move the edge by 16px', () => {
    const { gl, gr, root, storage } = load({ 'c4mp.leftWidth': '300', 'c4mp.rightWidth': '400' });
    gl.dispatch('keydown', { key: 'ArrowRight' });
    expect(root.style['--left-w']).toBe('316px');
    gr.dispatch('keydown', { key: 'ArrowLeft' });   // dragging the right panel's edge left makes it wider
    expect(root.style['--right-w']).toBe('416px');
    expect(storage['c4mp.rightWidth']).toBe('416');
  });

  it('CSS hides a collapsed panel\'s grip, under 1100px and bare; grips carry separator semantics', () => {
    const html = renderViewHtml(loadSample());
    expect(html).toMatch(/#main\.left-collapsed #grip-left,\s*#main\.right-collapsed #grip-right\s*\{\s*display: none;/);
    expect(html).toMatch(/#root\.bare \.side-grip/);
    expect(html).toMatch(/@media \(max-width: 1099px\) \{\s*\.side-grip \{\s*display: none;/);
    for (const id of ['grip-left', 'grip-right']) {
      const tag = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))![0];
      expect(tag).toContain('role="separator"');
      expect(tag).toContain('aria-orientation="vertical"');
      expect(tag).toContain('aria-label=');
    }
  });
});
