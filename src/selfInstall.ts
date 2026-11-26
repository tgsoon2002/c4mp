/**
 * P22-install: `c4mp install` / `c4mp uninstall` make the single-file binary a global command.
 * Copies the running binary into a user folder (no sudo, nothing outside that folder), and offers to add the folder
 * to PATH: a marked block in the shell profile (macOS, Linux) or the user PATH through PowerShell (Windows).
 * All outside effects go through InstallEnv, so tests run with fakes and no real home folder, shell or binary.
 */
import * as path from 'path';
import { CMD_NAME, HOOK_BEGIN, HOOK_END, LEGACY_CMD_NAME, findMarkedBlock } from './constants';

export interface InstallFs {
  mkdirp(dir: string): void;
  exists(p: string): boolean;
  isFile(p: string): boolean;
  copyFile(from: string, to: string): void;
  rename(from: string, to: string): void;
  chmod(p: string, mode: number): void;
  unlink(p: string): void;
  readText(p: string): string;
  writeText(p: string, text: string): void;
  /** Creates a symbolic link `linkPath` pointing at `target` (not used on Windows). */
  symlink(target: string, linkPath: string): void;
  /** True when `p` itself is a symbolic link (also a dangling one). Never throws. */
  isSymlink(p: string): boolean;
  /** Real path with symlinks resolved; the same path when it cannot be resolved. Never throws. */
  realpath(p: string): string;
  /** True when the current user can create, rename and remove files in this folder. Never throws. */
  canWrite(dir: string): boolean;
}

export interface InstallEnv {
  platform: NodeJS.Platform;
  home: string;
  localAppData?: string;
  /** process.execPath: the c4mp file itself in the compiled binary, the node binary under node. */
  execPath: string;
  /** process.argv[1]: a script path under node, /$bunfs/root/... in the compiled binary. */
  scriptPath?: string;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  /** Version of the running c4mp (the one being installed). */
  version: string;
  ask(question: string): Promise<boolean>;
  /** Asks a question and returns the typed line. */
  prompt(question: string): Promise<string>;
  /** Runs a program; status is null when it could not start or timed out. Never throws. */
  run(cmd: string, args: string[], timeoutMs?: number): { status: number | null; stdout: string };
  fs: InstallFs;
  out(line: string): void;
  err(line: string): void;
}

export interface InstallOptions {
  dir?: string;
  yes?: boolean;
  noPath?: boolean;
  /** What to do with every other c4mp copy found: no question is asked. */
  old?: OldAction;
}

export type OldAction = 'remove' | 'backup' | 'leave';
export const OLD_ACTIONS: OldAction[] = ['remove', 'backup', 'leave'];

/** Another c4mp file on this machine (not the install target). */
export interface OtherCopy {
  /** Where it was found: folder + file name. */
  file: string;
  dir: string;
  real: string;
  /** 'unknown' when `--version` could not be read. */
  version: string;
  /** Position of its folder in PATH, -1 when not on PATH. */
  pathIndex: number;
  /** Managed by Homebrew (real path under Cellar or Caskroom): never touched. */
  brew: boolean;
  /** The user can rename or remove it (its folder is writable). */
  writable: boolean;
}

export interface OldPlan {
  /** Lines starting with 'would ': actions c4mp does after consent. */
  wouldLines: string[];
  /** to undefined = remove, else rename to `to`. */
  moves: { file: string; to?: string }[];
  /** Copies still present after the plan is done (left, Homebrew, sudo needed, Windows). */
  left: OtherCopy[];
}

const NODE_NAMES = ['node', 'nodejs'];
const SCRIPT_EXT = /\.(c|m)?(js|ts)$/i;

