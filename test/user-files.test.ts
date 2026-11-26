import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanSettings, readUserJson, readUserSettings, userDir, userFile, writeUserJson } from '../src/util/userFiles';

describe('userFiles (b646)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-userfiles-')));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('userDir: off, a path, a relative path, the default', () => {
    expect(userDir({ C4PM_USER_DIR: 'off' }, '/h')).toBeNull();
    expect(userDir({ C4PM_USER_DIR: '/x/y' }, '/h')).toBe('/x/y');
    expect(userDir({ C4PM_USER_DIR: 'rel' }, '/h')).toBe(path.resolve('rel'));
    expect(userDir({}, '/h')).toBe(path.join('/h', '.c4mp'));
  });

  it('userFile: a name under the folder, null when off', () => {
    expect(userFile('settings.json', { C4PM_USER_DIR: '/d' })).toBe(path.join('/d', 'settings.json'));
    expect(userFile('settings.json', { C4PM_USER_DIR: 'off' })).toBeNull();
  });

  it.each([
    ['null', null, {}],
    ['missing', 'missing.json', {}],
    ['bad json', '{bad', {}],
    ['an array', '[1]', {}],
    ['a string', '"s"', {}],
    ['an object', '{"a":"b"}', { a: 'b' }],
  ])('readUserJson: %s', (_label, content, expected) => {
    let file: string | null = null;
    if (content !== null) {
      file = path.join(dir, 'f.json');
      if (content !== 'missing.json') fs.writeFileSync(file, content);
    }
    expect(readUserJson(file)).toEqual(expected);
  });

  it('writeUserJson: private folder and file, exact text, no temp left', () => {
    const file = path.join(dir, 'new', 'dir', 's.json');
    writeUserJson(file, { theme: 'dark' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "theme": "dark"\n}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('writeUserJson: an existing 0644 file becomes 0600', () => {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o644);
    writeUserJson(file, { a: 'b' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('cleanSettings: the six real keys pass unchanged', () => {
    const six = { theme: 'system', search: 'names', help: 'show', openIn: 'window', lightImpl: 'off', link: 'on' };
    expect(cleanSettings(six)).toEqual({ settings: six });
  });

  it.each([
    ['an array', [1], 'settings must be an object of setting names and words'],
    ['a number value', { a: 1 }, 'setting a: the value must be a lower-case word (letters, digits, dashes; at most 32)'],
    [
      '33 keys',
      Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`k${i}`, 'x'])),
      'too many settings: 33 (at most 32)',
    ],
    ['a bad name', { 'a b': 'x' }, "setting name 'a b' must be a letter then up to 31 letters or digits"],
    ['an upper-case value', { theme: 'Dark' }, 'setting theme: the value must be a lower-case word (letters, digits, dashes; at most 32)'],
    ['a 33-char value', { theme: 'a'.repeat(33) }, 'setting theme: the value must be a lower-case word (letters, digits, dashes; at most 32)'],
  ])('cleanSettings refuses %s', (_label, raw, error) => {
    expect(cleanSettings(raw)).toEqual({ error });
  });

  it('readUserSettings keeps only the entries that pass', () => {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', bad: 'X Y', '1x': 'a' }));
    expect(readUserSettings(file)).toEqual({ theme: 'dark' });
    expect(readUserSettings(null)).toEqual({});
  });

  it('globalSetup puts C4PM_USER_DIR under the run root', () => {
    const root = process.env.C4PM_TEST_TMP_ROOT as string;
    expect(root).toBeTruthy();
    expect(process.env.C4PM_USER_DIR?.startsWith(root)).toBe(true);
  });
});
