#!/usr/bin/env node
// R0 golden net for the language refactor (b185).
// For every fixture in test/fixtures and its languages, record per file: the outline (elements; test cases and
// testBlocks of role-test files), parseError, lineCount, the raw imports and each resolve result. Uses the BUILT dist (run `npm run build` first).
//
//   node scripts/language-golden.js           write test/golden/languages/<fixture>.json (committed)
//                                             and out/golden-src.json (Project/src as TypeScript, git-ignored)
//   node scripts/language-golden.js --check   compare instead of writing; exit 1 on any difference
//
// The data comes from the CLI (`node dist/bin/cli.js snapshot --repo <fixture> --lang <ids> --out <tmp>`, like
// scripts/real-repo-check.js): outline.json (files, elements, testBlocks) and imports.json (resolve results, and the
// `language` of each file). The script requires nothing from dist. Files no language owns and that are not file-only
// are not scanned by snapshot ("no handler" warning) and so have no record.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'bin', 'cli.js');

const FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures');
const GOLDEN_DIR = path.join(ROOT, 'test', 'golden', 'languages');
const SRC_OUT = path.join(ROOT, 'out', 'golden-src.json');

/** Fixture folder -> languages (b185 binding details). */
const FIXTURES = {
  rustshop: ['rust'],
  phpshop: ['php'],
  cppshop: ['cpp'],
  csharpshop: ['csharp'],
  pyshop: ['python'],
  swiftshop: ['swift'],
  sample: ['typescript', 'python'],
  'sample-v2': ['typescript', 'python'],
  phofast: ['typescript'],
  level4: ['typescript'],
  tscases: ['typescript'],
  'java-tiny': ['files'],
};

/** Deep copy with object keys sorted, so the JSON text never depends on insertion order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

/** Runs `snapshot` on a repo folder and returns { outline, imports } read from the data files it wrote. */
function snapshotData(root, languages) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-golden-'));
  try {
    // An explicit --ignore keeps the anchor's .c4pm/config.json (the fixtures live under the C4PM repo) from changing the scan.
    const args = [CLI, 'snapshot', '--repo', root, '--lang', languages.join(','), '--ignore', '.c4pm-golden-none', '--out', out];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`snapshot of ${root} failed (status ${r.status}): ${r.stderr || r.stdout}`);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
    return { outline: read('outline.json'), imports: read('imports.json') };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** Golden object of one repo folder for the given language ids. */
function buildGolden(repoRoot, languages) {
  const root = path.resolve(repoRoot);
  const { outline, imports } = snapshotData(root, languages);
  const importsByFile = new Map(imports.map((e) => [e.file, e]));
  const records = outline.map((o) => {
    const entry = importsByFile.get(o.file);
    // A file with an imports entry was read by that language; a file-only file has an outline but no entry.
    const handler = entry ? entry.language : o.fileOnly ? 'files' : null;
    const stored = entry ? entry.imports : [];
    return {
      file: o.file,
      handler,
      fileOnly: o.fileOnly,
      lineCount: o.lineCount,
      parseError: o.parseError,
      // b568: the content hash is the parse step's, not what a language reads; diff.test.ts covers it.
      elements: o.elements.map(({ hash, ...e }) => e),
      nested: o.nested,
      testBlocks: o.testBlocks,
      imports: stored.map(({ status, target, pkg, ...raw }) => ({ ...raw, resolved: { status, target, pkg } })),
    };
  });
  records.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return canonical({ languages, files: records });
}

/** JSON text of a golden object; fails when an absolute path of the repo leaked in. */
function goldenText(repoRoot, languages) {
  const text = JSON.stringify(buildGolden(repoRoot, languages), null, 2) + '\n';
  if (text.includes(path.resolve(repoRoot))) throw new Error(`absolute path in golden of ${repoRoot}`);
  return text;
}

/** Every committed golden: { fixture, file, text } for each fixture. */
function fixtureGoldens() {
  return Object.entries(FIXTURES).map(([fixture, languages]) => ({
    fixture,
    file: path.join(GOLDEN_DIR, `${fixture}.json`),
    text: goldenText(path.join(FIXTURES_DIR, fixture), languages),
  }));
}

function main() {
  const check = process.argv.includes('--check');
  const goldens = fixtureGoldens();
  goldens.push({ fixture: 'Project/src', file: SRC_OUT, text: goldenText(path.join(ROOT, 'src'), ['typescript']) });
  let diffs = 0;
  for (const g of goldens) {
    if (check) {
      const old = fs.existsSync(g.file) ? fs.readFileSync(g.file, 'utf8') : null;
      const same = old === g.text;
      if (!same) diffs++;
      console.log(`${same ? 'same' : 'DIFF'}  ${g.fixture}`);
    } else {
      fs.mkdirSync(path.dirname(g.file), { recursive: true });
      fs.writeFileSync(g.file, g.text);
      console.log(`wrote ${path.relative(ROOT, g.file)}`);
    }
  }
  if (diffs > 0) process.exitCode = 1;
}

module.exports = { FIXTURES, FIXTURES_DIR, GOLDEN_DIR, buildGolden, goldenText, fixtureGoldens };

if (require.main === module) main();
