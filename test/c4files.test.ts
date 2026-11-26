import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listC4Files } from '../src/plan/files';

describe('listC4Files', () => {
  const fixtureDir = path.join(__dirname, 'fixtures');

  it('finds all .c4 files in phofast fixture', () => {
    const phofast = path.join(fixtureDir, 'phofast');
    const files = listC4Files(phofast);

    expect(files).toEqual([
      'src/api/auth/auth.c4',
      'src/api/menu/menu.c4',
      'src/api/notify/notify.c4',
      'src/api/orders/orders.c4',
      'src/api/payments/payments.c4',
      'src/architecture.c4',
      'src/web/pages/pages.c4',
    ]);
  });

  it('returns empty array for sample fixture (no .c4 files)', () => {
    const sample = path.join(fixtureDir, 'sample');
    const files = listC4Files(sample);

    expect(files).toEqual([]);
  });

  it('throws for nonexistent path', () => {
    const nonexistent = path.join(fixtureDir, 'nonexistent');

    expect(() => {
      listC4Files(nonexistent);
    }).toThrow('Not a directory');
  });

  it('skips the C4PM export folder at an anchor but not a nested C4PM folder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-c4files-'));
    try {
      fs.mkdirSync(path.join(tmp, '.c4pm'));
      for (const d of ['src', 'C4PM', 'src/C4PM']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
      for (const f of ['src/a.c4', 'C4PM/x.c4', 'src/C4PM/y.c4']) fs.writeFileSync(path.join(tmp, f), '');
      expect(listC4Files(tmp)).toEqual(['src/C4PM/y.c4', 'src/a.c4']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
