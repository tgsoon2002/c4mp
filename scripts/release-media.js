#!/usr/bin/env node
'use strict';
// b917 S4: the release media from the showcase page: hero.mp4 + hero.gif (zoom from the system to one function), sim.gif (one
// simulation in present mode), board.png, io.png, storage.png. Side panels hidden ('&bare'), 1280x720.
// b941: --theme light|dark|both (default both); dark files get -dark before the extension (hero-dark.gif ...).
// Usage: node release-media.js --page <showcase.html> --out <dir> [--target <nodeId>] [--sim <id>] [--theme light|dark|both]
// Run by make-media.sh (it builds the page and picks Release/<version>/media/). Needs ffmpeg (and magick for a big PNG):
// /opt/homebrew/bin or PATH, or env FFMPEG / MAGICK. Frames go to a temp folder of this run, removed at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cdp = require('./cdp-page.js');
const { camAt, legCount, mp4Args, gifArgs, GIF_LADDER, MP4_CRF_LADDER, LIMITS } = require('./media-frames.js');
const { makeSink, recordSim } = require('./media-record.js');

const SIZE = { width: 1280, height: 720 };
const HERO_FPS = 20;
const SIM_FPS = 10;
const MAP_SETTLE_MS = 120;   // after a drawn camera: lets the page's own easing (openness) paint

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tool(envName, name) {
  if (process.env[envName]) return process.env[envName];
  const brew = path.join('/opt/homebrew/bin', name);
  return fs.existsSync(brew) ? brew : name;
}

/** b941: 'light' | 'dark' | 'both' to the themes to film, in order; anything else throws. */
function themesOf(theme) {
  if (theme === 'both') return ['light', 'dark'];
  if (theme === 'light' || theme === 'dark') return [theme];
  throw new Error(`bad theme '${theme}' (use light, dark or both)`);
}

/** b941: 'hero.gif' + 'dark' is 'hero-dark.gif'; light keeps the plain name. */
function themeFile(name, theme) {
  if (theme !== 'dark') return name;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name + '-dark' : name.slice(0, dot) + '-dark' + name.slice(dot);
}

/** b941: the script run before every page load: a clean sessionStorage and the viewer's own setting (localStorage 'c4mp.settings'; Phase 35 C: the viewer reads the old 'c4pm.settings' only when this one is missing). */
function themeScript(theme) {
  return `try { sessionStorage.clear(); } catch (e) { /* none */ }
try { localStorage.setItem('c4mp.settings', JSON.stringify({ theme: ${JSON.stringify(theme)} })); } catch (e) { /* none */ }`;
}

/** Arguments of the command line: { page, out, target?, sim?, theme? }; a missing, unknown or bad one throws. */
function parseMediaArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = { '--page': 'page', '--out': 'out', '--target': 'target', '--sim': 'sim', '--theme': 'theme' }[a];
    if (!key) throw new Error(`unknown argument ${a} (use --page <file> --out <dir> [--target <nodeId>] [--sim <id>] [--theme light|dark|both])`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    o[key] = argv[++i];
  }
  if (!o.page) throw new Error('--page <showcase.html> is required');
  if (!o.out) throw new Error('--out <dir> is required');
  if (o.theme !== undefined) themesOf(o.theme);
  return o;
}

/** Open the page at a hash in a fresh load (a hash-only change would not reload; '&bare' is read once at load). */
async function openAt(page, file, hash, ready) {
  await page.goto('about:blank', { ready: 'true' });
  await page.goto(cdp.fileUrl(file, hash), ready ? { ready } : undefined);
}

/** Hero: the map zooms from the whole system down to one function (camera frame by frame, the flyTo curve, no real-time fly). */
async function recordHero(page, frames, opts = {}) {
  const { target, zoomSec = 5, startSec = 0.8, endSec = 1.5 } = opts;
  const id = await page.eval(`(() => {
    const want = ${JSON.stringify(target || null)};
    if (want) return want;
    const sims = window.C4PM_DATA.sims || [];
    for (const s of sims) for (const st of s.steps) for (const t of st.targets) if (t.view === 'arch' && t.kind === 'function') return t.nodeId;
    return null;
  })()`);
  if (!id) throw new Error('recordHero: no function to zoom to (pass --target <nodeId>)');
  const set = cam => page.eval(`(() => { const T = window.C4PM_STATE; cancelAnimationFrame(T.map.anim); T.map.cam = ${JSON.stringify(cam)}; T.draw(); })()`);
  const cam0 = await page.eval('({ ...window.C4PM_STATE.map.cam })');
  await page.eval(`window.C4PM_MAP.flyTo(${JSON.stringify(id)})`);
  await sleep(2000);   // the page flies there by itself; its end camera is our last frame
  const cam1 = await page.eval('({ ...window.C4PM_STATE.map.cam })');
  if (cam1.s === cam0.s && cam1.tx === cam0.tx) throw new Error(`recordHero: the map did not move to ${id} (not a node of the page?)`);
  await set(cam0);
  await sleep(MAP_SETTLE_MS * 3);
  const { cw, ch } = await page.eval('({ cw: window.C4PM_STATE.map.cw, ch: window.C4PM_STATE.map.ch })');
  await frames.snap(legCount(startSec, frames.fps));
  const n = legCount(zoomSec, frames.fps);
  for (let k = 1; k <= n; k++) {
    await set(camAt(cam0, cam1, k / n, cw, ch));
    await sleep(MAP_SETTLE_MS);
    await frames.snap();
  }
  await page.eval(`window.C4PM_MAP.select(${JSON.stringify(id)})`);   // the last look: the function lit
  await sleep(600);
  await frames.snap(legCount(endSec, frames.fps));
  return { target: id, frames: frames.count() };
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) throw new Error(`${path.basename(bin)} could not run: ${r.error.message} (install it, or set FFMPEG / MAGICK)`);
  if (r.status !== 0) throw new Error(`${path.basename(bin)} failed (exit ${r.status}): ${String(r.stderr).slice(0, 400)}`);
}

