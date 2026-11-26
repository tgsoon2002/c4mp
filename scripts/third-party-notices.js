#!/usr/bin/env node
// third-party-notices.js <node_modules dir>      print THIRD-PARTY-NOTICES text for every package in that folder
// third-party-notices.js --bun-section <version> print only the Bun runtime section (for the binaries)
// Walks the folder itself (npm ls fails on a path holding '#'): <dir>/<name>, <dir>/@scope/<name> and nested
// <pkg>/node_modules/... Per package: name, version, license from package.json, the full text of each licence
// file and NOTICE file at the package's top level. One block per name@version, sorted by name then version.
// A package with no license field and no licence file says "license: UNKNOWN" and warns on stderr; exit stays 0.
'use strict';
const fs = require('fs');
const path = require('path');

const RULE = '-'.repeat(72);
const LICENSE_FILE = /^(licen[cs]e|copying)(\.[a-z]+|-[a-z0-9.-]+)?$/i;
const NOTICE_FILE = /^(notice|thirdpartynotice(text)?)(\.[a-z]+)?$/i;

function usage() {
  console.error('usage: third-party-notices.js <node_modules dir> | --bun-section <bun version>');
  process.exit(2);
}

function bunSection(version) {
  return [
    RULE,
    `Bun runtime ${version} (MIT)`,
    RULE,
    'The c4mp single-file executables embed the Bun runtime (https://bun.sh), MIT licensed. Bun itself includes',
    'third-party code (for example JavaScriptCore from WebKit, LGPL-2) under their own licences, listed at',
    'https://bun.sh/docs/project/licensing',
    '',
  ].join('\n');
}

// license field: a string, {type}, or a licenses array of strings / {type}.
function licenseOf(pkg) {
  const one = (l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : '');
  if (pkg.license) return one(pkg.license);
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(one).filter(Boolean).join(' OR ');
  return '';
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
}

// Every package folder under a node_modules dir, nested node_modules included.
function walk(modulesDir, out) {
  for (const name of subdirs(modulesDir)) {
    if (name === '.bin' || name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const sub of subdirs(path.join(modulesDir, name))) visit(path.join(modulesDir, name, sub), out);
    } else {
      visit(path.join(modulesDir, name), out);
    }
  }
  return out;
}

function visit(pkgDir, out) {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  if (pkg && pkg.name) out.push({ dir: pkgDir, pkg });
  const nested = path.join(pkgDir, 'node_modules');
  if (fs.existsSync(nested)) walk(nested, out);
}

function filesMatching(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => e.name).sort();
  } catch { return []; }
}

function block({ dir, pkg }) {
  const license = licenseOf(pkg);
  const licenseFiles = filesMatching(dir, LICENSE_FILE);
  const noticeFiles = filesMatching(dir, NOTICE_FILE).filter((f) => !licenseFiles.includes(f));
  const shown = license || (licenseFiles.length ? 'no license field; see the licence text' : 'license: UNKNOWN');
  const lines = [RULE, `${pkg.name} ${pkg.version || '?'} (${shown})`, RULE];
  if (!license && licenseFiles.length === 0) {
    console.error(`[third-party-notices] WARNING: ${pkg.name}@${pkg.version || '?'} has no license field and no licence file (license: UNKNOWN)`);
    lines.push('(no licence file in the package; package.json license: UNKNOWN)');
  } else if (licenseFiles.length === 0) {
    lines.push(`(no licence file in the package; package.json license: ${license})`);
  }
  for (const f of licenseFiles) lines.push(fs.readFileSync(path.join(dir, f), 'utf8').trimEnd());
  for (const f of noticeFiles) {
    lines.push('', `--- NOTICE (${f}) ---`, fs.readFileSync(path.join(dir, f), 'utf8').trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  if (argv[0] === '--bun-section') {
    if (!argv[1]) usage();
    process.stdout.write(bunSection(argv[1]));
    return;
  }
  const modulesDir = argv[0];
  if (!modulesDir) usage();
  if (!fs.statSync(modulesDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[third-party-notices] ERROR: ${modulesDir} is not a folder`);
    process.exit(1);
  }
  const seen = new Set();
  const pkgs = walk(modulesDir, [])
    .filter(({ pkg }) => {
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.pkg.name < b.pkg.name ? -1 : a.pkg.name > b.pkg.name ? 1
      : String(a.pkg.version).localeCompare(String(b.pkg.version), 'en', { numeric: true })));
  const project = readJson(path.join(path.resolve(modulesDir), '..', 'package.json'));
  const head = ['c4mp third-party notices', '========================'];
  head.push(project && project.version
    ? `c4mp ${project.version} includes these packages.`
    : 'c4mp includes these packages.');
  process.stdout.write(head.join('\n') + '\n\n' + pkgs.map(block).join('\n'));
}

main(process.argv.slice(2));