/** True when the running program is the compiled c4mp file (not node running a script). */
export function isCompiledBinary(execPath: string, scriptPath: string | undefined): boolean {
  const base = path.win32.basename(execPath.replace(/\//g, '\\')).toLowerCase().replace(/\.exe$/, '');
  if (NODE_NAMES.includes(base)) return false;
  const inBundle = scriptPath !== undefined && /\$bunfs|~BUN/i.test(scriptPath);
  return inBundle || scriptPath === undefined || !SCRIPT_EXT.test(scriptPath);
}

const pathLib = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);
const isWin = (e: InstallEnv): boolean => e.platform === 'win32';

/** Default folder: ~/.local/bin, or %LOCALAPPDATA%\Programs\c4mp on Windows. */
export function defaultInstallDir(e: InstallEnv): string {
  const P = pathLib(e.platform);
  if (isWin(e)) return P.join(e.localAppData || P.join(e.home, 'AppData', 'Local'), 'Programs', 'c4mp');
  return P.join(e.home, '.local', 'bin');
}

export function binaryName(e: InstallEnv): string {
  return isWin(e) ? 'c4mp.exe' : 'c4mp';
}
/** Phase 35 B: the old command file name (c4pm, c4pm.exe on Windows), kept beside c4mp as an alias. */
export function legacyBinaryName(e: InstallEnv): string {
  return isWin(e) ? `${LEGACY_CMD_NAME}.exe` : LEGACY_CMD_NAME;
}

/**
 * Phase 35 B: put the c4pm alias at `alias`, next to the installed `target`. macOS and Linux: a relative symlink (it
 * survives moving the folder). Windows: a copy of the exe (a symlink needs a privilege; a copy runs from any shell).
 * Written beside the alias, then renamed over it, so a running old alias is not corrupted.
 */
export function makeAlias(e: InstallEnv, target: string, alias: string): void {
  const tmp = `${alias}.new-${process.pid}`;
  try {
    if (isWin(e)) e.fs.copyFile(target, tmp);
    else e.fs.symlink(pathLib(e.platform).basename(target), tmp);
    e.fs.rename(tmp, alias);
  } catch (err) {
    try {
      e.fs.unlink(tmp);
    } catch {
      // the temp file may not exist
    }
    throw err;
  }
}

/**
 * Phase 35 B: true when the file at `alias` is the one this installer makes: a link that points at `target` (or
 * dangles), a Windows copy, or, once `target` is gone, a plain old c4pm left by an older install. A different real
 * c4pm beside a live c4mp is somebody else's copy: false.
 */
export function isOwnAlias(e: InstallEnv, alias: string, target: string): boolean {
  if (isWin(e)) return e.fs.exists(alias);
  if (e.fs.isSymlink(alias)) return !e.fs.exists(alias) || e.fs.realpath(alias) === e.fs.realpath(target);
  return e.fs.exists(alias) && !e.fs.exists(target);
}

function resolveDir(e: InstallEnv, opts: InstallOptions): string {
  const P = pathLib(e.platform);
  if (!opts.dir) return defaultInstallDir(e);
  const d = opts.dir === '~' || opts.dir.startsWith('~/') ? P.join(e.home, opts.dir.slice(1)) : opts.dir;
  return P.resolve(e.home, d);
}

/** The folders of PATH, in order, without empty parts. */
export function pathEntries(e: InstallEnv): string[] {
  return (e.env.PATH ?? e.env.Path ?? '').split(isWin(e) ? ';' : ':').filter(p => p !== '');
}

/** Position of `dir` in PATH (same folder, trailing slash and, on Windows, case ignored); -1 when absent. */
export function pathIndexOf(e: InstallEnv, dir: string): number {
  const P = pathLib(e.platform);
  const norm = (s: string) => {
    const r = P.normalize(s).replace(/[\\/]+$/, '');
    return isWin(e) ? r.toLowerCase() : r;
  };
  const want = norm(dir);
  return pathEntries(e).findIndex(p => norm(p) === want);
}

/** Quotes a path for a shell command line only when it needs it. */
function shQuote(s: string): string {
  return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

/** First line of `<file> --version`, 'unknown' when it cannot be read in a short time. */
function readVersion(e: InstallEnv, file: string): string {
  const r = e.run(file, ['--version'], 3000);
  const v = r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0].trim() : '';
  return v || 'unknown';
}

/**
 * Every other c4mp on this machine: each PATH folder, plus /usr/local/bin, /opt/homebrew/bin, ~/.local/bin and the
 * install folder (Windows: PATH and the install folder). De-duplicated by real path; the install target is skipped.
 */
export function findOtherCopies(e: InstallEnv, dir: string, target: string): OtherCopy[] {
  const P = pathLib(e.platform);
  const key = (p: string) => (isWin(e) ? p.toLowerCase() : p);
  const extra = isWin(e) ? [dir] : ['/usr/local/bin', '/opt/homebrew/bin', P.join(e.home, '.local', 'bin'), dir];
  const seen = new Set<string>([key(e.fs.realpath(target))]);
  const ownAlias = key(P.join(dir, legacyBinaryName(e)));
  const found: OtherCopy[] = [];
  for (const d of [...pathEntries(e), ...extra]) {
    for (const name of [binaryName(e), legacyBinaryName(e)]) {
      const file = P.join(d, name);
      if (!e.fs.exists(file)) continue;
      if (isWin(e) && key(file) === ownAlias) continue;   // the c4pm copy this installer keeps beside c4mp (a link elsewhere is skipped by realpath)
      const real = e.fs.realpath(file);
      if (!e.fs.isFile(real) || seen.has(key(real))) continue;
      seen.add(key(real));
      found.push({
        file,
        dir: d,
        real,
        version: readVersion(e, file),
        pathIndex: pathIndexOf(e, d),
        brew: /[\\/](Cellar|Caskroom)[\\/]/.test(real),
        writable: e.fs.canWrite(d),
      });
    }
  }
  return found;
}

/** True when this copy runs before the install folder (or the install folder is not on PATH at all). */
export function shadowsInstall(copy: OtherCopy, installIndex: number): boolean {
  return copy.pathIndex >= 0 && (installIndex < 0 || copy.pathIndex < installIndex);
}

/** `c4mp-<version>` beside the copy; `-2`, `-3` ... when that name is taken (on disk or in `taken`). */
export function backupPath(e: InstallEnv, copy: OtherCopy, taken: Set<string>): string {
  const P = pathLib(e.platform);
  const stem = P.basename(copy.file).replace(/\.exe$/i, '');   // c4mp or the old c4pm: the backup keeps the copy's own name
  const base = P.join(copy.dir, `${stem}-${copy.version.replace(/[^A-Za-z0-9._+-]/g, '_')}`);
  let n = 1;
  let to = base;
  while (taken.has(to) || e.fs.exists(to)) to = `${base}-${++n}`;
  taken.add(to);
  return to;
}

/** --old wins, then --yes (back up), then a question per copy; 'show' = no terminal: only print the commands. */
async function chooseOld(e: InstallEnv, copy: OtherCopy, opts: InstallOptions): Promise<OldAction | 'show'> {
  if (opts.old) return opts.old;
  if (opts.yes) return 'backup';
  if (!e.isTTY) return 'show';
  const a = (await e.prompt(`  ${copy.file} (${copy.version}): [r]emove / [b]ack up / [l]eave? [l] `)).trim().toLowerCase();
  return a.startsWith('r') ? 'remove' : a.startsWith('b') ? 'backup' : 'leave';
}

/**
 * Prints the other copies, decides what to do with each (asking when there is a terminal) and returns the actions.
 * Never sudo: a copy in a folder the user cannot write gets its sudo command printed; a Homebrew copy gets
 * `brew uninstall c4mp` printed and is never touched; on Windows nothing is renamed or removed.
 */
export async function planOldCopies(e: InstallEnv, copies: OtherCopy[], opts: InstallOptions): Promise<OldPlan> {
  const plan: OldPlan = { wouldLines: [], moves: [], left: [] };
  if (copies.length === 0) return plan;
  e.out(`Other c4mp copies found (${copies.length}):`);
  for (const c of copies) {
    e.out(`  ${c.file}  version ${c.version}${c.pathIndex < 0 ? '  (not on PATH)' : ''}${c.brew ? '  (Homebrew)' : ''}`);
  }
  const taken = new Set<string>();
  for (const c of copies) {
    if (isWin(e)) {
      plan.left.push(c);
      e.out(`  ${c.file}: remove or rename it by hand (c4mp does not change other copies on Windows)`);
      continue;
    }
    if (c.brew) {
      plan.left.push(c);
      e.out(`  ${c.file}: managed by Homebrew; run: brew uninstall ${pathLib(e.platform).basename(c.file)} (${CMD_NAME} never touches it)`);
      continue;
    }
    const choice = await chooseOld(e, c, opts);
    if (choice === 'leave') {
      plan.left.push(c);
      e.out(`  leaving ${c.file}`);
      continue;
    }
    const sudo = c.writable ? '' : 'sudo ';
    const from = shQuote(c.file);
    if (choice === 'show') {
      plan.left.push(c);
      e.out(`  to back up ${c.file}: ${sudo}mv ${from} ${shQuote(backupPath(e, c, taken))}`);
      e.out(`  to remove ${c.file}: ${sudo}rm ${from}`);
      continue;
    }
    const to = choice === 'backup' ? backupPath(e, c, taken) : undefined;
    if (!c.writable) {
      plan.left.push(c);
      e.out(`  ${c.file}: ${c.dir} is not writable for you; run it yourself: sudo ${to ? `mv ${from} ${shQuote(to)}` : `rm ${from}`}`);
      continue;
    }
    plan.moves.push({ file: c.file, to });
    plan.wouldLines.push(to ? `would back up ${c.file} to ${to}` : `would remove ${c.file}`);
  }
  return plan;
}

/** Which c4mp the shell runs first on `entries`, with its version; says so when none is found. */
export function nextC4pmLine(e: InstallEnv, entries: string[], target: string): string {
  const P = pathLib(e.platform);
  for (const d of entries) {
    const file = P.join(d, binaryName(e));
    if (!e.fs.exists(file) || !e.fs.isFile(e.fs.realpath(file))) continue;
    const isTarget = e.fs.realpath(file) === e.fs.realpath(target);
    const note = isTarget ? '' : '  (this is not the c4mp just installed)';
    return `The shell will run ${file} (c4mp ${isTarget ? e.version : readVersion(e, file)})${note}`;
  }
  return 'No c4mp is on PATH yet';
}
/** True when `dir` is one of the folders in PATH. */
export function dirOnPath(e: InstallEnv, dir: string): boolean {
  return pathIndexOf(e, dir) >= 0;
}

/** Shell profiles to edit. `create`: write it even when it does not exist yet. Empty when the shell is unknown. */
export function shellProfiles(e: InstallEnv): { file: string; create: boolean }[] {
  const P = pathLib(e.platform);
  const shell = P.basename(e.env.SHELL ?? '');
  if (shell === 'zsh') return [{ file: P.join(e.home, '.zshrc'), create: true }];
  if (shell === 'bash') {
    const list = [{ file: P.join(e.home, '.bashrc'), create: true }];
    const profile = P.join(e.home, '.bash_profile');
    if (e.platform === 'darwin' && e.fs.exists(profile)) list.push({ file: profile, create: false });
    return list;
  }
  return [];
}

export function pathBlock(dir: string): string {
  return `${HOOK_BEGIN}\nexport PATH="${dir.replace(/(["\\$`])/g, '\\$1')}:$PATH"\n${HOOK_END}`;
}

