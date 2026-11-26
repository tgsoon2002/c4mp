import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSourceFiles } from '../src/importer/walk';
import { SOURCE_EXTENSIONS } from '../src/languages/registry';

const fixtureRoot = path.join(__dirname, 'fixtures', 'sample');
const walkTs = (root: string) => listSourceFiles(root, { extensions: SOURCE_EXTENSIONS });

describe('walk', () => {
  it('lists source files from fixture in correct order', () => {
    const files = walkTs(fixtureRoot);
    expect(files).toEqual([
      'api/src/lib/log.ts',
      'api/src/lib/missing-user.ts',
      'api/src/models/order.ts',
      'api/src/routes/orders.ts',
      'api/src/server.ts',
      'api/src/services/orderService.ts',
      'web/src/App.tsx',
      'web/src/components/Cart.jsx',
    ]);
  });

  it('skips ignored directories and extensions', () => {
    const files = walkTs(fixtureRoot);
    // Should not include node_modules, dist, or .d.ts files
    expect(files).not.toContain('node_modules/ignored/index.js');
    expect(files).not.toContain('dist/bundle.js');
    expect(files).not.toContain('api/src/types.d.ts');
    expect(files).not.toContain('worker/main.py');
  });

  it('throws error for nonexistent path', () => {
    expect(() => {
      walkTs('/nonexistent/path/that/does/not/exist');
    }).toThrow(/Not a directory/);
  });

  it('throws error for non-directory path', () => {
    const filePath = path.join(fixtureRoot, 'package.json');
    expect(() => {
      walkTs(filePath);
    }).toThrow(/Not a directory/);
  });

  it('skips the C4PM export folder at an anchor but not a nested C4PM folder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-walk-'));
    try {
      fs.mkdirSync(path.join(tmp, '.c4pm'));
      for (const d of ['src', 'C4PM', 'src/C4PM']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
      for (const f of ['src/a.ts', 'C4PM/x.ts', 'src/C4PM/y.ts']) fs.writeFileSync(path.join(tmp, f), 'export {};');
      expect(walkTs(tmp)).toEqual(['src/C4PM/y.ts', 'src/a.ts']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
