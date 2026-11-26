import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { embeddedAssetDir, findAssetDir } from '../src/assets';
import { guideDir } from '../src/guide';
import { viewerDir } from '../src/page/html';

describe('asset folder lookup', () => {
  it('embeddedAssetDir is the folder beside the entry script (Bun: /$bunfs/root/<name>)', () => {
    expect(embeddedAssetDir('viewer', '/$bunfs/root/c4pm')).toBe('/$bunfs/root/viewer');
    expect(embeddedAssetDir('guide', '/a/b/cli.js')).toBe(path.join('/a/b', 'guide'));
    expect(embeddedAssetDir('guide', '')).toBeNull();
  });

  it('findAssetDir returns the first candidate holding the marker and skips nulls', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-assets-'));
    try {
      const empty = path.join(tmp, 'empty');
      const full = path.join(tmp, 'full');
      fs.mkdirSync(empty);
      fs.mkdirSync(full);
      fs.writeFileSync(path.join(full, 'c4.md'), 'x');
      expect(findAssetDir([null, empty, full], 'c4.md')).toBe(full);
      expect(findAssetDir([null, empty], 'c4.md')).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('viewerDir and guideDir still resolve in the source tree', () => {
    expect(fs.existsSync(path.join(viewerDir(), 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(guideDir(), 'c4.md'))).toBe(true);
  });
});
