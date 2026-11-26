import * as fs from 'fs';
import * as path from 'path';
import { log } from '../log';

// W3 (b299): the I/O seam for screen wireframes (PHASE_20_WIREFRAMES.md C4, C7 file rules, F1, H11).
// For a plan folder it reads `<plan folder>/io/<screen fqn>.html`, inlines the linked stylesheets that live inside io/, and reports
// what it could not use. It only reads and reports: it never parses data-c4 refs (wireframeRefs.ts) and never decides a
// severity (wireframeCheck.ts). buildNav stays pure: the caller passes the result in.

/** Size cap for one wireframe, one stylesheet and the inlined result (C7). Over the cap is an error entry, not a skip. */
export const WIREFRAME_MAX_BYTES = 512 * 1024;

/** One plan fqn segment is [A-Za-z_][A-Za-z0-9_-]*, joined by dots (same grammar as the lexer). */
const FQN_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

/** A `<link>` that was removed from the wireframe instead of inlined (the screen still loads). href is null when the tag has none. */
export interface WireframeBadLink { href: string | null; reason: string; }

/** The wireframe of one screen. `html` is the file text with the good sheets inlined; `error` replaces it when the file cannot be used. */
export interface WireframeFile {
  fqn: string;
  /** Repo-relative posix path (may start with `../` when the plan folder is outside the repo), like findPlanFiles. */
  file: string;
  html?: string;
  error?: string;
  /** Sheet paths inside io/ that were inlined, in file order. */
  inlined: string[];
  badLinks: WireframeBadLink[];
  /**
   * W7 (b303): `style="..."` attributes and `<style>` blocks in the file's own text (before sheets are inlined; comments skipped),
   * for the wireframe-inline-style rule (K 2026-11-07: classes only). Set when the file text was read, absent otherwise.
   */
  styleAttrs?: number;
  styleBlocks?: number;
}

export type WireframeLoad =
  | { status: 'unsupported'; reason: string }
  | {
      status: 'ok';
      /** W7 (b303): repo-relative posix path of the io folder (same form as `file`), set whether or not it exists. */
      io: string;
      /** True when the plan folder has an io/ folder (K2: wireframe-missing only fires then). */
      hasIo: boolean;
      /** Set when io/ exists but cannot be read (a symlink, not a folder, no permission); then no file is loaded. */
      ioError?: string;
      /** Only screens that have a file; a screen without one is simply absent (= missing). */
      files: Map<string, WireframeFile>;
      /** Repo-relative paths of io/*.html files that name no screen. */
      orphans: string[];
    };

/**
 * Load the wireframes of `screenFqns` from `planDir` (findPlanFiles().dir). `repoRoot` only shapes the reported paths.
 * planDir null = the plan is the whole repo: unsupported (K1), logged. One bad screen never stops the others.
 */
export function loadWireframes(repoRoot: string, planDir: string | null, screenFqns: string[]): WireframeLoad {
  if (planDir === null) {
    const reason = 'the plan has no folder (it is the whole repo), so there is no io/ folder for wireframes';
    log('wireframes', 'unsupported', { repoRoot, reason });
    return { status: 'unsupported', reason };
  }
  const files = new Map<string, WireframeFile>();
  const orphans: string[] = [];
  const ioDir = path.join(planDir, 'io');
  const rel = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join('/');

  let ioStat: fs.Stats;
  try {
    ioStat = fs.lstatSync(ioDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log('wireframes', 'no io folder', { planDir });
      return { status: 'ok', io: rel(ioDir), hasIo: false, files, orphans };
    }
    return ioProblem(files, orphans, ioDir, rel, `io/ cannot be read: ${(err as Error).message}`);
  }
  if (ioStat.isSymbolicLink()) return ioProblem(files, orphans, ioDir, rel, 'io/ is a symbolic link, not followed');
  if (!ioStat.isDirectory()) return ioProblem(files, orphans, ioDir, rel, 'io is not a folder');

  let names: string[];
  try {
    names = fs.readdirSync(ioDir);
  } catch (err) {
    return ioProblem(files, orphans, ioDir, rel, `io/ cannot be listed: ${(err as Error).message}`);
  }

  const wanted = new Set(screenFqns);
  for (const fqn of screenFqns) {
    const entry = loadOne(ioDir, fqn, rel);
    if (entry) files.set(fqn, entry);
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.html') || wanted.has(name.slice(0, -'.html'.length))) continue;
    // Symlinks and folders are not wireframes; they are skipped, not reported (C7).
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(ioDir, name)); } catch { continue; }
    if (st.isFile()) orphans.push(rel(path.join(ioDir, name)));
  }
  log('wireframes', 'loaded', { planDir, screens: screenFqns.length, files: files.size, orphans: orphans.length });
  return { status: 'ok', io: rel(ioDir), hasIo: true, files, orphans };
}

function ioProblem(files: Map<string, WireframeFile>, orphans: string[], ioDir: string, rel: (abs: string) => string, ioError: string): WireframeLoad {
  log('wireframes', 'io folder error', { ioDir, ioError });
  return { status: 'ok', io: rel(ioDir), hasIo: true, ioError, files, orphans };
}

