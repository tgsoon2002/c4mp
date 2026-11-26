// Real-repository run: scans a cloned open-source project, then replays its
// fixed issues. Issues come from git history (commits that say "fix #123" or
// "(#123)"), so each one has ground truth: the source files the fix changed.
// For each issue it asks three questions:
//   find   - do `c4pm find` hits for words in the issue title land on a fixed file?
//   map    - is every fixed file on the map (owned by a component), so it can be lit up?
//   diff   - snapshot the commit before and after the fix: does `c4pm diff` name the fixed files?
//
// Usage (from Project/):
//   npx ts-node scripts/stress/real.ts --repo <clone> --lang <ids> --out <folder>
//     [--issues 20] [--diff-issues 5] [--cli dist/bin/cli.js] [--timeout 1800] [--ignore <patterns>]
// Writes <out>/issues.json, <out>/runs.jsonl and <out>/summary.md.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runStep, StepRun } from './exec';

const EXT: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  python: ['.py'], rust: ['.rs'], csharp: ['.cs'], php: ['.php'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.c'],
};
const STOP = new Set(('the and for with from that this when into not are was were has have can cannot should does doesnt ' +
  'dont fix fixed fixes fixing bug issue error errors add adds added support allow use uses using make makes made ' +
  'handle handles correct correctly properly wrong incorrect missing remove removed update updated change changed ' +
  'after before while only also more less than then some any all none other case cases test tests docs typo work ' +
  'works working broken crash crashes throw throws thrown value values return returns returned new old file files ' +
  'closes improve avoid honor report request being adding alternate warnings corrected instead ensure prevent default').split(' '));

