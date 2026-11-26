'use strict';
// b917 S2: pure helpers for the release media: camera curve, frame names, ffmpeg argument lists, size limits.
// No I/O, no Chrome, no ffmpeg run. The curve is the one of viewer/camera.js flyTo, with any duration.
const path = require('path');

const FRAME_PATTERN = 'f%05d.png';
const MP4_CRF_LADDER = [23, 26, 29];   // default first; step down when the file is over its limit
const GIF_LADDER = {
  hero: [{ width: 720, gifFps: 12, colors: 128 }, { width: 640, gifFps: 12, colors: 96 }, { width: 560, gifFps: 10, colors: 64 }],
  sim: [{ width: 960, gifFps: 10, colors: 128 }, { width: 800, gifFps: 10, colors: 128 }, { width: 720, gifFps: 8, colors: 96 }],
};
const MIB = 1048576;
const LIMITS = { heroMp4: 4 * MIB, simMp4: 6 * MIB, gif: 8 * MIB, png: MIB };

function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }

/** Camera { s, tx, ty } at progress p (0..1) between two cameras: zoom on a log scale, centre linear, eased. */
function camAt(from, to, p, cw, ch) {
  const e = easeInOut(Math.min(1, Math.max(0, p)));
  const cx0 = (cw / 2 - from.tx) / from.s, cy0 = (ch / 2 - from.ty) / from.s;
  const cx1 = (cw / 2 - to.tx) / to.s, cy1 = (ch / 2 - to.ty) / to.s;
  const s = from.s * Math.pow(to.s / from.s, e);
  const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
  return { s, tx: cw / 2 - cx * s, ty: ch / 2 - cy * s };
}

function legCount(seconds, fps) { return Math.max(1, Math.round(seconds * fps)); }

function frameName(n) { return 'f' + String(n).padStart(5, '0') + '.png'; }

function padFilter(padSec) { return padSec > 0 ? `tpad=stop_mode=clone:stop_duration=${padSec},` : ''; }

/** ffmpeg arguments: PNG frame folder to H.264 MP4 (padSec holds the last frame that long). */
function mp4Args(dir, fps, out, { crf = 23, padSec = 0 } = {}) {
  return ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, FRAME_PATTERN),
    '-vf', padFilter(padSec) + 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-tune', 'animation', '-movflags', '+faststart', '-an', out];
}

/** ffmpeg arguments: PNG frame folder to a looping palette GIF. rung = { width, gifFps, colors }. */
function gifArgs(dir, fps, out, rung, { padSec = 0 } = {}) {
  const { width, gifFps, colors } = rung;
  return ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, FRAME_PATTERN),
    '-vf', padFilter(padSec) +
      `fps=${gifFps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', out];
}

module.exports = { easeInOut, camAt, legCount, frameName, FRAME_PATTERN, mp4Args, gifArgs, GIF_LADDER, MP4_CRF_LADDER, LIMITS };
