import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// W4 (b300): viewer/ioWireframe.js without a layout engine. The vm context has no DOMParser, so measureAll must answer
// { ok: false, reason } per screen and never throw (R3, C8). The layout itself is tested in io-wireframe-chrome.test.ts.

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'viewer', 'ioWireframe.js'), 'utf8');
const RULES = { css: ['width'], base: '', keepTags: ['div'], keepAttrs: ['data-c4'] };

function load(globals: Record<string, unknown> = {}): any {
  const win: any = {};
  vm.runInNewContext(SRC, { window: win, ...globals });
  return win.C4PM_IO_WIREFRAME;
}

describe('C4PM_IO_WIREFRAME without a layout engine', () => {
  it('exposes measureAll', () => {
    expect(typeof load().measureAll).toBe('function');
  });

  it('no DOMParser: every screen is { ok: false, reason }, no throw, other keys untouched', () => {
    const items = [1, 2].map(n => ({ fqn: `s${n}`, html: '<div data-c4="a"></div>', viewport: { w: 100, h: 100 } }));
    const out = load().measureAll(items, RULES);
    expect(Object.keys(out)).toEqual(['s1', 's2']);
    for (const r of Object.values<any>(out)) {
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no layout engine/);
      expect(r.reasons).toEqual([r.reason]);
    }
  });

  it('a DOMParser without constructable stylesheets or shadow DOM is also a reason, not a throw', () => {
    const out = load({ DOMParser: class {} }).measureAll([{ fqn: 's', html: '', viewport: { w: 1, h: 1 } }], RULES);
    expect(out.s.ok).toBe(false);
    expect(out.s.reason).toMatch(/no layout engine/);
  });

  it('no items: empty result', () => {
    expect(load().measureAll([], RULES)).toEqual({});
  });
});
