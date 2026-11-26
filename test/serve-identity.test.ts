import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SERVE_PORT_COUNT, SERVE_PORT_FIRST, serveKeyFor, servePortFor } from '../src/serve/identity';

// b920: the port and the link key kept per repo.

describe('serve identity (b920)', () => {
  let dir: string;
  let repo: string;
  let file: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-identity-')));
    repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    file = path.join(dir, 'user', 'serve-keys.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('servePortFor: in range, the same for the same path, a symlink to it and a second call', () => {
    const p = servePortFor(repo);
    expect(p).toBeGreaterThanOrEqual(SERVE_PORT_FIRST);
    expect(p).toBeLessThan(SERVE_PORT_FIRST + SERVE_PORT_COUNT);
    expect(servePortFor(repo)).toBe(p);
    const link = path.join(dir, 'link');
    fs.symlinkSync(repo, link);
    expect(servePortFor(link)).toBe(p);
  });

  it('serveKeyFor: the same key twice, stored under the real path, file mode 0600', () => {
    const a = serveKeyFor(repo, { fresh: false, file });
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(serveKeyFor(repo, { fresh: false, file })).toBe(a);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).keys[fs.realpathSync(repo)]).toBe(a);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('serveKeyFor: fresh makes another key and stores it', () => {
    const a = serveKeyFor(repo, { fresh: false, file });
    const b = serveKeyFor(repo, { fresh: true, file });
    expect(b).not.toBe(a);
    expect(serveKeyFor(repo, { fresh: false, file })).toBe(b);
  });

  it('serveKeyFor: a malformed stored key or a broken file gives a new key and a rewritten file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keys: { [fs.realpathSync(repo)]: 'short' } }));
    const a = serveKeyFor(repo, { fresh: false, file });
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    fs.writeFileSync(file, '{');
    const b = serveKeyFor(repo, { fresh: false, file });
    expect(b).not.toBe(a);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).keys[fs.realpathSync(repo)]).toBe(b);
  });

  it('serveKeyFor: two repos, two entries; other file content is kept', () => {
    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ note: 'x' }));
    const a = serveKeyFor(repo, { fresh: false, file });
    const b = serveKeyFor(other, { fresh: false, file });
    expect(b).not.toBe(a);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(data.keys)).toHaveLength(2);
    expect(data.note).toBe('x');
  });

  it('serveKeyFor: file null -> a new key each call and no file', () => {
    expect(serveKeyFor(repo, { fresh: false, file: null })).not.toBe(serveKeyFor(repo, { fresh: false, file: null }));
    expect(fs.existsSync(file)).toBe(false);
  });
});
