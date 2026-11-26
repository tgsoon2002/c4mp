// b951 (Phase 35 I): scripts/render-brand.js argument handling and target list (no browser).
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rb = require('../scripts/render-brand.js') as {
  parseBrandArgs(argv: string[]): { out: string };
  brandTargets(out: string): Array<{ file: string; kind: string; svg?: string }>;
};

describe('parseBrandArgs', () => {
  it('defaults to Brand/png and takes --out as an absolute path', () => {
    expect(rb.parseBrandArgs([]).out).toMatch(/[Bb]rand[\\/]png$/);   // private repo: ../Brand/png; public tree: brand/png (b985)
    expect(rb.parseBrandArgs(['--out', 'x/y']).out).toBe(path.resolve('x/y'));
  });
  it.each([[['--out']], [['--out', '--x']], [['--bogus']]])('rejects %j', argv => {
    expect(() => rb.parseBrandArgs(argv)).toThrow();
  });
});

describe('brandTargets', () => {
  const out = path.resolve('/tmp/brand-out');
  const targets = rb.brandTargets(out);
  it('lists 17 files, all inside out, no duplicates', () => {
    expect(targets).toHaveLength(17);
    expect(new Set(targets.map(t => t.file)).size).toBe(17);
    for (const t of targets) expect(path.dirname(t.file)).toBe(out);
  });
  it('names the icon sizes, wordmarks, social images and favicon', () => {
    const names = targets.map(t => path.basename(t.file));
    for (const n of ['c4mp-icon-512.png', 'c4mp-icon-dark-16.png', 'c4mp-icon-180.png', 'c4mp-logo-light@2x.png', 'c4mp-logo-dark.png', 'social-preview.png', 'social-preview-light.png', 'favicon.ico']) {
      expect(names).toContain(n);
    }
  });
  it('every source svg exists in Brand/logo (public tree: brand/logo)', () => {
    // The private repo has ../Brand; the public tree has brand/ at its root (a different case matters on Linux) (b963).
    const logoDir = ['Brand', 'brand'].map(d => path.join(__dirname, '..', '..', d, 'logo')).concat(path.join(__dirname, '..', 'brand', 'logo')).find(d => fs.existsSync(d))!;
    for (const t of targets.filter(x => x.svg)) expect(fs.existsSync(path.join(logoDir, t.svg as string))).toBe(true);
  });
});
