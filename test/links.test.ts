import * as path from 'path';
import { parseLink, formatLink } from '../src/plan/links';
import { generateC4 } from '../src/c4/generate';
import { runSnapshot } from '../src/pipeline';

describe('links', () => {
  describe('parseLink', () => {
    // Test cases from §3.1 Links table

    it('parses auth link', () => {
      const link = parseLink('./index.ts#L6-L13', 'src/api/auth/auth.c4', 'Token verify logic');
      expect(link.raw).toBe('./index.ts#L6-L13');
      expect(link.path).toBe('src/api/auth/index.ts');
      expect(link.lines).toEqual({ start: 6, end: 13 });
      expect(link.name).toBeNull();
      expect(link.title).toBe('Token verify logic');
    });

    it('parses orders link', () => {
      const link = parseLink('./index.ts#L7-L14', 'src/api/orders/orders.c4');
      expect(link.path).toBe('src/api/orders/index.ts');
      expect(link.lines).toEqual({ start: 7, end: 14 });
    });

    it('parses payments link to stripe.ts', () => {
      const link = parseLink('./stripe.ts', 'src/api/payments/payments.c4');
      expect(link.path).toBe('src/api/payments/stripe.ts');
      expect(link.name).toBeNull();
      expect(link.lines).toBeNull();
    });

    it('parses menu link to index.ts', () => {
      const link = parseLink('./index.ts', 'src/api/menu/menu.c4');
      expect(link.path).toBe('src/api/menu/index.ts');
    });

    it('parses notify link to index.ts', () => {
      const link = parseLink('./index.ts', 'src/api/notify/notify.c4');
      expect(link.path).toBe('src/api/notify/index.ts');
    });

    it('parses checkout link with line range', () => {
      const link = parseLink('./Checkout.tsx#L3-L14', 'src/web/pages/pages.c4');
      expect(link.path).toBe('src/web/pages/Checkout.tsx');
      expect(link.lines).toEqual({ start: 3, end: 14 });
    });

    it('parses menupage link', () => {
      const link = parseLink('./Menu.tsx', 'src/web/pages/pages.c4');
      expect(link.path).toBe('src/web/pages/Menu.tsx');
    });

    it('parses reviews link', () => {
      const link = parseLink('./Reviews.tsx', 'src/web/pages/pages.c4');
      expect(link.path).toBe('src/web/pages/Reviews.tsx');
    });

    it('parses function name fragment', () => {
      const link = parseLink('./index.ts#OrderService.create', 'src/api/');
      expect(link.path).toBe('src/api/index.ts');
      expect(link.name).toBe('OrderService.create');
      expect(link.lines).toBeNull();
    });

    it('parses relative path from nested c4 file', () => {
      const link = parseLink('../api/src/lib/', 'c4/api.c4');
      expect(link.path).toBe('api/src/lib/');
      expect(link.name).toBeNull();
      expect(link.lines).toBeNull();
    });

    it('parses absolute URL', () => {
      const link = parseLink('https://likec4.dev', 'c4/api.c4');
      expect(link.path).toBe('https://likec4.dev');
      expect(link.name).toBeNull();
      expect(link.lines).toBeNull();
    });

    it('parses single line number', () => {
      const link = parseLink('./index.ts#L7', 'src/api/auth/auth.c4');
      expect(link.lines).toEqual({ start: 7, end: 7 });
    });
  });

  describe('formatLink', () => {
    it('formats relative path from c4 to api lib folder', () => {
      const result = formatLink('api/src/lib/', 'c4');
      expect(result).toBe('../api/src/lib/');
    });

    it('formats relative path from c4 to api server.ts', () => {
      const result = formatLink('api/src/server.ts', 'c4');
      expect(result).toBe('../api/src/server.ts');
    });

    it('formats relative path from src to a.ts', () => {
      const result = formatLink('src/a.ts', 'src');
      expect(result).toBe('./a.ts');
    });

    it('formats relative path with name fragment', () => {
      const result = formatLink('src/a.ts', 'src', 'fn');
      expect(result).toBe('./a.ts#fn');
    });

    // B8: plan folder outside the repo (fromDir starts with '../'): same link from any cwd
    it('with repoRoot the result does not depend on the cwd', () => {
      const repoRoot = path.resolve(__dirname, '..');                  // e.g. <git root>/Project
      const fromDir = '../.c4pm/projects/c4pm/plan';
      const expected = '../../../../Project/src/a.ts';
      const original = process.cwd();
      try {
        for (const cwd of [repoRoot, path.dirname(repoRoot)]) {
          process.chdir(cwd);
          expect(formatLink('src/a.ts', fromDir, null, repoRoot)).toBe(expected.replace('Project', path.basename(repoRoot)));
        }
      } finally {
        process.chdir(original);
      }
    });

    // Edge targets where the two old implementations differed: one clean text now.
    it.each([
      ['src/', 'src', './'],                // folder equal to the plan folder: no './/' and no '././'
      ['src', 'src', './'],                 // was './.' (links) vs './' (generate)
      ['', 'c4', '..'],                     // repo root from c4/: was './..' vs '..'
      ['..foo/x.ts', '.', './..foo/x.ts'],  // a folder named '..foo' still gets './'
      ['c4/', 'c4/', './'],
    ])('edge %j from %j gives %j', (target, fromDir, expected) => {
      expect(formatLink(target, fromDir)).toBe(expected);
    });

    // Golden: plan generate and plan add/link write the same text for the same target. generate's link text, read back
    // through parseLink (what add/link starts from: the resolved path + name), formats to the identical text.
    it.each(['c4', '../.c4pm/projects/x/plan'])('generate output round-trips through formatLink (linkBase %s)', (linkBase) => {
      const fixture = path.join(__dirname, 'fixtures/sample');
      const snapshot = runSnapshot({ repo: fixture, write: false, quiet: true });
      const files = generateC4(snapshot, null, { functionLinks: true, linkBase, repoRoot: fixture });
      const raws = Object.values(files).flatMap(t => [...t.matchAll(/^\s*link (\S+)$/gm)].map(m => m[1]));
      expect(raws.length).toBeGreaterThan(0);
      for (const raw of raws) {
        const parsed = parseLink(raw, `${linkBase}/x.c4`);
        expect(formatLink(parsed.path, linkBase, parsed.name, fixture)).toBe(raw);
      }
    });
  });
});
