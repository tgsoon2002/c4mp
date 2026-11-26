// b917 S1: scripts/cdp-page.js drives one headless Chrome page. Chrome cases skip when Chrome is not installed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cdpChromeInstalled as chromeInstalled } from './helpers/chrome';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cdp = require('../scripts/cdp-page.js') as {
  launch(o: { width: number; height: number; chrome?: string }): Promise<Page>;
  fileUrl(file: string, hash?: string): string;
};
interface Page {
  goto(url: string): Promise<void>;
  eval(expr: string): Promise<unknown>;
  shot(file?: string): Promise<Buffer>;
  close(): void;
  dir: string;
}

jest.setTimeout(60000);

describe('fileUrl', () => {
  it('encodes every segment (a # in the path) and appends the hash', () => {
    expect(cdp.fileUrl('/a/b#c/p.html', '#io')).toBe('file:///a/b%23c/p.html#io');
  });
});

(chromeInstalled ? describe : describe.skip)('launch (headless Chrome)', () => {
  let page: Page | undefined;
  let tmp: string;
  let url: string;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp#page-'));
    const file = path.join(tmp, 'p.html');
    fs.writeFileSync(file, '<script>window.C4PM_MAP={};window.C4PM_STATE={map:{cw:1}};</script><body style="background:#fff">x</body>');
    url = cdp.fileUrl(file);
    page = await cdp.launch({ width: 320, height: 200 });
    await page.goto(url);
  });
  afterAll(() => { if (page) page.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('goto resolves and eval returns a value', async () => {
    expect(await page!.eval('1+1')).toBe(2);
  });
  it('eval rejects when the page code throws', async () => {
    await expect(page!.eval('null.x')).rejects.toThrow(/page eval failed/);
  });
  it('shot returns a PNG of the window size', async () => {
    const buf = await page!.shot();
    expect(buf.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(buf.readUInt32BE(16)).toBe(320);
    expect(buf.readUInt32BE(20)).toBe(200);
  });
  it('close is idempotent and removes the profile folder', () => {
    const dir = page!.dir;
    page!.close();
    expect(() => page!.close()).not.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
