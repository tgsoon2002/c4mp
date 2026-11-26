// b924: scripts/find-browser.js, the one browser finder. Fake file-exists, no real browser needed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findBrowser } = require('../scripts/find-browser.js') as {
  findBrowser(o?: { env?: Record<string, string | undefined>; dumpDom?: boolean; exists?: (p: string) => boolean; platform?: string; home?: string }): string | null;
};

const HOME = '/nonexistent-home';   // no Playwright cache there
const only = (...paths: string[]) => (p: string) => paths.includes(p);
const find = (o: Parameters<typeof findBrowser>[0]) => findBrowser({ home: HOME, platform: 'darwin', env: {}, ...o });

describe('findBrowser', () => {
  it('env CHROME wins when the file exists', () => {
    expect(find({ env: { CHROME: '/x/my-chrome' }, exists: only('/x/my-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') })).toBe('/x/my-chrome');
  });
  it('env CHROME that does not exist is skipped', () => {
    expect(find({ env: { CHROME: '/x/gone' }, exists: only('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser') })).toBe('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  });
  it('macOS order: Chrome, Chrome for Testing, Chromium, Brave, Edge', () => {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].map(a => '/Applications/' + a);
    for (let i = 0; i < apps.length; i++) expect(find({ exists: only(...apps.slice(i)) })).toBe(apps[i]);
  });
  it('Linux places', () => {
    expect(find({ platform: 'linux', exists: only('/usr/bin/chromium') })).toBe('/usr/bin/chromium');
    expect(find({ platform: 'linux', exists: only('/usr/bin/chromium', '/usr/bin/google-chrome') })).toBe('/usr/bin/google-chrome');
  });
  it('dumpDom: true skips Brave and Edge (CDP only) but keeps Chrome kinds and env CHROME', () => {
    const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    expect(find({ dumpDom: true, exists: only(brave, edge) })).toBeNull();
    expect(find({ exists: only(brave, edge) })).toBe(brave);
    expect(find({ dumpDom: true, exists: only(brave, chromium) })).toBe(chromium);
    expect(find({ dumpDom: true, env: { CHROME: '/x/mine' }, exists: only('/x/mine', brave) })).toBe('/x/mine');
    expect(find({ dumpDom: true, platform: 'linux', exists: only('/usr/bin/brave-browser') })).toBeNull();
    expect(find({ dumpDom: true, platform: 'linux', exists: only('/usr/bin/brave-browser', '/usr/bin/chromium') })).toBe('/usr/bin/chromium');
  });
  it('none installed gives null', () => {
    expect(find({ exists: () => false })).toBeNull();
    expect(find({ platform: 'linux', exists: () => false })).toBeNull();
  });
});
