// b917 S3: recordSim and makeSink through a real headless browser (scripts/cdp-page.js) on a small page with a stub C4PM_SIM.
// Skipped when no Chrome-like browser is installed (test/helpers/chrome.ts, scripts/find-browser.js).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cdpChromeInstalled as chromeInstalled } from './helpers/chrome';

/* eslint-disable @typescript-eslint/no-var-requires */
const cdp = require('../scripts/cdp-page.js');
const rec = require('../scripts/media-record.js');
/* eslint-enable @typescript-eslint/no-var-requires */

jest.setTimeout(90000);

const PAGE = `<script>
window.C4PM_MAP = {}; window.C4PM_STATE = { map: { cw: 1 } };
const colors = ['#c33', '#3c3', '#33c'];
const paint = i => { document.body.style.background = colors[i]; };
window.C4PM_SIM = {
  items: () => [{ id: 's-1' }],
  steps: () => [0, 1, 2],
  hooks: { present: (id, at) => paint(at), presentGo: i => paint(i) },
};
</script><body style="margin:0"></body>`;

(chromeInstalled ? describe : describe.skip)('recordSim (real browser, stub C4PM_SIM)', () => {
  let tmp: string;
  let page: { goto(u: string): Promise<void>; shot(): Promise<Buffer>; close(): void } | undefined;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel#media-'));
    fs.writeFileSync(path.join(tmp, 'p.html'), PAGE);
    page = await cdp.launch({ width: 160, height: 90 });
    await page!.goto(cdp.fileUrl(path.join(tmp, 'p.html')));
  });
  afterAll(() => { if (page) page.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('films three steps: every step has its own colour and the hold frames are hard links', async () => {
    const dir = path.join(tmp, 'frames');
    const sink = rec.makeSink(page, dir, 5);
    const r = await rec.recordSim(page, sink, { stepSec: 1, flyMs: 0, outroSec: 0 });
    expect(r.steps.map((s: { frames: number }) => s.frames)).toEqual([5, 5, 5]);
    expect(fs.readdirSync(dir)).toHaveLength(15);
    const inode = (n: number) => fs.statSync(path.join(dir, 'f' + String(n).padStart(5, '0') + '.png')).ino;
    expect(new Set([1, 2, 3, 4, 5].map(inode)).size).toBe(1);   // one shot, held 5 frames
    expect(new Set([inode(1), inode(6), inode(11)]).size).toBe(3);   // three different steps
    expect(fs.statSync(path.join(dir, 'f00001.png')).nlink).toBe(5);
  });
});
