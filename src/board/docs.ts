import type { BoardDoc } from '../types';

/**
 * Structure rule for one `docs` entry, shared by checkBoard and the CLI (`--doc`): exactly one of `path` or `url`;
 * a path is repo-relative (not absolute, no `..` part, no backslash); a url is http(s). Returns the problem as text, or null.
 */
export function boardDocProblem(doc: BoardDoc): string | null {
  const hasPath = doc.path !== undefined;
  const hasUrl = doc.url !== undefined;
  if (hasPath === hasUrl) return 'needs exactly one of path or url';
  if (hasPath) {
    const p = doc.path as string;
    if (p.trim() === '') return 'path is empty';
    if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return `path '${p}' must be relative to the repo, not absolute`;
    if (p.includes('\\')) return `path '${p}' must use '/' separators`;
    if (p.split('/').includes('..')) return `path '${p}' must not contain '..'`;
    return null;
  }
  const u = doc.url as string;
  let ok = false;
  try { const proto = new URL(u).protocol; ok = proto === 'http:' || proto === 'https:'; } catch { ok = false; }
  return ok ? null : `url '${u}' must be an http(s) address`;
}
