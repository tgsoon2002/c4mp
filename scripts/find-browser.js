'use strict';
// b924: the ONE browser finder for tests (test/helpers/chrome.ts) and scripts (cdp-page.js).
// Plain Node CommonJS, no dependency. Env CHROME wins; then the usual places, in a fixed order; null when none.
// Two questions, one list: findBrowser() = any kind (CDP use: cdp-page.js, serve-chrome, the media scripts);
// findBrowser({ dumpDom: true }) = only the kinds proven with --dump-dom / --screenshot / --virtual-time-budget
// (Chrome, Chrome for Testing, Chromium, the Playwright headless shell; env CHROME too). Brave and Edge are CDP only.
const fs = require('fs');
const os = require('os');
const path = require('path');

// [app path inside Applications, dumpDom-proven]
const MAC_APPS = [
  ['Google Chrome.app/Contents/MacOS/Google Chrome', true],
  ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', true],
  ['Chromium.app/Contents/MacOS/Chromium', true],
  ['Brave Browser.app/Contents/MacOS/Brave Browser', false],
  ['Microsoft Edge.app/Contents/MacOS/Microsoft Edge', false],
];
const LINUX_BINS = [
  ['google-chrome', true], ['google-chrome-stable', true], ['chrome-for-testing', true], ['chromium', true], ['chromium-browser', true],
  ['brave-browser', false], ['brave', false], ['microsoft-edge', false], ['microsoft-edge-stable', false],
];
const LINUX_DIRS = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome', '/opt/brave.com/brave'];

/** Candidates in order: [{ path, dumpDom }] (the Playwright headless shell, used by this repo's tests before, comes first on a Mac that has it). */
function candidates({ platform = process.platform, home = os.homedir() } = {}) {
  const list = [];
  if (platform === 'darwin') {
    const pw = path.join(home, 'Library/Caches/ms-playwright');
    try {
      for (const d of fs.readdirSync(pw).sort().reverse()) {
        if (d.startsWith('chromium_headless_shell-')) list.push({ path: path.join(pw, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'), dumpDom: true });
      }
    } catch (e) { /* no Playwright cache */ }
    for (const [app, dumpDom] of MAC_APPS) { list.push({ path: path.join('/Applications', app), dumpDom }); list.push({ path: path.join(home, 'Applications', app), dumpDom }); }
  } else {
    for (const [b, dumpDom] of LINUX_BINS) for (const d of LINUX_DIRS) list.push({ path: path.join(d, b), dumpDom });
  }
  return list;
}

/** First usable browser binary, or null. env.CHROME wins when it exists; dumpDom: true keeps only the dump-dom-proven kinds; exists is injectable. */
function findBrowser({ env = process.env, exists = fs.existsSync, platform, home, dumpDom = false } = {}) {
  if (env.CHROME && exists(env.CHROME)) return env.CHROME;
  for (const c of candidates({ platform, home })) if ((!dumpDom || c.dumpDom) && exists(c.path)) return c.path;
  return null;
}

module.exports = { findBrowser, candidates };
