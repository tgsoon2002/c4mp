#!/usr/bin/env node
// patch-tree-sitter.js <node_modules folder> <platform-arch, e.g. darwin-arm64>
// Build-time patch of a COPY of node_modules (never run it on the repo's own node_modules), so that
// `bun build --compile` produces a self-contained executable. It fails loudly when a pattern is missing.
//   1. tree-sitter/index.js assigns `nodeSubclass.prototype.type = ...` on a getter-only property; Bun
//      bundles it as strict ESM where that throws. The assignment is wrapped in try/catch.
//   2. tree-sitter and every tree-sitter-* grammar load their native file with
//      `require("node-gyp-build")(<dir>)`, which searches the folder it was BUILT in at run time and so
//      only works while that folder still exists. It is replaced by a static `require("<file>.node>")`
//      of the prebuilt file for the given platform, which Bun embeds into the executable.
'use strict';
const fs = require('fs');
const path = require('path');

const [nm, plat] = process.argv.slice(2);
if (!nm || !plat) fail('usage: patch-tree-sitter.js <node_modules> <platform-arch>');

function fail(msg) { console.error(`[patch-tree-sitter] ERROR: ${msg}`); process.exit(1); }

// 1. getter-only `type`
{
  const file = path.join(nm, 'tree-sitter', 'index.js');
  const from = 'nodeSubclass.prototype.type = typeName;';
  const src = fs.readFileSync(file, 'utf8');
  const count = src.split(from).length - 1;
  if (count !== 1) fail(`expected 1 occurrence of "${from}" in ${file}, found ${count} (tree-sitter version changed?)`);
  fs.writeFileSync(file, src.replace(from, `try { ${from} } catch (_) {}`));
}

// 2. static native requires
const packages = fs.readdirSync(nm).filter((n) => n === 'tree-sitter' || n.startsWith('tree-sitter-'));
const loader = /require\((["'])node-gyp-build\1\)\([^)]*\)/;
let patched = 0;
for (const pkg of packages) {
  const pkgDir = path.join(nm, pkg);
  const entry = [path.join(pkgDir, 'index.js'), path.join(pkgDir, 'bindings', 'node', 'index.js')].find((f) => fs.existsSync(f) && loader.test(fs.readFileSync(f, 'utf8')));
  if (!entry) continue; // this package already requires its .node file statically
  const prebuildDir = path.join(pkgDir, 'prebuilds', plat);
  const nodeFiles = fs.existsSync(prebuildDir) ? fs.readdirSync(prebuildDir).filter((f) => f.endsWith('.node')) : [];
  if (nodeFiles.length !== 1) fail(`${pkg} has no single prebuilt .node file for ${plat} in ${prebuildDir}`);
  let rel = path.relative(path.dirname(entry), path.join(prebuildDir, nodeFiles[0])).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(loader, `require(${JSON.stringify(rel)})`));
  patched++;
}
// Packages that already use a static (template) require still choose the file from the BUILD machine's
// platform; pin them to the target platform too.
for (const pkg of packages) {
  const entry = path.join(nm, pkg, 'bindings', 'node', 'index.js');
  if (!fs.existsSync(entry)) continue;
  const src = fs.readFileSync(entry, 'utf8');
  const tpl = '${process.platform}-${process.arch}';
  if (src.includes(tpl)) fs.writeFileSync(entry, src.split(tpl).join(plat));
}
if (patched === 0) fail('no node-gyp-build loader found in any tree-sitter package (layout changed?)');
console.log(`[patch-tree-sitter] patched ${patched} package(s) for ${plat}`);
