// b643 (Phase 30 SV1): writeProjectView writes the page with writeAtomic (temp + rename), so a killed run or a failed
// build never leaves a half-written c4mpView.html.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportPageData, writeProjectView } from '../src/page/viewExport';
import { buildPageModel, pageData } from '../src/page/html';
import { runCli } from './helpers/runCli';
import { initProject } from '../src/init';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-viewexport-')));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export function a() { return 1; }\n');
  initProject(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tempFiles = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

describe('writeProjectView (b643)', () => {
  it('writes the page, a second call replaces it, and no temp file is left', () => {
    const page = writeProjectView(tmp);
    expect(fs.readFileSync(page, 'utf8')).toContain('C4PM_MAP');
    fs.writeFileSync(page, 'old page');

    expect(writeProjectView(tmp)).toBe(page);
    expect(fs.readFileSync(page, 'utf8')).toContain('C4PM_MAP');
    expect(tempFiles(path.dirname(page))).toEqual([]);
  });

  it('keeps the mode of an existing page', () => {
    const page = writeProjectView(tmp);
    fs.chmodSync(page, 0o640);
    writeProjectView(tmp);
    expect(fs.statSync(page).mode & 0o7777).toBe(0o640);
  });

  it('leaves the old page byte for byte when the build throws (no stored snapshot for --from)', () => {
    // An unreadable plan file does not make buildView throw (parsePlan keeps it as a "read failed" issue), so the
    // throw comes from driftFrom inside buildView, after the scan: the ref has no stored snapshot.
    const page = writeProjectView(tmp);
    const old = fs.readFileSync(page);
    expect(() => writeProjectView(tmp, { from: 'no-such-ref' })).toThrow();
    expect(fs.readFileSync(page).equals(old)).toBe(true);
    expect(tempFiles(path.dirname(page))).toEqual([]);
  });

  it('a failed write reads `cannot write <file>: <reason>` and keeps the old page', () => {
    const page = writeProjectView(tmp);
    const old = fs.readFileSync(page);
    const dir = path.dirname(page);
    fs.chmodSync(dir, 0o555);   // the temp file cannot be made next to the page
    try {
      expect(() => writeProjectView(tmp)).toThrow(`cannot write ${page}: permission denied`);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(page).equals(old)).toBe(true);
    expect(tempFiles(dir)).toEqual([]);
  });
});

// b914 / b61: the page-build option noSource, and the data-only export the live page's Export button uses.
const BODY_LINE = 'export function a() { return 1; }';
const dataOf = (html: string): any => JSON.parse(html.match(/window\.C4PM_DATA = ([^\n]*);(?:<\/script>)?\n/)![1]);
const codeOn = (html: string): boolean => {
  const found: boolean[] = [];
  const walk = (n: any): void => { if ('code' in n) found.push(true); (n.children ?? []).forEach(walk); (n.subregions ?? []).forEach(walk); };
  walk(dataOf(html).root);
  return found.length > 0;
};
const liveData = (): string => JSON.stringify(pageData(buildPageModel({ repo: tmp }).model));

describe('writeProjectView noSource (b914)', () => {
  it('writes a page without code, a second call without the option writes it complete again', () => {
    const page = writeProjectView(tmp, { noSource: true });
    expect(codeOn(fs.readFileSync(page, 'utf8'))).toBe(false);
    expect(dataOf(fs.readFileSync(page, 'utf8')).repoPath).toBe('');
    writeProjectView(tmp);
    expect(codeOn(fs.readFileSync(page, 'utf8'))).toBe(true);
  });
});

describe('exportPageData (b914)', () => {
  it('writes the anchor page complete and returns the same bytes, the download name and the file', () => {
    const written = writeProjectView(tmp);
    const before = fs.readFileSync(written, 'utf8');
    const out = exportPageData(tmp, {}, liveData(), { noSource: false });
    expect(out.file).toBe(written);
    expect(out.name).toMatch(/^c4mp-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.html$/);
    expect(out.html).toBe(fs.readFileSync(out.file, 'utf8'));
    expect(out.html).toBe(before);
  });

  it('noSource: the file stays complete, the returned copy has no source', () => {
    const out = exportPageData(tmp, {}, liveData(), { noSource: true });
    const file = fs.readFileSync(out.file, 'utf8');
    expect(file).toContain(BODY_LINE);
    expect(codeOn(file)).toBe(true);
    expect(out.html).not.toContain(BODY_LINE);
    expect(codeOn(out.html)).toBe(false);
  });

  it('no anchor: the init hint, nothing written', () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-noanchor-')));
    try {
      expect(() => exportPageData(bare, {}, liveData(), { noSource: false })).toThrow(/No .c4mp or .git found/);
      expect(fs.readdirSync(bare)).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a read-only export folder: `cannot write <file>`, the old page stays, no temp file', () => {
    if (process.getuid && process.getuid() === 0) return;   // root ignores the mode
    const page = writeProjectView(tmp);
    const old = fs.readFileSync(page);
    const dir = path.dirname(page);
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => exportPageData(tmp, {}, liveData(), { noSource: false })).toThrow(`cannot write ${page}`);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(page).equals(old)).toBe(true);
    expect(tempFiles(dir)).toEqual([]);
  });
});

describe('c4pm view --no-source (b914)', () => {
  it('writes the copy to --out without source; the default page is not written', () => {
    const share = path.join(tmp, 'share.html');
    const r = runCli(['view', '--repo', tmp, '--no-source', '--out', share]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(share);
    const html = fs.readFileSync(share, 'utf8');
    expect(html).not.toContain(BODY_LINE);
    expect(html).not.toContain(tmp);
    expect(codeOn(html)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'C4MP'))).toBe(false);
  });
});
