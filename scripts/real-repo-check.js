#!/usr/bin/env node
// E1 (b157): real-repo baseline per language. Scans pinned open-source repos with the BUILT cli
// (run `npm run build` first) and prints one JSON object plus a table per repo.
//
//   node scripts/real-repo-check.js            run, print JSON + table
//   node scripts/real-repo-check.js --write    also save the counts to test/golden/real-repos.json
//   node scripts/real-repo-check.js --check    compare the counts with test/golden/real-repos.json; exit 1 on a difference
//   node scripts/real-repo-check.js --only fd,slim    (with --write: only these repos' entries are replaced)
//   node scripts/real-repo-check.js --reasons  also count the unresolved imports by reason, per repo (from the
//                                             resolvers' debug lines: C4PM_DEBUG=resolve,<language>-resolve)
//
// Repos live in $C4MP_CHECKS (old name $C4PM_CHECKS still read; default ~/dev/c4pm-checks/<name>), outside the C4PM repo. A missing repo is
// shallow-cloned at its tag; a checkout whose HEAD is not the pinned sha is an error (never re-pinned silently).
// Per repo: `c4pm snapshot --out out/real-repos/<name> --lang <language>` (out/ is git-ignored), counts read from
// the written outline/imports/components.json, then one `c4pm find` and one `c4pm show` of the first element.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'bin', 'cli.js');
const CHECKS = process.env.C4MP_CHECKS || process.env.C4PM_CHECKS || path.join(os.homedir(), 'dev', 'c4pm-checks');
const OUT = path.join(ROOT, 'out', 'real-repos');
const BASELINE = path.join(ROOT, 'test', 'golden', 'real-repos.json');

/** Pinned repos. language = c4pm --lang id; pending = no handler yet (listed, never scanned, never a failure). */
const REPOS = [
  { name: 'fd', language: 'rust', url: 'https://github.com/sharkdp/fd.git', tag: 'v10.5.0', sha: '4f81778774463bf414a184cbe6d5219ad2229646' },
  { name: 'slim', language: 'php', url: 'https://github.com/slimphp/Slim.git', tag: '4.15.3', sha: '3675bf6baac66b07032575b7bef4200b60b7974b' },
  { name: 'serilog', language: 'csharp', url: 'https://github.com/serilog/serilog.git', tag: 'v4.4.0', sha: '6d9fc0b84e004418f2677b5961b9c8970349d0be' },
  { name: 'fmt', language: 'cpp', url: 'https://github.com/fmtlib/fmt.git', tag: '12.2.0', sha: '1be298e1bd68957e4cd352e1f676f00e07dcfb57' },
  { name: 'alamofire', language: 'swift', url: 'https://github.com/Alamofire/Alamofire.git', tag: '5.12.2', sha: 'bda9ed57d72988a3a2ada33d824583541f86eac6' },
  { name: 'requests', language: 'python', url: 'https://github.com/psf/requests.git', tag: 'v2.34.2', sha: '6e83187b8feb273ed4c6cdab5efd8d54901dfab3' },
  { name: 'hono', language: 'typescript', url: 'https://github.com/honojs/hono.git', tag: 'v4.13.14', sha: 'bac5c4a8bcd76b165428ce757e1185753c7935bd' },
];

function run(args, opts = {}) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', ms, error: r.error };
}

/** HEAD commit of a checkout, read from .git/HEAD (detached after a tag clone) or the ref it names. */
function headSha(dir) {
  const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  return fs.readFileSync(path.join(dir, '.git', head.slice(5)), 'utf8').trim();
}

