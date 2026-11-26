// Stress runner: generates fixtures (gen.ts), runs c4pm commands against them
// and records wall time, peak memory, CPU, exit code, signal and timeouts.
// Ladders grow one dimension step by step and stop at the first failure, so
// the last passing and first failing rung show where c4pm breaks.
//
// Usage (from Project/):
//   npx ts-node scripts/stress/run.ts [--suite smoke|scale|full] [--only <ladder>]
//     [--cli <path to cli.js>] [--heap <MB>] [--timeout <s>] [--fixtures <dir>] [--out <dir>]
// Defaults: suite smoke, cli dist/bin/cli.js (run npm run build first),
// fixtures $TMPDIR/c4pm-stress, results out/stress/<timestamp>/.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GenSpec, generate, specKey } from './gen';
import { runStep } from './exec';

interface Step { name: string; args: (repo: string, work: string) => string[]; }
interface Ladder { id: string; what: string; rungs: GenSpec[]; steps: Step[]; }
export interface Result {
  ladder: string; rung: string; step: string; ok: boolean; exit: number | null; signal: string | null;
  timedOut: boolean; wallMs: number; maxRssMb: number | null; cpuMs: number | null;
  outBytes?: number; stderrTail: string;
}

const LANG = (s: GenSpec) => s.lang === 'python' ? 'python' : 'typescript';
const scan: Step[] = [
  { name: 'snapshot', args: (r, w) => ['snapshot', '--repo', r, '--out', path.join(w, 'data'), '--lang', ''] },
  // check needs a plan; without .c4 files it returns at once and measures nothing.
  { name: 'generate-c4', args: (r) => ['generate-c4', '--repo', r, '--lang', ''] },
  { name: 'ids', args: (r) => ['ids', '--repo', r, '--yes'] },
  { name: 'check', args: (r) => ['check', '--repo', r, '--format', 'json', '--lang', ''] },
  { name: 'view', args: (r, w) => ['view', '--repo', r, '--out', path.join(w, 'view.html'), '--lang', ''] },
];
const hist: Step[] = [
  { name: 'history', args: (r) => ['history', '--repo', r, '--max', '100000', '--lang', ''] },
  { name: 'diff', args: (r) => ['diff', '--repo', r, '--from', 'oldest', '--to', 'latest'] },
];

function base(files: number, extra: Partial<GenSpec> = {}): GenSpec {
  return { files, funcsPerFile: 5, depth: 3, fanOut: 3, lang: 'typescript', ...extra };
}
const SUITES: Record<string, Ladder[]> = {
  smoke: [
    { id: 'files', what: 'file count', rungs: [base(50), base(500)], steps: scan },
    { id: 'history', what: 'commit count', rungs: [base(100, { commits: 10 })], steps: hist },
  ],
  scale: [
    { id: 'files', what: 'file count', rungs: [1000, 5000, 10000, 25000, 50000, 100000].map((n) => base(n)), steps: scan },
    { id: 'python', what: 'python file count', rungs: [1000, 10000, 50000].map((n) => base(n, { lang: 'python' })), steps: scan },
    { id: 'bigfile', what: 'one huge file (lines)', rungs: [10000, 50000, 200000, 1000000].map((n) => base(10, { bigFileLines: n })), steps: scan },
    { id: 'fanout', what: 'imports per file', rungs: [10, 50, 200].map((o) => base(2000, { fanOut: o })), steps: scan },
    { id: 'depth', what: 'folder depth', rungs: [10, 30, 60].map((d) => base(500, { depth: d })), steps: scan },
    { id: 'history', what: 'commit count', rungs: [50, 200, 1000].map((c) => base(500, { commits: c })), steps: hist },
  ],
};
SUITES.full = SUITES.scale;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function fmt(r: Result): string {
  const status = r.ok ? 'ok' : r.timedOut ? 'TIMEOUT' : r.signal ? `KILLED ${r.signal}` : `FAIL exit ${r.exit}`;
  const size = r.outBytes != null ? ` ${(r.outBytes / 1e6).toFixed(1)}MB` : '';
  return `| ${r.ladder} | ${r.rung} | ${r.step} | ${status} | ${(r.wallMs / 1000).toFixed(1)}s | ${r.maxRssMb ?? '?'}MB |${size} |`;
}

