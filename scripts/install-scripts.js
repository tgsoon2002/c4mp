#!/usr/bin/env node
// install-scripts.js <project folder> [--omit-dev] [--build-only]
// Release builds install with `--ignore-scripts`, then `npm rebuild` the packages this script prints, so a
// BUILD-ONLY package never runs its install script. Reads <project folder>/package-lock.json.
//   default        the installed packages with an install script, except the build-only ones (space separated)
//   --omit-dev     leave out dev packages (production install)
//   --build-only   instead print the installed build-only packages (to prune them from a bundle)
// tree-sitter-cli (a dependency of tree-sitter-swift) is only needed to BUILD grammars; its install script
// downloads a 21 MB executable from GitHub on every install, outside npm's cache, which also breaks an
// offline install. The grammars load their prebuilt .node files without it.
'use strict';
const fs = require('fs');
const path = require('path');

const BUILD_ONLY = ['tree-sitter-cli'];

const [dir, ...flags] = process.argv.slice(2);
if (!dir) { console.error('usage: install-scripts.js <project folder> [--omit-dev] [--build-only]'); process.exit(2); }
const omitDev = flags.includes('--omit-dev');
const buildOnly = flags.includes('--build-only');
const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));

const names = new Set();
for (const [key, entry] of Object.entries(lock.packages || {})) {
  if (!key || (omitDev && entry.dev)) continue;
  if (!fs.existsSync(path.join(dir, key))) continue;   // not installed (optional package, other platform, omitted dev)
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (buildOnly ? BUILD_ONLY.includes(name) : entry.hasInstallScript && !BUILD_ONLY.includes(name)) names.add(name);
}
process.stdout.write([...names].join(' ') + '\n');