/** Frames folder to a GIF; the first rung of GIF_LADDER[kind] whose file fits LIMITS.gif (the last one is kept anyway). */
function encodeGif(dir, fps, out, kind) {
  const ladder = GIF_LADDER[kind];
  let rung;
  for (rung of ladder) {
    run(tool('FFMPEG', 'ffmpeg'), gifArgs(dir, fps, out, rung, { padSec: 0 }));
    if (fs.statSync(out).size <= LIMITS.gif) break;
  }
  return { file: out, bytes: fs.statSync(out).size, rung };
}

/** Frames folder to an H.264 MP4; the first CRF of MP4_CRF_LADDER whose file fits `limit` (the last is kept anyway). */
function encodeMp4(dir, fps, out, limit) {
  let crf;
  for (crf of MP4_CRF_LADDER) {
    run(tool('FFMPEG', 'ffmpeg'), mp4Args(dir, fps, out, { crf }));
    if (fs.statSync(out).size <= limit) break;
  }
  return { file: out, bytes: fs.statSync(out).size, crf };
}

/** board.png, io.png, storage.png: three fresh loads, panels hidden; a PNG over LIMITS.png is shrunk to 128 colours with magick. */
async function shootViews(page, file, outDir, theme = 'light') {
  const out = [];
  const views = [
    // '&bare' also hides the board drawer, so the board shot hides the two side panels with their own toggle buttons instead
    { name: 'board', hash: '#arch', before: `(() => { for (const id of ['toggle-left', 'toggle-right']) { const b = document.getElementById(id); if (b) b.click(); } if (window.C4PM_BOARD) window.C4PM_BOARD.open(); })()` },
    { name: 'io', hash: '#io&bare' },
    { name: 'storage', hash: '#storage&bare' },
  ];
  for (const v of views) {
    await openAt(page, file, v.hash);
    if (v.before) { await page.eval(v.before); await sleep(1500); }
    const png = path.join(outDir, themeFile(v.name + '.png', theme));
    await page.shot(png);
    if (fs.statSync(png).size > LIMITS.png) run(tool('MAGICK', 'magick'), [png, '-colors', '128', png]);
    out.push({ file: png, bytes: fs.statSync(png).size });
  }
  return out;
}

/** b941: the whole run for each theme asked ('light', 'dark' or 'both', default both): returns [{ file, bytes }] of everything written to outDir. */
async function runMedia({ page: file, out: outDir, theme = 'both', ...rest }) {
  const themes = themesOf(theme);
  if (!fs.existsSync(file)) throw new Error(`page not found: ${file}`);
  const made = [];
  for (const t of themes) made.push(...await runTheme({ page: file, out: outDir, theme: t, ...rest }));
  return made;
}

/** b941: one theme, one browser: returns [{ file, bytes }]. */
async function runTheme({ page: file, out: outDir, theme, target, sim, log = console.log }) {
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-media-frames-'));   // this run's own frames only
  const page = await cdp.launch(SIZE);
  const made = [];
  try {
    await page.theme(theme);
    // the page keeps its view state in sessionStorage (same tab): every load starts clean, no selected simulation;
    // the viewer's theme setting is stored before the first frame (viewer/settings.js reads localStorage 'c4mp.settings')
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: themeScript(theme) });
    log(`theme: ${theme}`);
    log('hero: zoom from the system to one function');
    await openAt(page, file, '#arch&bare');
    const heroDir = path.join(work, 'hero');
    const hero = await recordHero(page, makeSink(page, heroDir, HERO_FPS), { target });
    log(`  ${hero.frames} frames, target ${hero.target}`);
    made.push(encodeMp4(heroDir, HERO_FPS, path.join(outDir, themeFile('hero.mp4', theme)), LIMITS.heroMp4));
    made.push(encodeGif(heroDir, HERO_FPS, path.join(outDir, themeFile('hero.gif', theme)), 'hero'));

    log('simulation: present mode');
    await openAt(page, file, '#arch&bare');
    const simDir = path.join(work, 'sim');
    const film = await recordSim(page, makeSink(page, simDir, SIM_FPS), { simId: sim });
    log(`  ${film.steps.length} steps`);
    made.push(encodeGif(simDir, SIM_FPS, path.join(outDir, themeFile('sim.gif', theme)), 'sim'));

    log('screenshots: board, io, storage');
    made.push(...await shootViews(page, file, outDir, theme));
  } finally {
    page.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return made;
}

module.exports = { parseMediaArgs, themesOf, themeFile, themeScript, runMedia, runTheme, recordHero, shootViews, encodeGif, encodeMp4 };

if (require.main === module) {
  (async () => {
    const o = parseMediaArgs(process.argv.slice(2));
    const made = await runMedia(o);
    for (const m of made) console.log(`${path.basename(m.file)}  ${(m.bytes / 1048576).toFixed(2)} MB`);
  })().catch(e => { console.error('release-media: ' + e.message); process.exit(1); });
}