function blockRange(text: string): { start: number; end: number } | null {
  return findMarkedBlock(text);   // the c4mp marker, or the c4pm one an older install wrote
}

/** Adds the block, or replaces the existing one (never twice). */
export function upsertBlock(text: string, block: string): string {
  const base = removeBlock(text);
  const sep = base === '' ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return base + sep + block + '\n';
}

/** Removes the block when it exists (and, if `mustContain` is given, mentions it). */
export function removeBlock(text: string, mustContain?: string): string {
  const r = blockRange(text);
  if (!r || (mustContain !== undefined && !text.slice(r.start, r.end).includes(mustContain))) return text;
  let end = r.end;
  if (text[end] === '\n') end++;
  let start = r.start;
  if (start >= 2 && text[start - 1] === '\n' && text[start - 2] === '\n') start--;
  return text.slice(0, start) + text.slice(end);
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function psAddPath(dir: string): string {
  return (
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); ` +
    `if (($p -split ';') -notcontains ${psQuote(dir)}) { ` +
    `[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + ${psQuote(dir)}).TrimStart(';'), 'User') }`
  );
}

function psRemovePath(dir: string): string {
  return (
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); ` +
    `[Environment]::SetEnvironmentVariable('Path', (($p -split ';' | Where-Object { $_ -and $_ -ne ${psQuote(dir)} }) -join ';'), 'User')`
  );
}

