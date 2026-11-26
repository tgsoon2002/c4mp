'use strict';
// b951 (Phase 35 I): rebuild every brand image from Brand/logo/*.svg into one folder (default Brand/png).
// Usage: node Project/scripts/render-brand.js [--out Brand/png]
// Needs a Chrome-like browser (Space Grotesk and Inter come from Google Fonts, so it needs the network) and ImageMagick for favicon.ico.
// It writes only inside the out folder (temp pages live in out/.render-tmp and are removed).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** The top folder (same rule as c4mp_top in names.sh): the git top level of Project/, else Project/ itself. */
function topDir() {
  const project = path.resolve(__dirname, '..');
  try {
    const top = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return top || project;
  } catch { return project; }
}
/** Brand folder: <top>/Brand when it exists, else <top>/brand (the public tree), else <top>/Brand. */
function brandDir(top) {
  return fs.existsSync(path.join(top, 'Brand')) || !fs.existsSync(path.join(top, 'brand')) ? path.join(top, 'Brand') : path.join(top, 'brand');
}
const BRAND = brandDir(topDir());
const LOGO = path.join(BRAND, 'logo');
const MAGICK = process.env.MAGICK || '/opt/homebrew/bin/magick';
const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Space+Grotesk:wght@700&display=swap">';
const FONT_READY = '(async()=>{await Promise.all([document.fonts.load(\'700 112px "Space Grotesk"\'),document.fonts.load(\'400 30px Inter\')]);' +
  'return document.readyState==="complete"&&document.fonts.status==="loaded"&&document.fonts.check(\'700 112px "Space Grotesk"\')&&document.fonts.check(\'400 30px Inter\')})()';
const TAGLINE = 'C4MP: your crew, your map, your plan, in one camp.';

/** The command line: only --out <folder> (default Brand/png under the repo). Anything else throws. */
function parseBrandArgs(argv) {
  let out = path.join(BRAND, 'png');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('--out needs a folder');
      out = path.resolve(argv[++i]);
    } else throw new Error(`unknown argument: ${argv[i]} (usage: render-brand.js [--out <folder>])`);
  }
  return { out };
}

/** Every file the script writes, all inside out. kind: icon (svg square), wordmark (svg 372x128), social, ico (magick). */
function brandTargets(out) {
  const t = [];
  for (const [suffix, svgBase] of [['', 'c4mp-icon'], ['-dark', 'c4mp-icon-dark']]) {
    for (const size of [512, 180, 64, 32, 16]) {
      const small = size === 32 || size === 16;
      const svg = small ? `${svgBase}-${size}.svg` : `${svgBase}.svg`;
      t.push({ file: path.join(out, `c4mp-icon${suffix}-${size}.png`), kind: 'icon', svg, size });
    }
  }
  for (const theme of ['light', 'dark']) {
    t.push({ file: path.join(out, `c4mp-logo-${theme}.png`), kind: 'wordmark', svg: `c4mp-logo-${theme}.svg`, scale: 1 });
    t.push({ file: path.join(out, `c4mp-logo-${theme}@2x.png`), kind: 'wordmark', svg: `c4mp-logo-${theme}.svg`, scale: 2 });
  }
  t.push({ file: path.join(out, 'social-preview.png'), kind: 'social', theme: 'dark' });
  t.push({ file: path.join(out, 'social-preview-light.png'), kind: 'social', theme: 'light' });
  t.push({ file: path.join(out, 'favicon.ico'), kind: 'ico' });
  return t;
}

/** An SVG file as inline markup with width/height replaced by a CSS size. */
function inlineSvg(name, cssSize) {
  const s = fs.readFileSync(path.join(LOGO, name), 'utf8');
  return s.replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} style="display:block;${cssSize}">`);
}

/** The HTML page for one browser target, plus its viewport (css px) and device scale. */
function pageFor(t) {
  const base = 'html,body{margin:0;padding:0;background:transparent}';
  if (t.kind === 'icon') {
    return { w: t.size, h: t.size, dsf: 1, html: `<style>${base}</style>${inlineSvg(t.svg, `width:${t.size}px;height:${t.size}px`)}` };
  }
  if (t.kind === 'wordmark') {
    return { w: 372, h: 128, dsf: t.scale, html: `<style>${base}</style>${FONT_LINK}${inlineSvg(t.svg, 'width:372px;height:128px')}` };
  }
  const dark = t.theme === 'dark';
  const bg = dark ? '#121715' : '#FFFFFF';
  const fg = dark ? '#F3F4F1' : '#1F6F5C';
  const css = `html,body{margin:0;width:1280px;height:640px;background:${bg};overflow:hidden}` +
    `.c{position:absolute;left:40px;top:40px;right:40px;bottom:40px;display:flex;flex-direction:column;align-items:center;justify-content:center}` +
    `.t{margin-top:44px;font:500 34px/1.2 Inter,sans-serif;color:${fg};letter-spacing:.2px}` +
    `.b{position:absolute;right:40px;bottom:40px}`;
  const wordmark = inlineSvg(`c4mp-logo-${t.theme}.svg`, 'width:744px;height:256px');
  const badge = inlineSvg(dark ? 'c4mp-icon-dark.svg' : 'c4mp-icon.svg', 'width:64px;height:64px');
  return { w: 1280, h: 640, dsf: 1, html: `<style>${css}</style>${FONT_LINK}<div class="c">${wordmark}<div class="t">${TAGLINE}</div></div><div class="b">${badge}</div>` };
}

/** Rebuild every target into out; returns the written files. */
async function renderBrand(out) {
  const { launch, fileUrl } = require('./cdp-page.js');
  const tmp = path.join(out, '.render-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const written = [];
  const page = await launch({ width: 1280, height: 640 });
  try {
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const t of brandTargets(out)) {
      if (t.kind === 'ico') continue;
      const p = pageFor(t);
      const html = path.join(tmp, path.basename(t.file) + '.html');
      fs.writeFileSync(html, `<!doctype html><meta charset="utf-8">${p.html}`);
      await page.send('Emulation.setDeviceMetricsOverride', { width: p.w, height: p.h, deviceScaleFactor: p.dsf, mobile: false });
      await page.goto(fileUrl(html), { ready: t.kind === 'icon' ? 'document.readyState==="complete"' : FONT_READY });
      await page.shot(t.file);
      written.push(t.file);
    }
  } finally {
    page.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const ico = path.join(out, 'favicon.ico');
  execFileSync(MAGICK, [path.join(out, 'c4mp-icon-16.png'), path.join(out, 'c4mp-icon-32.png'), ico]);
  written.push(ico);
  return written;
}

if (require.main === module) {
  (async () => {
    const { out } = parseBrandArgs(process.argv.slice(2));
    fs.mkdirSync(out, { recursive: true });
    for (const f of await renderBrand(out)) console.log(path.relative(process.cwd(), f));
  })().catch(e => { console.error('render-brand: ' + e.message); process.exit(1); });
}

module.exports = { parseBrandArgs, brandTargets, renderBrand };
