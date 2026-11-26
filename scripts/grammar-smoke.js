#!/usr/bin/env node
// grammar-smoke.js: checks the native tree-sitter grammars on this machine.
// Runs `node dist/bin/cli.js languages --json` (each grammar loads and parses a small snippet) and prints one
// PASS/FAIL line per language. Exit code 0 only if every language passed.
//
// Usage: node scripts/grammar-smoke.js   (from the unzipped release folder or from Project/)
// Plain JavaScript; it runs the built CLI (dist/bin/cli.js, `npm run build` first) and requires nothing from dist.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'bin', 'cli.js');

function errorText(error) {
  return error && error.message ? String(error.message).split('\n')[0] : String(error);
}

const run = spawnSync(process.execPath, [CLI, 'languages', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
let result;
try {
  result = JSON.parse(run.stdout);
} catch (error) {
  console.log('platform: ' + process.platform);
  console.log('arch: ' + process.arch);
  console.log('node: ' + process.version);
  console.log('ABI (process.versions.modules): ' + process.versions.modules);
  console.log('c4mp languages FAILED to run: ' + (run.error ? errorText(run.error) : errorText(error) + ' ' + String(run.stderr || '').split('\n')[0]) + ' (run npm run build first)');
  process.exit(1);
}

console.log('platform: ' + result.platform);
console.log('arch: ' + result.arch);
console.log('node: ' + result.node);
console.log('ABI (process.versions.modules): ' + result.abi);
console.log('grammar list: c4mp languages');
console.log('tree-sitter: ' + (result.treeSitter.error ? 'FAILED to load: ' + result.treeSitter.error : result.treeSitter.version));

// Does node-gyp-build find a .node prebuild for the tree-sitter package itself? (Resolved from the script's parent folder, then the current folder.)
try {
  let found = null;
  for (const dir of [ROOT, process.cwd()]) {
    const req = createRequire(path.join(dir, 'noop.js'));
    try { found = { req, tsRoot: path.dirname(req.resolve('tree-sitter/package.json')) }; break; } catch (_) { /* try next */ }
  }
  if (!found) throw Object.assign(new Error('tree-sitter not installed'), { notInstalled: true });
  console.log('node-gyp-build prebuild path: ' + found.req('node-gyp-build').path(found.tsRoot));
} catch (error) {
  console.log('node-gyp-build prebuild path: ' + (error.code === 'MODULE_NOT_FOUND' || error.notInstalled ? 'not installed' : 'NOT resolved: ' + errorText(error)));
}

let failures = 0;
for (const g of result.grammars) {
  if (g.ok) console.log('PASS ' + g.label + ' (' + g.pkg + ' ' + g.version + ')');
  else {
    failures += 1;
    console.log('FAIL ' + g.label + ': ' + g.error);
  }
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' language(s) FAILED. Send this output to K.');
process.exit(failures === 0 && result.ok ? 0 : 1);
