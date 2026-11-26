import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { privatePlanDir } from './helpers/privateRepo';
import { parsePlan } from '../src/plan/parser';
import { listC4Files } from '../src/plan/files';
import { loadWireframes, WIREFRAME_MAX_BYTES } from '../src/c4/wireframeFiles';
import { checkWireframes } from '../src/c4/wireframeCheck';
import { runCheck } from '../src/query/check';
import { runPlanCli, makeRepo } from './helpers/planEditHarness';
import type { Plan, PlanFinding } from '../src/types';

// W7 (b303): the wireframe rules (PHASE_20_WIREFRAMES.md section 6, C5; Q1). Each case runs on a throw-away plan folder.

const PLAN = [
  'model {',
  "  shop = system 'Shop' {",
  "    web = container 'Web' {",
  "      home = screen 'Home' {",
  "        top_bar = region 'Top bar' {",
  "          search = control 'Search'",
  "          logo = control 'Logo'",
  '        }',
  "        side = region 'Side' {",
  "          logo = control 'Side logo'",
  '        }',
  "        loading = state 'Loading'",
  '      }',
  "      cart = screen 'Cart'",
  '    }',
  '  }',
  '}',
  '',
].join('\n');
const HOME_OK = '<div data-c4="top_bar"><i data-c4="search"></i><i data-c4="top_bar.logo"></i></div><div data-c4="side"><i data-c4="side.logo"></i></div>';
const CART_OK = '<div class="cart"></div>';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-wfc-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A repo with the plan in `c4/` and the given files under `c4/` (io files as `io/<name>`). */
function setup(files: Record<string, string>): { repo: string; dir: string; plan: Plan } {
  const dir = path.join(tmp, 'c4');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shop.c4'), PLAN);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return { repo: tmp, dir, plan: parsePlan(tmp, listC4Files(tmp)) };
}
function check(files: Record<string, string>, prepare?: (dir: string) => void): PlanFinding[] {
  const s = setup(files);
  if (prepare) prepare(s.dir);
  return checkWireframes(s.plan, loadWireframes(s.repo, s.dir, s.plan.elements.filter(e => e.kind === 'screen').map(e => e.id)));
}

describe('checkWireframes', () => {
  it('up to date files with classes only: no finding (a state needs no data-c4; dotted paths pick one of two logos)', () => {
    expect(check({ 'io/shop.web.home.html': HOME_OK, 'io/shop.web.cart.html': CART_OK })).toEqual([]);
  });

  it('unsupported (no plan folder) -> []', () => {
    const s = setup({});
    expect(checkWireframes(s.plan, loadWireframes(s.repo, null, ['shop.web.home']))).toEqual([]);
  });

  it('no io/ folder -> no wireframe-missing (K2)', () => {
    expect(check({})).toEqual([]);
  });

  it('wireframe-missing: a screen without a file, when io/ exists', () => {
    expect(check({ 'io/shop.web.home.html': HOME_OK })).toEqual([
      { severity: 'info', rule: 'wireframe-missing', id: 'shop.web.cart', message: 'Cart: no wireframe (io/shop.web.cart.html)' },
    ]);
  });

  it('wireframe-missing: a file c4pm cannot use (symlink, over 512 KB) says why and the fix, although it exists (Q1)', () => {
    const got = check({ 'io/shop.web.cart.html': 'x'.repeat(WIREFRAME_MAX_BYTES + 1), 'elsewhere.html': HOME_OK }, dir => {
      fs.symlinkSync(path.join(dir, 'elsewhere.html'), path.join(dir, 'io', 'shop.web.home.html'));
    });
    expect(got).toEqual([
      {
        severity: 'info', rule: 'wireframe-missing', id: 'shop.web.cart',
        message: 'shop.web.cart: io/shop.web.cart.html skipped (is 513 KB, over the 512 KB cap); move shared layout to io/site.css',
      },
      {
        severity: 'info', rule: 'wireframe-missing', id: 'shop.web.home',
        message: 'shop.web.home: io/shop.web.home.html skipped (is a symbolic link, not followed); kept out for safety; write it as a plain file in io/',
      },
    ]);
  });

  it('wireframe-missing: an io/ that is not a plain folder gives every screen the reason and the fix', () => {
    const got = check({ io: 'not a folder' });
    expect(got.map(f => [f.rule, f.severity, f.id])).toEqual([
      ['wireframe-missing', 'info', 'shop.web.cart'],
      ['wireframe-missing', 'info', 'shop.web.home'],
    ]);
    expect(got[0].message).toBe('shop.web.cart: no wireframe read, c4/io skipped (io is not a folder); make c4/io a plain folder in the plan folder');
  });

  it('wireframe-out-of-date: one finding per missing part, unknown ref and ambiguous ref, with the screen as id', () => {
    const home = '<div data-c4="top_bar"><i data-c4="logo"></i><i data-c4="nope"></i></div><div data-c4="side"><i data-c4="side.logo"></i></div>';
    expect(check({ 'io/shop.web.home.html': home, 'io/shop.web.cart.html': CART_OK })).toEqual([
      { severity: 'warning', rule: 'wireframe-out-of-date', id: 'shop.web.home', message: 'no data-c4 for top_bar.logo' },
      { severity: 'warning', rule: 'wireframe-out-of-date', id: 'shop.web.home', message: 'no data-c4 for top_bar.search' },
      {
        severity: 'warning', rule: 'wireframe-out-of-date', id: 'shop.web.home',
        message: 'data-c4 "logo" names 2 parts (side.logo, top_bar.logo); write the dotted path',
      },
      { severity: 'warning', rule: 'wireframe-out-of-date', id: 'shop.web.home', message: 'data-c4 "nope" names nothing under the screen' },
    ]);
  });

  it('wireframe-orphan: an io/*.html that names no screen, after the screens', () => {
    expect(check({ 'io/shop.web.home.html': HOME_OK, 'io/shop.web.cart.html': CART_OK, 'io/shop.web.basket.html': 'x' })).toEqual([
      { severity: 'warning', rule: 'wireframe-orphan', id: 'c4/io/shop.web.basket.html', message: 'c4/io/shop.web.basket.html names no screen of the plan (renamed or removed?)' },
    ]);
  });

  it('wireframe-inline-style: one info per file with its counts; comments and inlined sheets do not count', () => {
    const home = '<!-- <i style="a"></i> --><link rel="stylesheet" href="site.css"><style>.x{}</style>' + HOME_OK.replace('<i data-c4="search">', '<i data-c4="search" style="width:1px">');
    expect(check({ 'io/site.css': '.x { width: 1px; }', 'io/shop.web.home.html': home, 'io/shop.web.cart.html': CART_OK })).toEqual([
      {
        severity: 'info', rule: 'wireframe-inline-style', id: 'c4/io/shop.web.home.html',
        message: 'c4/io/shop.web.home.html: 1 style attribute(s), 1 <style> block(s); move them to classes in io/site.css',
      },
    ]);
  });

  it('wireframe-bad-stylesheet: one warning per dropped link, the screen is still checked', () => {
    const home = '<link rel="stylesheet" href="https://x.test/a.css"><link rel="icon" href="a.css">' + HOME_OK;
    expect(check({ 'io/shop.web.home.html': home, 'io/shop.web.cart.html': CART_OK })).toEqual([
      { severity: 'warning', rule: 'wireframe-bad-stylesheet', id: 'c4/io/shop.web.home.html', message: '<link href="https://x.test/a.css"> dropped: a URL, not a relative path' },
      { severity: 'warning', rule: 'wireframe-bad-stylesheet', id: 'c4/io/shop.web.home.html', message: '<link href="a.css"> dropped: rel is not "stylesheet"' },
    ]);
  });
});

