'use strict';
// b917 S3: record a CDP page into numbered PNG frames for the release media (frame sink + the simulation film).
// Own file, not media-frames.js: that one is pure (no I/O), this one writes files and drives a Page of cdp-page.js.
const fs = require('fs');
const path = require('path');
const { frameName } = require('./media-frames.js');

/**
 * Numbered PNG frames (f00001.png ...) of a page in `dir`. A hold repeats the last frame as hard links (no extra disk).
 * add(png, repeat) writes one buffer and holds it repeat - 1 more times; snap(repeat) takes the shot first; hold(n) repeats the last frame.
 */
function makeSink(page, dir, fps) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const file = i => path.join(dir, frameName(i));
  const sink = {
    dir,
    fps,
    count: () => n,
    hold(count) {
      if (n === 0) throw new Error('makeSink: hold before any frame');
      const src = file(n);
      for (let k = 0; k < count; k++) fs.linkSync(src, file(++n));
      return n;
    },
    add(png, repeat = 1) {
      if (!(repeat >= 1)) return n;
      fs.writeFileSync(file(++n), png);
      return repeat > 1 ? sink.hold(repeat - 1) : n;
    },
    async snap(repeat = 1) { return sink.add(await page.shot(), repeat); },
  };
  return sink;
}

/**
 * Film `seconds` of the page as it moves: take shots for the first `activeMs` (the fly), each one shown from the moment it was
 * taken until the next one (hard-link holds keep the real timing), then hold the last shot to the end. Returns the frames added.
 */
async function filmWindow(page, frames, seconds, activeMs) {
  const t0 = Date.now();
  const shots = [];
  do {
    const at = Date.now() - t0;
    shots.push({ at, png: await page.shot() });
  } while (Date.now() - t0 < activeMs);
  const total = Math.round(seconds * frames.fps);
  const start = frames.count();
  let used = 0;
  shots.forEach((s, k) => {
    const next = k + 1 < shots.length ? shots[k + 1].at : seconds * 1000;
    const upTo = k + 1 < shots.length ? Math.round(next * frames.fps / 1000) : total;
    const repeat = Math.max(1, upTo - used);
    frames.add(s.png, repeat);
    used += repeat;
  });
  return frames.count() - start;
}

/**
 * Film one simulation in present mode: the page's own C4PM_SIM hooks (present, presentGo) move the cursor and fly the map;
 * each step is shown `stepSec` seconds, the last one `outroSec` more. Needs a page with simulations (window.C4PM_SIM).
 */
async function recordSim(page, frames, opts = {}) {
  const { simId, stepSec = 3, flyMs = 1100, outroSec = 1.5 } = opts;
  const list = await page.eval('(() => { const S = window.C4PM_SIM; return S ? S.items().map(s => ({ id: s.id, n: S.steps(s.id).length })) : null; })()');
  if (!list || !list.length) throw new Error('recordSim: the page has no simulation (window.C4PM_SIM missing or empty)');
  const sim = simId ? list.find(s => s.id === simId) : list[0];
  if (!sim) throw new Error(`recordSim: no simulation ${simId} (have ${list.map(s => s.id).join(', ')})`);
  await page.eval(`window.C4PM_SIM.hooks.present(${JSON.stringify(sim.id)}, 0)`);
  const steps = [];
  for (let i = 0; i < sim.n; i++) {
    if (i > 0) await page.eval(`window.C4PM_SIM.hooks.presentGo(${i})`);
    const from = frames.count() + 1;
    const last = i === sim.n - 1;
    const added = await filmWindow(page, frames, stepSec + (last ? outroSec : 0), flyMs);
    steps.push({ i, from, frames: added });
  }
  return { steps };
}

module.exports = { makeSink, filmWindow, recordSim };
