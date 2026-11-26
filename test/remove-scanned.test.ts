import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { addIgnoreFolder } from '../src/configIgnore';
import { removeElement } from '../src/services/planFileEdits';
import { runCli as spawnCli } from './helpers/runCli';
import { DATA_DIR } from '../src/constants';

// P14-T22c: addIgnoreFolder (pure) and `c4pm plan remove` of a scanned-only box.
const projectRoot = path.resolve(__dirname, '..');

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-rmscan-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('addIgnoreFolder', () => {
  it('missing file creates {ignore:[folder]}; trailing slash and ./ are normalised', () => {
    const f = path.join(tmp, 'config.json');
    const r = addIgnoreFolder(f, './legacy-svc/');
    expect(r.status).toBe('added');
    expect(r.before).toBe('');
    expect(JSON.parse(r.after)).toEqual({ ignore: ['legacy-svc'] });
    expect(r.after.endsWith('\n')).toBe(true);
    expect(fs.existsSync(f)).toBe(false); // pure: never writes
  });

  it('existing keys are kept; a present folder returns already', () => {
    const f = path.join(tmp, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ languages: ['python'], ignore: ['a'] }));
    const r = addIgnoreFolder(f, 'b');
    expect(r.status).toBe('added');
    expect(JSON.parse(r.after)).toEqual({ languages: ['python'], ignore: ['a', 'b'] });
    fs.writeFileSync(f, r.after);
    const again = addIgnoreFolder(f, 'b/');
    expect(again.status).toBe('already');
    expect(again.after).toBe(again.before);
  });

  it('invalid JSON, non-array ignore, "." and ".." are refused and nothing changes', () => {
    const f = path.join(tmp, 'config.json');
    fs.writeFileSync(f, '{ not json');
    const bad = addIgnoreFolder(f, 'x');
    expect(bad.status).toBe('refused');
    expect(bad.reason).toBe('config.json is not valid JSON');
    expect(fs.readFileSync(f, 'utf8')).toBe('{ not json');
    fs.writeFileSync(f, '{"ignore":"x"}');
    expect(addIgnoreFolder(f, 'y').status).toBe('refused');
    for (const folder of ['.', '', '..', '../up']) expect(addIgnoreFolder(path.join(tmp, 'none.json'), folder).status).toBe('refused');
  });
});

/** A repo with two scanned-only services (no plan): legacy-svc and keep-svc, each one root file. */
function twoServices(): string {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  for (const d of ['legacy-svc', 'keep-svc']) {
    fs.mkdirSync(path.join(repo, d));
    fs.writeFileSync(path.join(repo, d, 'package.json'), JSON.stringify({ name: d }));
    fs.writeFileSync(path.join(repo, d, 'a.ts'), 'export const a = 1;\n');
  }
  return repo;
}

// b504: removeElement finds the scanned box in Query's map model (no page build); nothing is written before write().
describe('removeElement: scanned-only box', () => {
  it.each([
    ['a container: its folder goes into ignore', 'legacy-svc', { kind: 'ignore', box: 'Legacy Svc', edit: { folder: 'legacy-svc', status: 'added' } }],
    ['a name two boxes share: ambiguous', 'Root files', { kind: 'scanned-ambiguous', matches: [{ id: 'keep-svc/_root' }, { id: 'legacy-svc/_root' }] }],
    ['the system (folder .): refused', 'repo', { kind: 'refused', message: expect.stringMatching(/^cannot remove 'repo': /) }],
    ['no box: none, no plan', 'nope-xyz', { kind: 'none', noPlan: true }],
  ])('%s', (_name, target, expected) => {
    const repo = twoServices();
    expect(removeElement(repo, target)).toMatchObject(expected);
    expect(fs.existsSync(path.join(repo, DATA_DIR, 'config.json'))).toBe(false);
  });
});

function runCli(args: string[]) {
  return spawnCli([...args], { cwd: projectRoot, encoding: 'utf8' });
}

describe('c4pm plan remove: scanned-only box', () => {
  it('dry run writes nothing; --yes adds the folder and the view loses it; a second --yes changes nothing', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'legacy-svc'));
    fs.mkdirSync(path.join(repo, 'keep-svc'));
    for (const d of ['legacy-svc', 'keep-svc']) {
      fs.writeFileSync(path.join(repo, d, 'package.json'), JSON.stringify({ name: d }));
      fs.writeFileSync(path.join(repo, d, 'a.ts'), 'export const a = 1;\n');
    }
    const configFile = path.join(repo, DATA_DIR, 'config.json');

    const dry = runCli(['plan', 'remove', 'legacy-svc', '--repo', repo]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("add 'legacy-svc' to ignore");
    expect(dry.stdout).toContain('dry run: nothing written');
    expect(fs.existsSync(configFile)).toBe(false);

    const page1 = path.join(tmp, 'a.html');
    runCli(['view', '--repo', repo, '--out', page1]);
    expect(fs.readFileSync(page1, 'utf8')).toContain('legacy-svc');

    const yes = runCli(['plan', 'remove', 'legacy-svc', '--repo', repo, '--yes']);
    expect(yes.status).toBe(0);
    expect(yes.stdout).toContain("added 'legacy-svc' to ignore");
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({ ignore: ['legacy-svc'] });

    const page2 = path.join(tmp, 'b.html');
    runCli(['view', '--repo', repo, '--out', page2]);
    const html2 = fs.readFileSync(page2, 'utf8');
    expect(html2).not.toContain('legacy-svc');
    expect(html2).toContain('keep-svc');

    // second --yes: the box is gone from the scan, file unchanged
    const bytes = fs.readFileSync(configFile, 'utf8');
    expect(runCli(['plan', 'remove', 'legacy-svc', '--repo', repo, '--yes']).status).toBe(1);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(bytes);
  });
});
