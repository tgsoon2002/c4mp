/**
 * b475 (ARR-CL-A1): the library API (src/index.ts) re-exports the Service functions; the old names keep working as
 * deprecated aliases. Every old name and every new one is imported from src/index here: an old name that vanished or
 * changed its signature fails the typecheck, one that changed its function fails the first table, and the cheap ones
 * are called beside their new Service function to show both give the same result.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  // old names (deprecated aliases)
  runSnapshot, compareSnapshots, formatText, formatMarkdown, parsePlan, checkPlan, generateC4, listC4Files,
  formatFindings, loadConfig, initConfig, DEFAULT_CONFIG, initProject, watchRepo, installHooks, uninstallHooks,
  // new names (the Service functions)
  openProject, setupProject, createConfig, takeSnapshot, recordHistory, listSnapshots, diffSnapshots, startWatch,
  formatDiff, runCheck, generatePlan, loadPlanState,
} from '../src/index';
import type { InitResult, Snapshot } from '../src/index';
import * as pipeline from '../src/pipeline';
import * as compare from '../src/compare/index';
import * as planFiles from '../src/plan/files';
import * as planParser from '../src/plan/parser';
import * as planChecks from '../src/c4/check';
import * as planGenerate from '../src/c4/generate';
import * as queryFormat from '../src/query/format';
import * as config from '../src/config';
import * as init from '../src/init';
import * as watch from '../src/watch';
import * as hooks from '../src/hooks';
import { markerAboveTmp } from './helpers/anchor';

const FIXTURES = path.join(__dirname, 'fixtures');
const tmpDirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-libapi-'));
  tmpDirs.push(d);
  return d;
};
const copyOf = (fixture: string): string => {
  const d = tmp();
  fs.cpSync(path.join(FIXTURES, fixture), d, { recursive: true });
  return d;
};
const scan = (repo: string): Snapshot => runSnapshot({ repo, write: false, quiet: true });
/** A snapshot without its creation time (the only field that differs between two scans of the same code). */
const timeless = (s: Snapshot) => ({ ...s, meta: { ...s.meta, createdAt: '' } });
/** initProject / setupProject's answer with the folder replaced, so two folders compare. */
const relative = (r: InitResult, dir: string) => JSON.parse(JSON.stringify(r).split(dir).join('<dir>'));
/** Writes into a temp folder are only safe when no .git / .c4pm above it would become the anchor. */
const noMarkerIt = markerAboveTmp() ? it.skip : it;

let repo: string;      // layers-claim: a plan (c4/plan.c4) and three files
let other: string;     // layers-folder: other code, so the diff is not empty

beforeAll(() => {
  repo = copyOf('layers-claim');
  other = copyOf('layers-folder');
});
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test.each([
  ['runSnapshot', runSnapshot, pipeline.runSnapshot],
  ['compareSnapshots', compareSnapshots, compare.compareSnapshots],
  ['formatText', formatText, compare.formatText],
  ['formatMarkdown', formatMarkdown, compare.formatMarkdown],
  ['parsePlan', parsePlan, planParser.parsePlan],
  ['checkPlan', checkPlan, planChecks.checkPlan],
  ['generateC4', generateC4, planGenerate.generateC4],
  ['listC4Files', listC4Files, planFiles.listC4Files],
  ['formatFindings', formatFindings, queryFormat.formatFindings],
  ['loadConfig', loadConfig, config.loadConfig],
  ['initConfig', initConfig, config.initConfig],
  ['DEFAULT_CONFIG', DEFAULT_CONFIG, config.DEFAULT_CONFIG],
  ['initProject', initProject, init.initProject],
  ['watchRepo', watchRepo, watch.watchRepo],
  ['installHooks', installHooks, hooks.installHooks],
  ['uninstallHooks', uninstallHooks, hooks.uninstallHooks],
] as [string, unknown, unknown][])('old name %s is still the same function or value', (_name, now, before) => {
  expect(now).toBe(before);
});

test.each([
  openProject, setupProject, createConfig, takeSnapshot, recordHistory, listSnapshots, diffSnapshots, startWatch,
  formatDiff, runCheck, generatePlan, loadPlanState,
].map((fn) => [fn.name, fn]))('new name %s is exported', (_name, fn) => {
  expect(typeof fn).toBe('function');
});

describe('old and new names give the same result', () => {
  it('runSnapshot and takeSnapshot build the same snapshot', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const taken = takeSnapshot(repo, {}, { out: tmp() });
      expect(timeless(taken.snapshot)).toEqual(timeless(scan(repo)));
      expect(taken.saved).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it('compareSnapshots and diffSnapshots give the same diff; DEFAULT_CONFIG gives its failOn', () => {
    const a = scan(repo);
    const b = scan(other);
    const dir = tmp();
    const files = { a: path.join(dir, 'a.json'), b: path.join(dir, 'b.json') };
    fs.writeFileSync(files.a, JSON.stringify(a));
    fs.writeFileSync(files.b, JSON.stringify(b));
    const diff = compareSnapshots(a, b);
    expect(diffSnapshots(null, {}, { files })).toEqual({ diff, failOn: DEFAULT_CONFIG.failOn });
  });

  test.each([
    ['formatText', 'text', formatText],
    ['formatMarkdown', 'markdown', formatMarkdown],
  ] as const)('%s and formatDiff(diff, %p) give the same text', (_name, format, old) => {
    const diff = compareSnapshots(scan(repo), scan(other));
    expect(formatDiff(diff, format)).toBe(old(diff));
  });

  it('listC4Files + parsePlan and loadPlanState read the same plan', () => {
    const state = loadPlanState(repo);
    expect(state?.plan).toEqual(parsePlan(repo, listC4Files(repo)));
  });

  it('checkPlan and runCheck give the same findings (no board)', () => {
    const r = runCheck(repo, {}, {});
    expect(r).not.toBeNull();
    expect(r!.findings).toEqual(checkPlan(r!.plan, r!.snapshot, repo));
  });

  it('generateC4 and generatePlan draft the same plan files', () => {
    const out = tmp();
    const { files } = generatePlan(repo, {}, { out });
    const drafted = generateC4(scan(repo), parsePlan(repo, listC4Files(repo)), { linkBase: path.relative(repo, out), repoRoot: repo });
    const uidless = (text: string) => text.replace(/uid '[^']*'/g, "uid ''");   // generate mints a new uid per element
    const written = Object.fromEntries(files.map((f) => [path.basename(f), uidless(fs.readFileSync(f, 'utf8'))]));
    expect(written).toEqual(Object.fromEntries(Object.entries(drafted).map(([f, text]) => [f, uidless(text)])));
  });

  noMarkerIt('loadConfig and openProject read the same config', () => {
    expect(openProject(repo).config).toEqual(loadConfig(repo));
  });

  it('initConfig and createConfig write the same config file', () => {
    const [a, b] = [tmp(), tmp()];
    expect(fs.readFileSync(createConfig(b), 'utf8')).toBe(fs.readFileSync(initConfig(a), 'utf8'));
  });

  noMarkerIt('initProject and setupProject create the same folders', () => {
    // the project id comes from the folder name: both folders are called repo
    const [a, b] = [tmp(), tmp()].map((d) => path.join(d, 'repo'));
    [a, b].forEach((d) => fs.mkdirSync(d));
    expect(relative(setupProject(b), b)).toEqual(relative(initProject(a), a));
  });
});