describe('wireframe rules on real plans', () => {
  it('io-shop: 3 wireframe-missing (login, products, cart); home has inline styles', () => {
    const repo = path.join(__dirname, 'fixtures', 'io-shop');
    const wf = runCheck(repo, {}, {})!.findings.filter(f => f.rule.startsWith('wireframe-'));
    expect(wf.filter(f => f.rule === 'wireframe-missing').map(f => f.id)).toEqual(['shop.web.cart', 'shop.web.login', 'shop.web.products']);
    expect(wf.filter(f => f.rule !== 'wireframe-missing')).toEqual([
      { severity: 'info', rule: 'wireframe-inline-style', id: 'c4/io/shop.web.home.html', message: expect.stringMatching(/^c4\/io\/shop\.web\.home\.html: 9 style attribute\(s\), 1 <style> block\(s\);/) },
    ]);
  });

  // Private plan only: the public tree has no ../.c4mp, so the test skips there (b963).
  (privatePlanDir() ? it : it.skip)('C4PM: its own wireframes give no wireframe finding (all screens have a file, refs up to date, classes only since b603)', () => {
    const repo = path.resolve(__dirname, '..');
    const ioDir = path.join(privatePlanDir()!, 'io');
    expect(fs.readdirSync(ioDir).filter(n => n.endsWith('.html')).length).toBeGreaterThan(0);
    expect(runCheck(repo, {}, {})!.findings.filter(f => f.rule.startsWith('wireframe-'))).toEqual([]);
  }, 180000);
});

describe('the write gate never sees the wireframe rules (T3)', () => {
  it('plan add control under a wireframed screen with --check is not refused; check then reports it', async () => {
    const repo = makeRepo('c4pm-wfc-gate-', { 'shop.c4': PLAN });
    try {
      fs.mkdirSync(path.join(repo.planDir, 'io'));
      fs.writeFileSync(path.join(repo.planDir, 'io', 'shop.web.home.html'), HOME_OK);
      fs.writeFileSync(path.join(repo.planDir, 'io', 'shop.web.cart.html'), CART_OK);
      expect(runCheck(repo.root, {}, {})!.findings.filter(f => f.rule.startsWith('wireframe-'))).toEqual([]);
      const r = await runPlanCli(['plan', 'add', 'control', 'Basket', '--parent', 'shop.web.home.top_bar', '--check', '--yes', '--repo', repo.root]);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(fs.readFileSync(repo.files['shop.c4'], 'utf8')).toContain("Basket = control 'Basket'");
      expect(runCheck(repo.root, {}, {})!.findings.filter(f => f.rule.startsWith('wireframe-'))).toEqual([
        { severity: 'warning', rule: 'wireframe-out-of-date', id: 'shop.web.home', message: 'no data-c4 for top_bar.Basket' },
      ]);
    } finally {
      fs.rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
