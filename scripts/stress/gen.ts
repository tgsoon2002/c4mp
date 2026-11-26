// Synthetic repositories for stress runs. Each fixture is a fresh git repo whose
// shape (file count, functions per file, folder depth, import fan-out, file
// size, commit count) is set by GenSpec, so a run can be reproduced exactly.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface GenSpec {
  files: number;          // source files to write
  funcsPerFile: number;   // exported functions per file
  depth: number;          // folder depth (files spread over folders this deep)
  fanOut: number;         // imports per file (to earlier files, plus one cycle edge)
  lang: 'typescript' | 'python';
  bigFileLines?: number;  // add one extra file with this many lines
  commits?: number;       // extra commits after the first (each touches ~1% of files)
  seed?: number;
}

export function specKey(s: GenSpec): string {
  return [s.lang, `f${s.files}`, `fn${s.funcsPerFile}`, `d${s.depth}`, `o${s.fanOut}`,
    `b${s.bigFileLines ?? 0}`, `c${s.commits ?? 0}`, `s${s.seed ?? 1}`].join('-');
}

// Small deterministic PRNG so the same spec writes the same bytes.
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 0x100000000; };
}

function relPath(i: number, s: GenSpec): string {
  const dirs: string[] = [];
  let n = i;
  for (let d = 0; d < s.depth; d++) { dirs.push(`m${n % 7}`); n = Math.floor(n / 7); }
  const ext = s.lang === 'python' ? 'py' : 'ts';
  return path.join('src', ...dirs, `f${i}.${ext}`);
}

function importPath(from: string, to: string, lang: GenSpec['lang']): string {
  if (lang === 'python') return to.replace(/\.py$/, '').split(path.sep).join('.');
  let r = path.relative(path.dirname(from), to).replace(/\.ts$/, '').split(path.sep).join('/');
  return r.startsWith('.') ? r : `./${r}`;
}

function fileText(i: number, s: GenSpec, rand: () => number, rev = 0): string {
  const me = relPath(i, s);
  const targets = new Set<number>();
  for (let k = 0; k < s.fanOut && i > 0; k++) targets.add(Math.floor(rand() * i));
  if (i > 1 && i % 50 === 0) targets.add(i + 1 < s.files ? i + 1 : 0); // a few import cycles
  const lines: string[] = [];
  const py = s.lang === 'python';
  for (const t of targets) {
    const p = importPath(me, relPath(t, s), s.lang);
    lines.push(py ? `from ${p} import f${t}_0` : `import { f${t}_0 } from '${p}';`);
  }
  for (let f = 0; f < s.funcsPerFile; f++) {
    const calls = [...targets].slice(0, 2).map((t) => `f${t}_0(x)`);
    if (py) {
      lines.push('', `def f${i}_${f}(x):`, `    y = x + ${f + rev}`, ...calls.map((c) => `    ${c}`), '    return y');
    } else {
      lines.push('', `export function f${i}_${f}(x: number): number {`, `  const y = x + ${f + rev};`,
        ...calls.map((c) => `  ${c};`), '  return y;', '}');
    }
  }
  if (!py && s.funcsPerFile > 0 && i % 10 === 0) {
    lines.push('', `export class C${i} {`, `  run(x: number): number { return f${i}_0(x); }`, '}');
  }
  return lines.join('\n') + '\n';
}

function bigFile(lines: number, lang: GenSpec['lang']): string {
  const out: string[] = [];
  for (let f = 0; out.length < lines; f++) {
    if (lang === 'python') out.push(`def big_${f}(x):`, `    a = x * ${f}`, '    b = a + 1', '    return b', '', '');
    else out.push(`export function big_${f}(x: number): number {`, `  const a = x * ${f};`, '  const b = a + 1;', '  return b;', '}', '');
  }
  return out.slice(0, lines).join('\n') + '\n';
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: {
    ...process.env, GIT_AUTHOR_NAME: 'stress', GIT_AUTHOR_EMAIL: 'stress@example.invalid',
    GIT_COMMITTER_NAME: 'stress', GIT_COMMITTER_EMAIL: 'stress@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
}

// Writes the fixture under root/<specKey> unless it is already there (marker file).
export function generate(root: string, s: GenSpec): string {
  const dir = path.join(root, specKey(s));
  if (fs.existsSync(path.join(dir, '.stress-done'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const rand = rng(s.seed ?? 1);
  for (let i = 0; i < s.files; i++) {
    const p = path.join(dir, relPath(i, s));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fileText(i, s, rand));
  }
  if (s.bigFileLines) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', s.lang === 'python' ? 'big.py' : 'big.ts'), bigFile(s.bigFileLines, s.lang));
  }
  if (s.lang === 'typescript') fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'stress-fixture' }));
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  for (let c = 1; c <= (s.commits ?? 0); c++) {
    const touch = Math.max(1, Math.floor(s.files / 100));
    for (let k = 0; k < touch; k++) {
      const i = Math.floor(rand() * s.files);
      fs.writeFileSync(path.join(dir, relPath(i, s)), fileText(i, s, rng(i + 1), c));
    }
    git(dir, 'commit', '-q', '-am', `change ${c}`);
  }
  fs.writeFileSync(path.join(dir, '.stress-done'), specKey(s));
  return dir;
}