/** Make sure the repo is checked out at its pinned sha; clone shallow when missing. */
function ensureRepo(repo) {
  const dir = path.join(CHECKS, repo.name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(CHECKS, { recursive: true });
    const r = spawnSync('git', ['-c', 'advice.detachedHead=false', 'clone', '-q', '--depth', '1', '--branch', repo.tag, repo.url, dir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`clone failed: ${repo.url} ${repo.tag}`);
  }
  const sha = headSha(dir);
  if (sha !== repo.sha) throw new Error(`${dir} is at ${sha}, pinned ${repo.sha} (${repo.tag})`);
  return dir;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Unresolved imports by reason, from '[<tag>-resolve] unresolved {...}' debug lines (no reason: '(none)'):
 * counts, and the first import per reason as "<from> '<spec>'" (examples).
 */
function reasonCounts(output) {
  const counts = {};
  const examples = {};
  for (const line of output.split('\n')) {
    const m = /^\[[\w-]*resolve\] unresolved (\{.*\})$/.exec(line);
    if (!m) continue;
    let reason = '(none)';
    let example = '';
    try {
      const entry = JSON.parse(m[1]);
      reason = entry.reason || reason;
      example = `${entry.from} '${entry.spec}'`;
    } catch { /* counted as (none) */ }
    counts[reason] = (counts[reason] || 0) + 1;
    if (!(reason in examples)) examples[reason] = example;
  }
  return { counts, examples };
}

/** Scan one repo; counts for the baseline, the rest (times, file names, samples) for the report only. */
function checkRepo(repo, opts = {}) {
  const base = { name: repo.name, language: repo.language, url: repo.url, tag: repo.tag, sha: repo.sha };
  if (repo.pending) return { ...base, status: 'pending' };
  const dir = ensureRepo(repo);
  const out = path.join(OUT, repo.name);
  fs.rmSync(out, { recursive: true, force: true });

  const env = opts.reasons ? { env: { ...process.env, C4MP_DEBUG: `resolve,${repo.language}-resolve`, C4PM_DEBUG: `resolve,${repo.language}-resolve` } } : {};
  const snap = run(['snapshot', '--repo', dir, '--out', out, '--lang', repo.language], env);
  if (snap.status !== 0) {
    return { ...base, status: 'crash', crashes: 1, wallMs: snap.ms, error: (snap.stderr || String(snap.signal || snap.error)).slice(0, 2000) };
  }
  const outline = readJson(path.join(out, 'outline.json'));
  const imports = readJson(path.join(out, 'imports.json'));
  const components = readJson(path.join(out, 'components.json'));

  const parseErrorFiles = outline.filter((o) => o.parseError).map((o) => o.file);
  const byStatus = { internal: 0, external: 0, asset: 0, unresolved: 0 };
  let total = 0;
  for (const fi of imports) {
    for (const rec of fi.imports) {
      total++;
      byStatus[rec.status] = (byStatus[rec.status] || 0) + 1;
    }
  }
  const tests = outline.reduce((n, o) => n + o.elements.filter((e) => e.kind === 'test').length, 0);
  const counts = {
    files: outline.length,
    parseErrorFiles: parseErrorFiles.length,
    elements: outline.reduce((n, o) => n + o.elements.length, 0),
    ...(tests > 0 && { tests }),   // Phase 26: elements of kind 'test' (part of `elements`); absent when none
    imports: { total, ...byStatus },
    containers: components.containers.length,
    components: components.components.length,
  };

  // One find + one show of the first top-level function or class (sorted files, outline order).
  let sample = null;
  for (const o of outline) {
    const el = o.elements.find((e) => (e.kind === 'function' || e.kind === 'class') && !e.name.includes('.'));
    if (el) { sample = { file: o.file, name: el.name, startLine: el.startLine }; break; }
  }
  let find = { ok: false, note: 'no element to look up' };
  let show = { ok: false, note: 'no element to look up' };
  if (sample) {
    const f = run(['find', sample.name, '--repo', dir, '--lang', repo.language, '--json', '--limit', '100']);
    let hit = false;
    try { hit = JSON.parse(f.stdout).results.some((r) => r.path === sample.file && r.name === sample.name); } catch { /* reported below */ }
    find = { ok: f.status === 0 && hit, cmd: `find ${sample.name}`, exit: f.status, ms: f.ms, ...(f.status !== 0 ? { stderr: f.stderr.slice(0, 500) } : {}) };
    const target = `${sample.file}#${sample.name}`;
    const s = run(['show', target, '--repo', dir, '--lang', repo.language, '--json', '--max-lines', '5']);
    let started = null;
    try { started = JSON.parse(s.stdout).startLine; } catch { /* reported below */ }
    show = { ok: s.status === 0 && started === sample.startLine, cmd: `show ${target}`, exit: s.status, ms: s.ms, ...(s.status !== 0 ? { stderr: s.stderr.slice(0, 500) } : {}) };
  }
  const warningLines = snap.stdout.split('\n').filter((l) => l.startsWith('  ') && !l.startsWith('  default ignores'));
  const reasons = opts.reasons ? reasonCounts(snap.stdout + '\n' + snap.stderr) : null;
  // The example with its line, from the matching "unresolved <file>:<line> '<spec>'" warning.
  for (const [reason, example] of Object.entries(reasons ? reasons.examples : {})) {
    const [from, ...spec] = example.split(' ');
    const hit = warningLines.map((l) => l.trim()).find((l) => l.startsWith(`unresolved ${from}:`) && l.endsWith(` ${spec.join(' ')}`));
    if (hit) reasons.examples[reason] = hit.slice('unresolved '.length);
  }
  return {
    ...base,
    status: 'ok',
    crashes: 0,
    counts,
    wallMs: snap.ms,
    parseErrorFirst10: parseErrorFiles.slice(0, 10),
    warnings: warningLines.length,
    unresolvedFirst10: warningLines.filter((l) => l.startsWith('  unresolved ')).slice(0, 10).map((l) => l.trim()),
    ...(reasons && { unresolvedReasons: reasons.counts, unresolvedExamples: reasons.examples }),
    find,
    show,
  };
}

/** Baseline view: counts only (no file names, no times). */
function baselineOf(results) {
  const repos = {};
  for (const r of results) {
    repos[r.name] = r.status === 'ok'
      ? { language: r.language, sha: r.sha, crashes: r.crashes, ...r.counts }
      : { language: r.language, sha: r.sha, status: r.status, ...(r.crashes ? { crashes: r.crashes } : {}) };
  }
  return { repos };
}

/**
 * The baseline to write after a run. With --only (`only` set) the run covers some repos: their entries
 * replace theirs in the previous baseline (keeping its order) and the other repos stay as they were.
 */
function nextBaseline(previous, fresh, only) {
  if (!only || !previous) return fresh;
  return { ...previous, repos: { ...previous.repos, ...fresh.repos } };
}

function table(results) {
  const head = ['repo', 'lang', 'files', 'parseErr', 'elements', 'imports', 'internal', 'external', 'asset', 'unresolved', 'containers', 'ms', 'crash', 'find', 'show'];
  const rows = results.map((r) => r.status !== 'ok'
    ? [r.name, r.language, r.status, '', '', '', '', '', '', '', '', r.wallMs ?? '', r.crashes ?? 0, '', '']
    : [r.name, r.language, r.counts.files, r.counts.parseErrorFiles, r.counts.elements, r.counts.imports.total, r.counts.imports.internal,
       r.counts.imports.external, r.counts.imports.asset, r.counts.imports.unresolved, r.counts.containers, r.wallMs, r.crashes,
       r.find.ok ? 'ok' : 'FAIL', r.show.ok ? 'ok' : 'FAIL']);
  const all = [head, ...rows].map((row) => row.map(String));
  const widths = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return all.map((row) => row.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

function main() {
  if (!fs.existsSync(CLI)) throw new Error(`${CLI} missing: run npm run build first`);
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : null;
  const repos = REPOS.filter((r) => !only || only.includes(r.name));
  const reasons = process.argv.includes('--reasons');
  const results = repos.map((r) => checkRepo(r, { reasons }));
  console.log(JSON.stringify({ checks: CHECKS, results }, null, 2));
  console.log('\n' + table(results));
  if (reasons) {
    console.log('\nunresolved by reason');
    for (const r of results.filter((x) => x.unresolvedReasons)) {
      const parts = Object.entries(r.unresolvedReasons).sort((a, b) => b[1] - a[1]);
      console.log(`  ${r.name} (${r.language}): ${parts.length ? parts.map(([k, n]) => `${n} ${k}`).join(', ') : 'none'}`);
      for (const [k] of parts.slice(0, 5)) console.log(`    ${k}: e.g. ${r.unresolvedExamples[k]}`);
    }
  }

  let failed = results.some((r) => r.status === 'crash');
  const baseline = baselineOf(results);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    const previous = fs.existsSync(BASELINE) ? readJson(BASELINE) : null;
    fs.writeFileSync(BASELINE, JSON.stringify(nextBaseline(previous, baseline, only), null, 2) + '\n');
    console.log(`\nwrote ${path.relative(ROOT, BASELINE)}`);
  }
  if (process.argv.includes('--check')) {
    const old = readJson(BASELINE).repos;
    for (const [name, now] of Object.entries(baseline.repos)) {
      const same = JSON.stringify(old[name]) === JSON.stringify(now);
      if (!same) failed = true;
      console.log(`${same ? 'same' : 'DIFF'}  ${name}${same ? '' : `\n  baseline ${JSON.stringify(old[name])}\n  now      ${JSON.stringify(now)}`}`);
    }
  }
  if (failed) process.exitCode = 1;
}

module.exports = { REPOS, checkRepo, baselineOf, nextBaseline };

if (require.main === module) main();
