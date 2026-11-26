import * as fs from 'fs';

// P14-T22c: add one folder to the `ignore` list of a config file (.c4pm/config.json).
// Pure text work plus one file read; the caller writes `after` (only with --yes).

export interface AddIgnoreResult {
  status: 'added' | 'already' | 'refused';
  reason?: string;
  before: string;   // file text as read ('' when the file is missing)
  after: string;    // text to write (equals `before` unless status is 'added')
}

/** Same rule as config.ts `normalizeIgnore` (private there): strip a leading `./` and a trailing `/`. */
function normalizeFolder(entry: string): string {
  let n = entry.trim();
  if (n.startsWith('./')) n = n.slice(2);
  if (n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

export function addIgnoreFolder(configFile: string, folder: string): AddIgnoreResult {
  const norm = normalizeFolder(folder);
  const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const refuse = (reason: string): AddIgnoreResult => ({ status: 'refused', reason, before, after: before });

  if (norm === '' || norm === '.' || norm === '..' || norm.startsWith('../')) {
    return refuse(`would ignore the whole repo ('${folder}')`);
  }

  let obj: Record<string, unknown> = {};
  if (before.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch {
      return refuse('config.json is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return refuse('config.json is not a JSON object');
    }
    obj = parsed as Record<string, unknown>;
  }

  if (obj.ignore !== undefined && !Array.isArray(obj.ignore)) {
    return refuse('ignore in config.json is not an array');
  }
  const list = (obj.ignore as unknown[] | undefined) ?? [];
  if (list.some((e) => typeof e === 'string' && normalizeFolder(e) === norm)) {
    return { status: 'already', before, after: before };
  }
  obj.ignore = [...list, norm];
  return { status: 'added', before, after: JSON.stringify(obj, null, 2) + '\n' };
}
