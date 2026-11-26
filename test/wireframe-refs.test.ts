import * as fs from 'fs';
import * as path from 'path';
import { privatePlanDir } from './helpers/privateRepo';
import { parsePlan, parsePlanTexts } from '../src/plan/parser';
import { listC4Files } from '../src/plan/files';
import { resolveWireRef, resolveWireRefs, refFor } from '../src/c4/wireframeRefs';
import { DEVICE_VIEWPORT, parseViewport } from '../src/plan/ioWords';

// Phase 20 W2: one resolver of data-c4 refs, device table, viewport parser.
const SRC = `model {
  app = container 'App' {
    home = screen 'Home' {
      top = region 'Top' {
        search = control 'Search' {
          open = state 'Open'
        }
        ok = control 'Ok'
      }
      side = region 'Side' {
        search = control 'Search 2'
        ok = control 'Ok 2'
      }
      footer = region 'Footer'
    }
    other = screen 'Other' {
      search = control 'Foreign'
    }
  }
}`;
const plan = parsePlanTexts('/r', new Map([['a.c4', SRC]]));
const H = 'app.home';

describe('resolveWireRef', () => {
  it.each([
    ['unique id', 'footer', 'unique', 'app.home.footer', []],
    ['repeated id', 'search', 'ambiguous', null, ['app.home.side.search', 'app.home.top.search']],
    ['dotted path', 'top.search', 'unique', 'app.home.top.search', []],
    ['dotted path of a repeat', 'side.ok', 'unique', 'app.home.side.ok', []],
    ['partial dotted path', 'search.open', 'unknown', null, []],
    ['suffix is not a path', 'home.footer', 'unknown', null, []],
    ['state by id', 'open', 'state', 'app.home.top.search.open', []],
    ['state by path', 'top.search.open', 'state', 'app.home.top.search.open', []],
    ['title is never used', 'Footer', 'unknown', null, []],
    ['part of another screen', 'other', 'unknown', null, []],
    ['screen itself', 'home', 'unknown', null, []],
  ])('%s', (_n, ref, status, fqn, candidates) => {
    const r = resolveWireRef(plan, H, ref);
    expect(r.status).toBe(status);
    expect(r.fqn).toBe(fqn);
    expect([...r.candidates].sort()).toEqual(candidates);
  });
});

describe('resolveWireRefs', () => {
  it('maps to WireRef, dedupes, lists unplaced regions and controls (not states)', () => {
    const r = resolveWireRefs(plan, H, ['top', 'top', 'top.search', 'search', 'nope', 'open']);
    expect(r.refs.map(x => x.ref)).toEqual(['top', 'top.search', 'search', 'nope', 'open']);
    expect(r.refs[0]).toEqual({ ref: 'top', fqn: 'app.home.top' });
    expect(r.refs[2].problem).toBe('ambiguous');
    expect(r.refs[2].fqn).toBeNull();
    expect([...(r.refs[2].candidates ?? [])].sort()).toEqual(['app.home.side.search', 'app.home.top.search']);
    expect(r.refs[3]).toEqual({ ref: 'nope', fqn: null, problem: 'unknown' });
    expect(r.refs[4]).toEqual({ ref: 'open', fqn: 'app.home.top.search.open' });
    expect([...r.missing].sort()).toEqual(['app.home.footer', 'app.home.side', 'app.home.side.ok', 'app.home.side.search', 'app.home.top.ok']);
  });
});

describe('refFor', () => {
  it.each([
    ['app.home.footer', 'footer'],
    ['app.home.top.ok', 'top.ok'],
    ['app.home.top.search', 'top.search'],
    ['app.home.top.search.open', 'open'],
    ['app.other.search', null],
    ['app.home', null],
  ])('%s -> %s', (fqn, ref) => {
    expect(refFor(plan, H, fqn)).toBe(ref);
  });
  it('round trip: every part resolves back to itself', () => {
    for (const e of plan.elements.filter(x => x.id.startsWith(H + '.'))) {
      const ref = refFor(plan, H, e.id) as string;
      expect(resolveWireRef(plan, H, ref).fqn).toBe(e.id);
    }
  });
});

describe('DEVICE_VIEWPORT / parseViewport', () => {
  it('device table', () => {
    expect(DEVICE_VIEWPORT.web).toEqual({ w: 1280, h: 800 });
    expect(DEVICE_VIEWPORT.phone).toEqual({ w: 390, h: 844 });
  });
  it.each([
    ['1440x900', { w: 1440, h: 900 }], ['10x10', { w: 10, h: 10 }], ['99999x99999', { w: 99999, h: 99999 }], [' 390x844 ', { w: 390, h: 844 }],
    ['0800x0600', { w: 800, h: 600 }],
    ['00x00', null], ['0x0', null], ['9x800', null], ['1280x0', null], ['100000x800', null],
    ['abc', null], ['1280', null], ['1280x', null], ['1280X800', null], ['-5x800', null], ['1.5x800', null], ['', null], [null, null], [undefined, null],
  ])('%j -> %j', (v, out) => {
    expect(parseViewport(v as string)).toEqual(out);
  });
});

// Real plan: C4PM's own, with refs pulled from the html files by a local regex (W1's scanner is separate).
// Private plan only: the public tree has no ../.c4mp, so the block is skipped there and its body is not built (b963).
(privatePlanDir() ? describe : describe.skip)('C4PM plan wireframes', () => {
  const root = privatePlanDir();
  if (!root) { it('needs the private ../.c4mp plan', () => undefined); return; }
  const real = parsePlan(root, listC4Files(root));
  const ioDir = path.join(root, 'io');
  const refsOf = (html: string) => [...html.matchAll(/data-c4="([^"]+)"/g)].map(m => m[1]);
  const files = fs.readdirSync(ioDir).filter(f => f.endsWith('.html'));

  it('has the 3 wireframes and a clean plan', () => {
    expect(files.length).toBe(3);
    expect(real.issues).toEqual([]);
  });
  it('every ref resolves, nothing missing, refFor is never longer than the path', () => {
    let resolved = 0;
    for (const f of files) {
      const screen = f.replace(/\.html$/, '');
      const r = resolveWireRefs(real, screen, refsOf(fs.readFileSync(path.join(ioDir, f), 'utf-8')));
      expect(r.refs.filter(x => x.problem)).toEqual([]);
      expect(r.missing).toEqual([]);
      resolved += r.refs.length;
      for (const x of r.refs) {
        const short = refFor(real, screen, x.fqn as string) as string;
        expect(resolveWireRef(real, screen, short).fqn).toBe(x.fqn);
        expect(short.split('.').length).toBeLessThanOrEqual((x.fqn as string).slice(screen.length + 1).split('.').length);
      }
    }
    // distinct refs per file: map_page 45, io_view 5 (b608: only what #io&bare shows), own_window 5
    expect(resolved).toBe(55);
  });
});