interface Issue {
  issue: string; commit: string; parent: string; subject: string; files: string[]; keywords: string[];
  stale?: boolean; // no fixed file still exists at HEAD, so find and map cannot be judged
  find?: { hit: boolean; rank: number | null; queries: { q: string; hits: number; firstFixHit: number | null; top: string[] }[] };
  map?: { onMap: string[]; offMap: string[]; owners: string[] };
  diff?: { ok: boolean; named: string[]; missed: string[]; changedFunctions: number | null; note?: string };
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function git(repo: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
}

export function keywords(subject: string): string[] {
  // Drop the issue number and a conventional-commit scope ("fix(editor):"), which is a folder name, not a symbol.
  const s = subject.replace(/\(#\d+\)|#\d+/g, ' ').replace(/^\w+(\([^)]*\))?!?:\s*/, '');
  const code = [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const words = s.replace(/`[^`]+`/g, ' ').split(/[^A-Za-z0-9_$.]+/);
  const ident = (w: string) => /[a-z][A-Z]|_|\$|\.\w/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w);
  const out: string[] = [];
  const push = (w: string) => {
    w = w.replace(/^[.(]+|[.()]+$/g, '').replace(/\(\)$/, '');
    if (w.length >= 4 && !STOP.has(w.toLowerCase()) && !/^[\d.x]+$/.test(w) && !/\.(py|ts|js|rs|php|cs|h|hpp|cpp)$/.test(w) && !out.includes(w)) out.push(w);
  };
  code.forEach((c) => c.split(/[^A-Za-z0-9_$.]+/).forEach(push)); // backticked names first
  words.filter(ident).forEach(push);                               // then identifiers
  words.filter((w) => w.length >= 5).forEach(push);                // then plain long words
  // "Foo.bar" also tries "bar", the part find matches best.
  return out.flatMap((w) => w.includes('.') ? [w, w.split('.').pop()!] : [w]).filter((w, i, a) => w.length >= 4 && a.indexOf(w) === i).slice(0, 3);
}

function mine(repo: string, langs: string[], want: number): Issue[] {
  const exts = langs.flatMap((l) => EXT[l] ?? []);
  const isSource = (f: string) => exts.some((e) => f.endsWith(e)) && !/(^|\/)(tests?|__tests__|spec|fixtures?|docs?|examples?)\//i.test(f) &&
    !/\.(test|spec|d)\.[a-z]+$/.test(f) && !/(^|\/)test_[^/]+\.py$/.test(f) &&
    !/(^|\/)[\w.]*Tests?\//.test(f) && !/(^|\/)(testdata|samples?|integration)\//i.test(f);
  const log = git(repo, 'log', '--no-merges', '-n', '3000', '-E', '-i',
    '--grep', '(fix(e[sd])?|close[sd]?|resolve[sd]?)[: ]+#[0-9]+|\\(#[0-9]+\\)$', '--format=%H%x09%P%x09%s');
  const issues: Issue[] = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [commit, parents, subject] = line.split('\t');
    if (!parents || parents.includes(' ')) continue;
    if (!/fix|bug|crash|error|wrong|incorrect|regress|broken|fail/i.test(subject)) continue; // bug fixes, not features
    if (/^(docs?|chore|ci|test|build|style)(\(|:)|typo|docstring|\bbump\b|\bdeps?\b|upgrade/i.test(subject) || !/#\d+/.test(subject)) continue;
    const files = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n').filter(isSource);
    if (!files.length || files.length > 8) continue;
    const kw = keywords(subject);
    if (!kw.length) continue;
    const num = /#(\d+)/.exec(subject)?.[1] ?? '?';
    issues.push({ issue: `#${num}`, commit, parent: parents, subject, files, keywords: kw });
    if (issues.length >= want) break;
  }
  return issues;
}

function main(): void {
  const project = path.join(__dirname, '..', '..');
  const repo = path.resolve(arg('repo')!);
  const langs = arg('lang', 'typescript')!.split(',');
  const out = path.resolve(arg('out')!);
  const cli = path.resolve(arg('cli', path.join(project, 'dist', 'bin', 'cli.js'))!);
  const want = Number(arg('issues', '20'));
  const diffN = Number(arg('diff-issues', '5'));
  const timeoutS = Number(arg('timeout', '1800'));
  const ignore = arg('ignore');
  const common = ['--lang', langs.join(','), ...(ignore ? ['--ignore', ignore] : [])];
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-real-'));
  const runs = path.join(out, 'runs.jsonl');
  fs.writeFileSync(runs, '');
  const run = (step: string, args: string[], cwd?: string): StepRun => {
    const r = runStep(cli, args, undefined, timeoutS, work, cwd);
    const { stdout, ...rec } = r;
    fs.appendFileSync(runs, JSON.stringify({ step, args: args.join(' '), ...rec, stdoutBytes: stdout.length }) + '\n');
    console.log(`[real] ${step}: ${r.ok ? 'ok' : r.timedOut ? 'TIMEOUT' : `FAIL ${r.exit ?? r.signal}`} ${(r.wallMs / 1000).toFixed(1)}s ${r.maxRssMb ?? '?'}MB` +
      (r.ok ? '' : `\n    ${r.stderrTail.replace(/\n/g, '\n    ')}`));
    return r;
  };
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const nFiles = git(repo, 'ls-files').split('\n').filter((f) => langs.flatMap((l) => EXT[l] ?? []).some((e) => f.endsWith(e))).length;
  console.log(`[real] ${repo} @ ${head.slice(0, 10)}, ${nFiles} source files, langs ${langs.join(',')}`);

  // 1. Whole-repo scan at HEAD, the way a user starts.
  const headData = path.join(work, 'head');
  const snap = run('snapshot', ['snapshot', '--repo', repo, '--out', headData, ...common]);
  const gen = run('generate-c4', ['generate-c4', '--repo', repo, '--out', path.join(work, 'plan'), ...common]);
  const view = run('view', ['view', '--repo', repo, '--out', path.join(work, 'view.html'), ...common]);
  const viewMb = fs.existsSync(path.join(work, 'view.html')) ? fs.statSync(path.join(work, 'view.html')).size / 1e6 : null;
  const fileOwner = new Map<string, string>();
  try {
    const comps = JSON.parse(fs.readFileSync(path.join(headData, 'components.json'), 'utf8')).components as { id: string; files: string[] }[];
    for (const c of comps) for (const f of c.files) fileOwner.set(f, c.id);
  } catch { /* snapshot failed; map checks will all miss */ }

  // 2. Issues from history, checked against the HEAD scan.
  const issues = mine(repo, langs, want);
  console.log(`[real] ${issues.length} fixed issues found in history`);
  for (const is of issues) {
    const queries: NonNullable<Issue['find']>['queries'] = [];
    for (const q of is.keywords) {
      const r = run(`find ${is.issue} ${q}`, ['find', q, '--repo', repo, '--json', '--limit', '20', ...common]);
      let paths: string[] = [];
      try { paths = (JSON.parse(r.stdout).results as { path: string }[]).map((x) => x.path); } catch { /* recorded in runs */ }
      const idx = paths.findIndex((p) => is.files.includes(p));
      queries.push({ q, hits: paths.length, firstFixHit: idx >= 0 ? idx + 1 : null, top: [...new Set(paths)].slice(0, 3) });
    }
    const ranks = queries.map((x) => x.firstFixHit).filter((x): x is number => x != null);
    is.find = { hit: ranks.length > 0, rank: ranks.length ? Math.min(...ranks) : null, queries };
    // Files deleted or moved since the fix are not c4pm's fault; only files still at HEAD count.
    const live = is.files.filter((f) => fs.existsSync(path.join(repo, f)));
    is.stale = live.length === 0;
    const onMap = live.filter((f) => fileOwner.has(f));
    is.map = { onMap, offMap: live.filter((f) => !fileOwner.has(f)), owners: [...new Set(onMap.map((f) => fileOwner.get(f)!))] };
  }

  // 3. Before/after snapshots for the first few issues: does diff point at the fix?
  for (const is of issues.slice(0, diffN)) {
    const snaps: string[] = [];
    let note: string | undefined;
    for (const [tag, rev] of [['before', is.parent], ['after', is.commit]] as const) {
      const wt = path.join(work, `wt-${tag}`);
      try {
        git(repo, 'worktree', 'add', '--detach', '-f', wt, rev);
        const d = path.join(work, `snap-${tag}`);
        const r = run(`diff-snapshot ${is.issue} ${tag}`, ['snapshot', '--repo', wt, '--out', d, ...common]);
        if (r.ok) snaps.push(path.join(d, 'snapshot.json'));
        else note = `${tag} snapshot failed`;
      } catch (e) { note = `worktree ${tag}: ${String(e).split('\n')[0]}`; }
    }
    if (snaps.length === 2) {
      const r = run(`diff ${is.issue}`, ['diff', '--a', snaps[0], '--b', snaps[1], '--format', 'json']);
      // Whole path only: include/x.hpp must not match single_include/x.hpp.
      const named = is.files.filter((f) => new RegExp(`["'\\s]${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s#:]`).test(r.stdout));
      let changedFunctions: number | null = null;
      try { const j = JSON.parse(r.stdout); changedFunctions = j.summary?.elementsModified ?? null; } catch { note = 'diff output is not JSON'; }
      is.diff = { ok: r.ok, named, missed: is.files.filter((f) => !named.includes(f)), changedFunctions, note };
    } else is.diff = { ok: false, named: [], missed: is.files, changedFunctions: null, note };
    for (const tag of ['before', 'after']) {
      try { git(repo, 'worktree', 'remove', '--force', path.join(work, `wt-${tag}`)); } catch { /* not created */ }
      fs.rmSync(path.join(work, `snap-${tag}`), { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(out, 'issues.json'), JSON.stringify(issues, null, 2));

  // 4. Summary.
  const pct = (n: number, d: number) => d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '0/0';
  const s = (r: StepRun) => `${r.ok ? 'ok' : r.timedOut ? 'TIMEOUT' : `FAIL ${r.exit ?? r.signal}`}, ${(r.wallMs / 1000).toFixed(1)}s, ${r.maxRssMb ?? '?'} MB`;
  const diffed = issues.filter((i) => i.diff);
  const judged = issues.filter((i) => !i.stale);
  const md = [
    `# ${path.basename(repo)} @ ${head.slice(0, 10)}`, '',
    `${nFiles} source files (${langs.join(', ')}), c4pm \`${cli}\`, ${new Date().toISOString().slice(0, 10)}`, '',
    '## Scan at HEAD', '', `- snapshot: ${s(snap)}`, `- generate-c4: ${s(gen)}`, `- view: ${s(view)}${viewMb != null ? `, page ${viewMb.toFixed(1)} MB` : ''}`,
    `- files on the map: ${fileOwner.size}`, '',
    '## Issues', '',
    `- issues whose fixed files are all gone at HEAD (not judged): ${issues.length - judged.length}`,
    `- find lands on a fixed file: ${pct(judged.filter((i) => i.find?.hit).length, judged.length)}`,
    `- every fixed file is on the map: ${pct(judged.filter((i) => !i.map?.offMap.length).length, judged.length)}`,
    `- diff names every fixed file: ${pct(diffed.filter((i) => i.diff!.ok && !i.diff!.missed.length).length, diffed.length)}`, '',
    '| issue | title | fixed files | find (best rank) | on map | diff |', '|---|---|---|---|---|---|',
    ...issues.map((i) => `| ${i.issue} | ${i.subject.replace(/\|/g, '/').slice(0, 70)} | ${i.files.length} | ` +
      `${i.stale ? 'stale' : i.find!.hit ? `yes (#${i.find!.rank})` : `no [${i.keywords.join(', ')}]`} | ${i.map!.onMap.length}/${i.map!.onMap.length + i.map!.offMap.length} | ` +
      `${i.diff ? (i.diff.ok ? `${i.diff.named.length}/${i.files.length}` : `FAIL ${i.diff.note ?? ''}`) : '-'} |`),
    '', '## Problems seen', '',
    ...[snap, gen, view].filter((r) => !r.ok).map((r) => `- scan step failed: \`${r.stderrTail.split('\n')[0]}\``),
    ...issues.filter((i) => i.map!.offMap.length).map((i) => `- ${i.issue}: not on the map: ${i.map!.offMap.join(', ')}`),
    ...diffed.filter((i) => i.diff!.note).map((i) => `- ${i.issue}: diff: ${i.diff!.note}`), '',
  ];
  fs.writeFileSync(path.join(out, 'summary.md'), md.join('\n'));
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`[real] done: ${path.join(out, 'summary.md')}`);
}

if (require.main === module) main();
