// Builds dist/ once before the suite so CLI tests can spawn `node dist/bin/cli.js` instead of cold ts-node.
// Skipped when dist/bin/cli.js is newer than every .ts under src/ and bin/.
// Also gives the run its own temp root (b626), removed by test/globalTeardown.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function newestTs(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestTs(p));
    else if (e.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

// b626: tests mkdtemp under os.tmpdir() and many never remove their dirs, and a killed run
// leaks even the ones that clean up in afterAll. One root per run, set as TMPDIR before jest
// starts its workers, catches all of them: workers and every child they spawn (CLI, git,
// Chrome) inherit TMPDIR, and globalTeardown removes the root. Concurrent runs in several
// worktrees each get their own root; the sweep only takes roots older than 24 h (a killed
// run's root), the same rule as removeStaleExports in src/scan/historyRun.ts. Other c4pm-*
// names in the real temp folder are never touched here.
const RUN_PREFIX = 'c4pm-jest-';
const STALE_RUN_MS = 24 * 60 * 60 * 1000;

function sweepStaleRunRoots(base) {
  const now = Date.now();
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const dir = path.join(base, name);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (now - st.mtimeMs > STALE_RUN_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeRunTempRoot() {
  const base = os.tmpdir();
  sweepStaleRunRoots(base);
  const runRoot = fs.mkdtempSync(path.join(base, RUN_PREFIX));
  // No realpath: keep the same /var/folders/... form tests get today.
  process.env.TMPDIR = runRoot;
  // Phase 35: the "this repo still uses .c4pm" stderr note is off for the suite (many tests keep old .c4pm repos and
  // compare stderr exactly); test/data-dir.test.ts turns it back on where it checks the note.
  process.env.C4MP_NO_NOTES = '1';
  process.env.C4PM_TEST_TMP_ROOT = runRoot;
  // QS-2: the disk parse cache of every query goes under the run root, never into the real user cache.
  process.env.C4PM_CACHE_DIR = path.join(runRoot, 'cache');
  // b646/b920: personal files (settings.json, serve-keys.json) under the run root, never in the real ~/.c4pm
  process.env.C4PM_USER_DIR = path.join(runRoot, 'user');
  // the C4MP_ names win over the C4PM_ ones: set both so a value in the caller's shell never leads to the real folder
  process.env.C4MP_USER_DIR = process.env.C4PM_USER_DIR;}

module.exports = async () => {
  makeRunTempRoot();
  const cli = path.join(root, 'dist', 'bin', 'cli.js');
  const built = fs.existsSync(cli) ? fs.statSync(cli).mtimeMs : 0;
  if (built > Math.max(newestTs(path.join(root, 'src')), newestTs(path.join(root, 'bin')))) return;
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: root, stdio: 'inherit',
  });
};