function main(): void {
  const project = path.join(__dirname, '..', '..');
  const cli = path.resolve(arg('cli', path.join(project, 'dist', 'bin', 'cli.js'))!);
  if (!fs.existsSync(cli)) { console.error(`[stress] cli not found: ${cli} (run npm run build, or pass --cli)`); process.exit(1); }
  const suite = arg('suite', 'smoke')!;
  const ladders = (SUITES[suite] ?? []).filter((l) => !arg('only') || l.id === arg('only'));
  if (!ladders.length) { console.error(`[stress] no ladders for suite '${suite}' only '${arg('only') ?? ''}'`); process.exit(1); }
  const heap = arg('heap');
  const timeoutS = Number(arg('timeout', '900'));
  const fixtures = path.resolve(arg('fixtures', path.join(os.tmpdir(), 'c4pm-stress'))!);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(arg('out', path.join(project, 'out', 'stress', stamp))!);
  fs.mkdirSync(out, { recursive: true });
  const jsonl = path.join(out, 'results.jsonl');
  const rows: Result[] = [];
  console.log(`[stress] suite ${suite}, cli ${cli}, heap ${heap ?? 'default'}MB, timeout ${timeoutS}s\n[stress] results: ${out}`);

  for (const ladder of ladders) {
    for (const spec of ladder.rungs) {
      const rung = specKey(spec);
      const tg = Date.now();
      const repo = generate(fixtures, spec);
      console.log(`[stress] ${ladder.id} ${rung}: fixture ready in ${((Date.now() - tg) / 1000).toFixed(1)}s`);
      // c4mp writes .c4mp/ and C4MP/ (older versions: .c4pm/ and C4PM/) into the repo; clear them so rungs do not share state.
      for (const folder of ['.c4mp', 'C4MP', '.c4pm', 'C4PM']) fs.rmSync(path.join(repo, folder), { recursive: true, force: true });
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-stress-work-'));
      let broke = false;
      for (const step of ladder.steps) {
        const args = step.args(repo, work).map((a, i, all) => all[i - 1] === '--lang' && a === '' ? LANG(spec) : a);
        const { stdout: _out, ...run } = runStep(cli, args, heap, timeoutS, work);
        const r: Result = { ladder: ladder.id, rung, step: step.name, ...run };
        if (step.name === 'view' && fs.existsSync(path.join(work, 'view.html'))) r.outBytes = fs.statSync(path.join(work, 'view.html')).size;
        rows.push(r);
        fs.appendFileSync(jsonl, JSON.stringify(r) + '\n');
        console.log(fmt(r) + (r.ok ? '' : `\n    ${r.stderrTail.replace(/\n/g, '\n    ')}`));
        if (!r.ok) { broke = true; break; }
      }
      fs.rmSync(work, { recursive: true, force: true });
      if (broke) { console.log(`[stress] ${ladder.id}: broke at ${rung}; skipping larger rungs`); break; }
    }
  }

  const failed = rows.filter((r) => !r.ok);
  const md = [`# c4pm stress run ${stamp}`, '', `suite \`${suite}\`, cli \`${cli}\`, node ${process.version}, ${os.platform()} ${os.arch()}, ` +
    `${Math.round(os.totalmem() / 1e9)} GB RAM, heap ${heap ?? 'default'}`, '',
    '| ladder | rung | step | result | wall | peak RSS | view size |', '|---|---|---|---|---|---|---|', ...rows.map(fmt), '',
    failed.length ? `## Failures\n\n${failed.map((r) => `- ${r.ladder} ${r.rung} ${r.step}:\n\n\`\`\`\n${r.stderrTail}\n\`\`\``).join('\n')}` : 'No failures.', ''];
  fs.writeFileSync(path.join(out, 'summary.md'), md.join('\n'));
  console.log(`[stress] done: ${rows.length} steps, ${failed.length} failed. ${path.join(out, 'summary.md')}`);
  process.exit(failed.length ? 1 : 0);
}

main();