/** The wireframe of one screen, or null when it has no file. A file that exists but cannot be used comes back with `error`. */
function loadOne(ioDir: string, fqn: string, rel: (abs: string) => string): WireframeFile | null {
  if (!FQN_RE.test(fqn)) {
    // The name would go into a path: never build one from a string outside the charset.
    return { fqn, file: `io/${fqn}.html`, error: `screen fqn ${JSON.stringify(fqn)} has characters a wireframe file name cannot hold`, inlined: [], badLinks: [] };
  }
  const abs = path.join(ioDir, `${fqn}.html`);
  const out: WireframeFile = { fqn, file: rel(abs), inlined: [], badLinks: [] };
  const text = readGuarded(abs);
  if (text === null) return null;
  if (typeof text !== 'string') { out.error = text.error; return out; }
  const styles = countInlineStyles(text);
  out.styleAttrs = styles.attrs;
  out.styleBlocks = styles.blocks;
  const r = inlineSheets(ioDir, text);
  out.inlined = r.inlined;
  out.badLinks = r.badLinks;
  if (Buffer.byteLength(r.html, 'utf8') > WIREFRAME_MAX_BYTES) {
    out.error = `wireframe with its stylesheets is over ${WIREFRAME_MAX_BYTES / 1024} KB`;
    return out;
  }
  out.html = r.html;
  return out;
}

/**
 * File text; null when there is no such file; {error} when it exists but is a symlink, not a regular file, over the cap or unreadable.
 * Symlinks are never read (C7); a symlinked wireframe is an error entry so the author sees why the screen has none.
 */
function readGuarded(abs: string): string | { error: string } | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: `cannot be read: ${(err as Error).message}` };
  }
  if (st.isSymbolicLink()) return { error: 'is a symbolic link, not followed' };
  if (!st.isFile()) return { error: 'is not a regular file' };
  if (st.size > WIREFRAME_MAX_BYTES) return { error: `is ${Math.ceil(st.size / 1024)} KB, over the ${WIREFRAME_MAX_BYTES / 1024} KB cap` };
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { error: `cannot be read: ${(err as Error).message}` };
  }
}

// A comment (kept as it is, so a link inside it is not inlined) or a <link> tag.
const LINK_OR_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)|<link\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
// One attribute: name, then "v", 'v', v or nothing.
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// A comment, or a start tag (group 1 = its name). End tags, doctypes and a lone '<' do not match.
const COMMENT_OR_START_TAG_RE = /<!--[\s\S]*?(?:-->|$)|<([A-Za-z][^\s/>]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
// Elements whose content is text, not markup: a `style=` in there is no attribute.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'textarea']);

/** W7 (b303): the `style` attributes and `<style>` blocks of a wireframe's own text; comments and raw-text content are skipped. */
function countInlineStyles(html: string): { attrs: number; blocks: number } {
  let attrs = 0;
  let blocks = 0;
  const re = new RegExp(COMMENT_OR_START_TAG_RE.source, 'g');
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[1] === undefined) continue;   // a comment
    const name = m[1].toLowerCase();
    if (attrsOf(m[0]).has('style')) attrs++;
    if (name === 'style') blocks++;
    if (RAW_TEXT_TAGS.has(name)) {
      const close = new RegExp('</' + name + '(?=[\\s/>])', 'ig');
      close.lastIndex = re.lastIndex;
      const end = close.exec(html);
      if (end === null) break;   // unclosed: the rest is its text
      re.lastIndex = end.index;
    }
  }
  return { attrs, blocks };
}

/** The attributes of one start tag (any tag name), lower-case names; the first of a repeated name wins. */
function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = tag.replace(/^<[^\s\/>]+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** H11: a href is good when it is a relative path that stays inside io/: no scheme, no leading slash, no `..`, no backslash. */
function hrefProblem(href: string): string | null {
  if (href === '') return 'empty href';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return 'a URL, not a relative path';
  if (href.startsWith('/')) return 'an absolute path';
  if (href.includes('\\')) return 'a backslash in the path';
  if (/[?#]/.test(href)) return 'a query or fragment in the path';
  if (href.split('/').some(seg => seg === '..')) return 'a path outside io/';
  if (!href.toLowerCase().endsWith('.css')) return 'not a .css file';
  return null;
}

/** The sheet text, or the reason it cannot be inlined. realpath keeps a symlinked sub-folder from leading out of io/. */
function readSheet(ioDir: string, href: string): { css: string } | { reason: string } {
  const abs = path.join(ioDir, ...href.split('/').filter(s => s !== '' && s !== '.'));
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    return { reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file does not exist' : `cannot be read: ${(err as Error).message}` };
  }
  const relReal = path.relative(fs.realpathSync(ioDir), real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return { reason: 'a path outside io/' };
  const got = readGuarded(abs);
  if (got === null) return { reason: 'file does not exist' };
  if (typeof got !== 'string') return { reason: got.error };
  // Text in a <style> element ends at the first </style; refuse a sheet that would break out of it.
  if (/<\/style/i.test(got)) return { reason: 'contains "</style"' };
  return { css: got };
}

/**
 * H11: replace each `<link rel="stylesheet" href="x.css">` by `<style>` holding the sheet, in file order. A link that is not a good
 * stylesheet link is removed and listed in badLinks. Links inside HTML comments are left alone.
 */
export function inlineSheets(ioDir: string, html: string): { html: string; inlined: string[]; badLinks: WireframeBadLink[] } {
  const inlined: string[] = [];
  const badLinks: WireframeBadLink[] = [];
  const out = html.replace(LINK_OR_COMMENT_RE, tag => {
    if (tag.startsWith('<!--')) return tag;
    const attrs = attrsOf(tag);
    const href = attrs.get('href') ?? null;
    const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const bad = (reason: string) => { badLinks.push({ href, reason }); return ''; };
    if (!rels.includes('stylesheet')) return bad('rel is not "stylesheet"');
    if (href === null) return bad('no href');
    const problem = hrefProblem(href);
    if (problem) return bad(problem);
    const sheet = readSheet(ioDir, href);
    if ('reason' in sheet) return bad(sheet.reason);
    inlined.push(href);
    return `<style>/* ${href.replace(/\*\//g, '')} */\n${sheet.css}\n</style>`;
  });
  return { html: out, inlined, badLinks };
}
