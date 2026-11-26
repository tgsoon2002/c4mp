import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openInBrowser, openerFor } from '../src/cli/openBrowser';

const URL_TOKEN = 'http://127.0.0.1:5/#t=SECRET';

describe('openBrowser', () => {
  let tmp: string;
  let calls: Array<{ cmd: string; args: string[] }>;
  let warns: string[];
  const base = () => ({
    tmpDir: tmp,
    run: (cmd: string, args: string[], done: (e: Error | null) => void) => {
      calls.push({ cmd, args });
      done(null);
    },
    warn: (l: string) => warns.push(l),
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-test-'));
    calls = [];
    warns = [];
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('openerFor picks the command per platform', () => {
    expect(openerFor('darwin', 'x')).toEqual({ cmd: 'open', args: ['x'] });
    expect(openerFor('win32', 'x')).toEqual({ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', 'x'] });
    expect(openerFor('linux', 'x')).toEqual({ cmd: 'xdg-open', args: ['x'] });
  });

  it('opens a plain path directly, no launcher folder', () => {
    const r = openInBrowser('/a/b/view.html', { ...base(), platform: 'linux' });
    expect(calls[0].args).toEqual(['/a/b/view.html']);
    expect(r.launcher).toBeNull();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('hides the token behind a 0600 launcher file', () => {
    const r = openInBrowser(URL_TOKEN, { ...base(), platform: 'linux' });
    const arg = calls[0].args[0];
    expect(arg).not.toContain('SECRET');
    expect(arg.startsWith(tmp)).toBe(true);
    expect(r.launcher).toBe(arg);
    if (process.platform !== 'win32') expect(fs.statSync(arg).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(arg, 'utf8');
    expect(text.split(URL_TOKEN).length - 1).toBe(1);
    expect(text).toContain('location.replace(');
    r.cleanup();
  });

  it('a </script> inside the URL cannot close the script', () => {
    const r = openInBrowser('http://h/</script>#t=K', { ...base(), platform: 'linux' });
    const text = fs.readFileSync(r.launcher as string, 'utf8');
    expect(text.split('</script>').length - 1).toBe(1);
    r.cleanup();
  });

  it('cleanup removes the folder and is safe twice', () => {
    const r = openInBrowser(URL_TOKEN, { ...base(), platform: 'linux' });
    const dir = path.dirname(r.launcher as string);
    r.cleanup();
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => r.cleanup()).not.toThrow();
  });

  it('an opener error becomes one warning line', () => {
    openInBrowser('/a.html', {
      ...base(),
      run: (_c, _a, done) => done(new Error('boom')),
    });
    expect(warns).toEqual(['Warning: could not open the browser: boom']);
  });

  it('an unwritable tmpDir warns, launcher null, run not called', () => {
    const r = openInBrowser(URL_TOKEN, { ...base(), tmpDir: path.join(tmp, 'missing', 'deeper') });
    expect(r.launcher).toBeNull();
    expect(calls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^Warning: could not open the browser: /);
  });
});
