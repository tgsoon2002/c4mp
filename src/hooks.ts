import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CMD_NAME, HOOK_BEGIN, HOOK_END, LEGACY_CMD_NAME, findMarkedBlock } from './constants';
import { log } from './log';
import { gitBin } from './util/gitBin';

export interface HookBlockOpts {
  /** Scan target relative to the git toplevel, posix separators; '' when the target is the toplevel. */
  targetRel: string;
  /** Explicit store, embedded only when the user chose one at install time. */
  store?: string;
  /** Absolute path of the compiled CLI (.js), used when neither `c4mp` nor `c4pm` is on PATH. */
  cliFallback?: string;
}

const FORBIDDEN = /["$`]/;

function assertSafe(field: string, value: string): void {
  if (FORBIDDEN.test(value)) {
    throw new Error(`Invalid ${field}: contains forbidden characters (quote, dollar, backtick). Value: ${value}`);
  }
}

/**
 * Generate the exact hook block text for a hook kind. Tiny on purpose: it reads HEAD (and ORIG_HEAD for
 * post-merge) in the foreground, finds the CLI and starts `c4mp hook <kind>` (else `c4pm`) in the background with those shas;
 * all logic lives in src/hookRun.ts. The shas are read here because node can take seconds to start, and by then
 * the next git command may have moved HEAD (Phase 29 smoke). POSIX sh only.
 * Every interpolated value is validated against quote, dollar and backtick (the $ variables are fixed text).
 */
export function hookBlock(kind: 'post-commit' | 'post-merge', opts: HookBlockOpts): string {
  if (kind !== 'post-commit' && kind !== 'post-merge') throw new Error(`Unknown hook kind: ${kind}`);
  const { targetRel, store, cliFallback } = opts;
  assertSafe('target path', targetRel);
  if (store !== undefined) assertSafe('store path', store);
  if (cliFallback !== undefined) assertSafe('cli path', cliFallback);
  log('hooks', 'hookBlock', { kind, opts });

  const targetLine = targetRel ? `TARGET="$ROOT/${targetRel}"` : 'TARGET="$ROOT"';
  const fallback = cliFallback
    ? `elif [ -f "${cliFallback}" ]; then C4="node ${cliFallback}"; `
    : '';
  const storeArg = store ? ` --store "${store}"` : '';
  const merge = kind === 'post-merge';
  const shaLines = 'HEAD_SHA="$(git rev-parse -q --verify HEAD 2>/dev/null)"' +
    (merge ? '\nORIG_SHA="$(git rev-parse -q --verify ORIG_HEAD 2>/dev/null)"' : '');
  const shaArgs = ' ${HEAD_SHA:+--head "$HEAD_SHA"}' + (merge ? ' ${ORIG_SHA:+--orig-head "$ORIG_SHA"}' : '');
  return `${HOOK_BEGIN}
# Added by \`${CMD_NAME} install-hooks\`. Remove with \`${CMD_NAME} uninstall-hooks\`. Never blocks git.
ROOT="$(git rev-parse --show-toplevel)"
${targetLine}
${shaLines}
if command -v ${CMD_NAME} >/dev/null 2>&1; then C4="${CMD_NAME}"; elif command -v ${LEGACY_CMD_NAME} >/dev/null 2>&1; then C4="${LEGACY_CMD_NAME}"; ${fallback}else C4=""; fi
[ -n "$C4" ] && ( $C4 hook ${kind} --repo "$TARGET"${storeArg}${shaArgs} >/dev/null 2>&1 & ) || true
${HOOK_END}`;
}

/**
 * Get the git hooks directory for a repository.
 * Throws if the repository is not a git repository.
 */
function getHooksDir(repoRoot: string): string {
  let hooksPath: string;
  try {
    hooksPath = execFileSync(gitBin(), ['-C', repoRoot, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }

  // Resolve relative paths against repoRoot
  if (!path.isAbsolute(hooksPath)) {
    hooksPath = path.join(repoRoot, hooksPath);
  }

  return hooksPath;
}

/**
 * Scan target relative to the git toplevel (posix separators; '' when it is the toplevel).
 * Throws "Not a git repository" like getHooksDir.
 */
function targetRelFor(target: string): string {
  let top: string;
  try {
    top = execFileSync(gitBin(), ['-C', target, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`Not a git repository: ${target}`);
  }
  // realpath both sides: git reports the resolved toplevel (e.g. /private/var on macOS)
  const rel = path.relative(fs.realpathSync(top), fs.realpathSync(path.resolve(target)));
  return rel.split(path.sep).join('/');
}

/**
 * Install git hooks (post-commit and post-merge) in the given repository.
 * Returns the paths of the hook files that were written.
 */
export function installHooks(
  repoRoot: string,
  opts: { store?: string; cliFallback?: string } = {},
): string[] {
  const hooksDir = getHooksDir(repoRoot);
  const targetRel = targetRelFor(repoRoot);
  log('hooks', 'installHooks', { repoRoot, targetRel, opts });
  const written: string[] = [];

  // Ensure hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  for (const kind of ['post-commit', 'post-merge'] as const) {
    const hookPath = path.join(hooksDir, kind);
    const block = hookBlock(kind, { targetRel, store: opts.store, cliFallback: opts.cliFallback });

    let content: string;
    if (!fs.existsSync(hookPath)) {
      // File missing: create with shebang
      content = `#!/bin/sh\n\n${block}\n`;
      log('hooks', 'install', { action: 'create', hookPath, kind });
    } else {
      // File exists
      const existing = fs.readFileSync(hookPath, 'utf8');

      const marked = findMarkedBlock(existing);
      if (marked) {
        // Has marker (current or the older c4pm one): replace the block
        content = existing.substring(0, marked.start) + block + existing.substring(marked.end);
        log('hooks', 'install', { action: 'replace', hookPath, kind });
      } else {
        // No marker: append block
        // Add newline before block if file doesn't end with one
        let prefix = existing;
        if (!prefix.endsWith('\n')) {
          prefix += '\n';
        }
        content = prefix + block + '\n';
        log('hooks', 'install', { action: 'append', hookPath, kind });
      }
    }

    // Write the file
    fs.writeFileSync(hookPath, content, 'utf8');

    // Make executable (chmod 755)
    fs.chmodSync(hookPath, 0o755);

    written.push(hookPath);
  }

  return written;
}

/**
 * Uninstall git hooks (post-commit and post-merge) from the given repository.
 * Returns the paths of hook files that were changed or removed.
 */
export function uninstallHooks(repoRoot: string): string[] {
  const hooksDir = getHooksDir(repoRoot);
  const changed: string[] = [];

  for (const kind of ['post-commit', 'post-merge'] as const) {
    const hookPath = path.join(hooksDir, kind);

    if (!fs.existsSync(hookPath)) {
      log('hooks', 'uninstall', { action: 'skip', hookPath, kind, reason: 'file-not-found' });
      continue;
    }

    const existing = fs.readFileSync(hookPath, 'utf8');

    const marked = findMarkedBlock(existing);
    if (!marked) {
      log('hooks', 'uninstall', { action: 'skip', hookPath, kind, reason: 'no-marker' });
      continue;
    }

    // Find the block and remove it with one preceding blank line
    const beginIdx = marked.start;
    const endIdx = marked.end;

    // Look for one preceding blank line
    let removeStart = beginIdx;
    if (beginIdx > 0 && existing[beginIdx - 1] === '\n') {
      // Check if there's a blank line before (which would be just \n\n)
      if (beginIdx > 1 && existing[beginIdx - 2] === '\n') {
        removeStart = beginIdx - 1;
      }
    }

    const before = existing.substring(0, removeStart);
    const after = existing.substring(endIdx);
    let newContent = before + after;

    // Check if what's left is only shebang/whitespace
    const trimmed = newContent.trim();
    if (trimmed === '' || trimmed === '#!/bin/sh') {
      // Delete the file
      fs.unlinkSync(hookPath);
      log('hooks', 'uninstall', { action: 'delete', hookPath, kind });
      changed.push(hookPath);
    } else {
      // Keep the file with the block removed
      fs.writeFileSync(hookPath, newContent, 'utf8');
      log('hooks', 'uninstall', { action: 'update', hookPath, kind });
      changed.push(hookPath);
    }
  }

  return changed;
}