const hasPowershell = (e: InstallEnv): boolean =>
  e.run('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']).status === 0;

/** Asks once when there is a terminal; 'refused' (with a message) without a terminal unless --yes. */
async function consent(e: InstallEnv, yes: boolean | undefined, question: string): Promise<boolean | 'refused'> {
  if (yes) return true;
  if (!e.isTTY) {
    e.err('c4mp: this changes files, but there is no terminal to ask. Run it again in a terminal or add --yes.');
    return 'refused';
  }
  return e.ask(question);
}

const NOT_BINARY = 'install works from the single-file binary; from source use npm link';

interface ProfileJob {
  file: string;
  before: string;
  after: string;
}

/** Returns the exit code. */
export async function runInstall(e: InstallEnv, opts: InstallOptions): Promise<number> {
  if (!isCompiledBinary(e.execPath, e.scriptPath)) {
    e.err(NOT_BINARY);
    return 1;
  }
  if (opts.old !== undefined && !OLD_ACTIONS.includes(opts.old)) {
    e.err(`${CMD_NAME}: --old takes ${OLD_ACTIONS.join(', ')} (got ${opts.old})`);
    return 1;
  }
  const P = pathLib(e.platform);
  const dir = resolveDir(e, opts);
  const target = P.join(dir, binaryName(e));
  const alias = P.join(dir, legacyBinaryName(e));
  const exists = e.fs.exists(target);
  const oldVersion = exists ? e.run(target, ['--version']).stdout.trim() || 'unknown' : null;
  const same = exists && oldVersion === e.version;

  if (same) e.out(`Already installed: same version (${CMD_NAME} ${e.version}) at ${target}`);
  else if (exists) {
    e.out(`Existing ${CMD_NAME} version: ${oldVersion}`);
    e.out(`Existing ${CMD_NAME} location: ${target}`);
    e.out(`This binary version: ${e.version}`);
  }
  // Other copies (also on a same-version run): a copy earlier on PATH hides the one installed here.
  const old = await planOldCopies(e, findOtherCopies(e, dir, target), opts);
  const dirIndex = pathIndexOf(e, dir);
  const shadowed = old.left.some(c => shadowsInstall(c, dirIndex));
  // The c4pm alias beside c4mp: made on every install, kept when already right, never over an older copy that was left.
  const aliasLeft = old.left.some(c => c.file === alias);
  const aliasCurrent = !isWin(e) && exists && e.fs.isSymlink(alias) && e.fs.exists(alias) && e.fs.realpath(alias) === e.fs.realpath(target);
  const wantAlias = !aliasLeft && (!same || (isWin(e) ? !e.fs.exists(alias) : !aliasCurrent));

  // Plan: lines starting with 'would' are actions; the others are information.
  const lines: string[] = [];
  if (!same) {
    if (!e.fs.exists(dir)) lines.push(`would create ${dir}`);
    lines.push(`would copy ${e.execPath} to ${target}`);
    if (!isWin(e)) lines.push(`would set mode 755 on ${target}`);
    if (e.platform === 'darwin') lines.push('would remove the macOS quarantine attribute (xattr -d com.apple.quarantine)');
  }
  lines.push(...old.wouldLines);
  if (wantAlias) lines.push(isWin(e) ? `would copy ${target} to ${alias} (the ${LEGACY_CMD_NAME} alias)` : `would link ${alias} to ${CMD_NAME} (the ${LEGACY_CMD_NAME} alias)`);
  else if (aliasLeft) lines.push(`not making the ${LEGACY_CMD_NAME} alias: ${alias} is an older copy you left`);
  const wantPath = !opts.noPath && (dirIndex < 0 || (shadowed && !isWin(e)));
  const jobs: ProfileJob[] = [];
  let powershell = false;
  let blockInProfile = false;
  const notes: string[] = [];
  if (wantPath) {
    if (isWin(e)) {
      powershell = hasPowershell(e);
      if (powershell) lines.push(`would add ${dir} to the user PATH (PowerShell)`);
      else {
        notes.push(
          `${dir} is not on PATH and PowerShell was not found. Add it by hand: ` +
            `Environment Variables > Path (user) > New: ${dir}`,
        );
      }
    } else {
      const profiles = shellProfiles(e);
      if (profiles.length === 0) {
        notes.push(
          `${dir} is not on PATH and the shell (${e.env.SHELL ?? 'unknown'}) is not zsh or bash. ` +
            `Add this line at the END of your shell profile:\n  export PATH="${dir}:$PATH"`,
        );
      }
      for (const p of profiles) {
        const had = e.fs.exists(p.file);
        if (!had && !p.create) continue;
        const before = had ? e.fs.readText(p.file) : '';
        const after = upsertBlock(before, pathBlock(dir));
        blockInProfile = true;
        if (after === before) {
          lines.push(`PATH block already in ${p.file}`);
          continue;
        }
        jobs.push({ file: p.file, before, after });
        lines.push(`would ${blockRange(before) ? 'update' : 'add'} the PATH block in ${p.file}`);
      }
    }
  }
  // PATH the next terminal will have: the block puts the install folder first; PowerShell appends it.
  const nextEntries = (): string[] =>
    blockInProfile ? [dir, ...pathEntries(e)] : powershell && dirIndex < 0 ? [...pathEntries(e), dir] : pathEntries(e);

  for (const l of lines) e.out(l);
  if (jobs.length > 0) e.out(`PATH line: export PATH="${dir}:$PATH"`);
  for (const n of notes) e.out(n);
  if (!lines.some(l => l.startsWith('would '))) {
    e.out(nextC4pmLine(e, nextEntries(), target));
    return 0;
  }

  const question = exists && !same ? `Replace existing ${CMD_NAME} ${oldVersion} with ${e.version}? [y/N] ` : 'Proceed? [y/N] ';
  const ok = await consent(e, opts.yes, question);
  if (ok === 'refused') return 1;
  if (!ok) {
    e.out('Nothing changed.');
    return 0;
  }

  try {
    if (!same) {
      if (!e.fs.exists(dir)) {
        e.fs.mkdirp(dir);
        e.out(`created ${dir}`);
      }
      // Copy beside the target, then rename, so a running copy of the old binary is not corrupted.
      const tmp = `${target}.new-${process.pid}`;
      try {
        e.fs.copyFile(e.execPath, tmp);
        if (!isWin(e)) e.fs.chmod(tmp, 0o755);
        e.fs.rename(tmp, target);
      } catch (err) {
        try {
          e.fs.unlink(tmp);
        } catch {
          // the temp file may not exist
        }
        throw err;
      }
      e.out(`copied ${e.execPath} to ${target}`);
      if (!isWin(e)) e.out(`set mode 755 on ${target}`);
      if (e.platform === 'darwin') {
        const r = e.run('xattr', ['-d', 'com.apple.quarantine', target]);
        e.out(r.status === 0 ? 'removed the macOS quarantine attribute' : 'no macOS quarantine attribute to remove');
      }
    }
    for (const m of old.moves) {
      if (m.to) {
        e.fs.rename(m.file, m.to);
        e.out(`backed up ${m.file} to ${m.to}`);
      } else {
        e.fs.unlink(m.file);
        e.out(`removed ${m.file}`);
      }
    }
    if (wantAlias) {
      makeAlias(e, target, alias);
      e.out(isWin(e) ? `copied ${target} to ${alias} (the ${LEGACY_CMD_NAME} alias)` : `linked ${alias} to ${CMD_NAME} (the ${LEGACY_CMD_NAME} alias)`);
    }
    for (const j of jobs) {
      e.fs.writeText(j.file, j.after);
      e.out(`${blockRange(j.before) ? 'updated' : 'added'} the PATH block in ${j.file}`);
    }
    if (powershell) {
      const r = e.run('powershell', ['-NoProfile', '-Command', psAddPath(dir)]);
      if (r.status !== 0) throw new Error('PowerShell could not change the user PATH');
      e.out(`added ${dir} to the user PATH (PowerShell)`);
    }
  } catch (err) {
    e.err(`${CMD_NAME} install failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (jobs.length > 0 || powershell) e.out('Open a new terminal so the PATH change takes effect.');
  e.out(`Installed ${CMD_NAME} ${e.version} at ${target}`);
  e.out(nextC4pmLine(e, nextEntries(), target));
  return 0;
}

/** Returns the exit code. */
export async function runUninstall(e: InstallEnv, opts: InstallOptions): Promise<number> {
  const P = pathLib(e.platform);
  const dir = resolveDir(e, opts);
  const target = P.join(dir, binaryName(e));
  const alias = P.join(dir, legacyBinaryName(e));
  const exists = e.fs.exists(target);
  if (exists && !e.fs.isFile(target)) {
    e.err(`${CMD_NAME}: ${target} is not a file; refusing to remove it`);
    return 1;
  }
  // The c4pm alias goes with c4mp (computed before anything is removed: it may be a link to the target).
  const aliasPresent = e.fs.exists(alias) || e.fs.isSymlink(alias);
  const aliasOurs = aliasPresent && isOwnAlias(e, alias, target);
  // A running exe cannot be deleted on Windows; elsewhere unlink works while it runs.
  const running = (f: string): boolean => isWin(e) && P.resolve(e.execPath).toLowerCase() === P.resolve(f).toLowerCase();
  const skipExe = exists && running(target);
  const skipAlias = aliasOurs && running(alias);

  const lines: string[] = [];
  if (!exists && !aliasOurs) lines.push(`no ${CMD_NAME} at ${target}`);
  if (exists) {
    if (skipExe) lines.push(`cannot remove ${target}: a running exe cannot be deleted on Windows; close ${CMD_NAME} and delete it by hand`);
    else lines.push(`would remove ${target}`);
  }
  if (aliasOurs) {
    if (skipAlias) lines.push(`cannot remove ${alias}: a running exe cannot be deleted on Windows; close ${LEGACY_CMD_NAME} and delete it by hand`);
    else lines.push(`would remove ${alias} (the ${LEGACY_CMD_NAME} alias)`);
  } else if (aliasPresent) lines.push(`leaving ${alias}: it is not the alias ${CMD_NAME} made`);
  const profiles: ProfileJob[] = [];
  if (!isWin(e)) {
    for (const f of ['.zshrc', '.bashrc', '.bash_profile']) {
      const file = P.join(e.home, f);
      if (!e.fs.exists(file)) continue;
      const before = e.fs.readText(file);
      const after = removeBlock(before, dir);
      if (after !== before) {
        profiles.push({ file, before, after });
        lines.push(`would remove the PATH block from ${file}`);
      }
    }
  }
  const psPath = isWin(e) && dirOnPath(e, dir) && hasPowershell(e);
  if (psPath) lines.push(`would remove ${dir} from the user PATH (PowerShell)`);

  for (const l of lines) e.out(l);
  if (!lines.some(l => l.startsWith('would '))) {
    e.out('Nothing to remove.');
    return skipExe || skipAlias ? 1 : 0;
  }
  const ok = await consent(e, opts.yes, 'Remove these? [y/N] ');
  if (ok === 'refused') return 1;
  if (!ok) {
    e.out('Nothing changed.');
    return 0;
  }
  try {
    if (aliasOurs && !skipAlias) {
      e.fs.unlink(alias);
      e.out(`removed ${alias}`);
    }
    if (exists && !skipExe) {
      e.fs.unlink(target);
      e.out(`removed ${target}`);
    }
    for (const p of profiles) {
      e.fs.writeText(p.file, p.after);
      e.out(`removed the PATH block from ${p.file}`);
    }
    if (psPath) {
      const r = e.run('powershell', ['-NoProfile', '-Command', psRemovePath(dir)]);
      if (r.status !== 0) throw new Error('PowerShell could not change the user PATH');
      e.out(`removed ${dir} from the user PATH (PowerShell)`);
    }
  } catch (err) {
    e.err(`${CMD_NAME} uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return 0;
}
