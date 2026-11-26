import { log } from '../log';
import type { Plan } from '../types';
import { UID_KEY } from '../util/uid';
import { editMetadataBatch, type MetaEdit } from './editMeta';
import { isElementKind } from '../plan/kinds';

export interface BackfillResult {
  /** Only files that changed; key = element.source.file. `added` = fqns that got a uid. */
  files: Map<string, { text: string; added: string[] }>;
  skipped: { fqn: string; file: string; reason: string }[];
}

/**
 * Add `uid` to every element (kinds table) of `plan` that has none.
 * Pure: `texts` (key = element.source.file) are not modified; changed texts come back in `files`.
 * `mint` makes one new uid per call. Only adds a `uid` key to the metadata block, never touches other bytes.
 */
export function backfillUids(
  texts: Map<string, string>,
  plan: Plan,
  mint: () => string,
): BackfillResult {
  const files: BackfillResult['files'] = new Map();
  const skipped: BackfillResult['skipped'] = [];
  const seen = new Set<string>();
  const notFound = 'element not found or file has an unterminated string';

  // b721: one slot per element in plan order; the uid edits are grouped per file and applied in one pass each.
  const slots: { fqn: string; file: string; reason?: string; edit?: number }[] = [];
  const perFile = new Map<string, MetaEdit[]>();
  for (const el of plan.elements) {
    if (!isElementKind(el.kind) || el.metadata[UID_KEY] !== undefined) continue;
    const file = el.source.file;
    if (seen.has(el.id)) {
      slots.push({ fqn: el.id, file, reason: 'duplicate fqn' });
      continue;
    }
    seen.add(el.id);
    if (texts.get(file) === undefined) {
      slots.push({ fqn: el.id, file, reason: notFound });
      continue;
    }
    const edits = perFile.get(file) ?? [];
    perFile.set(file, edits);
    slots.push({ fqn: el.id, file, edit: edits.length });
    edits.push({ fqn: el.id, key: UID_KEY, value: mint() });
  }

  const done = new Map<string, { text: string; results: boolean[] }>();
  for (const [file, edits] of perFile) {
    const r = editMetadataBatch(texts.get(file)!, edits);
    const bad = r.errors.find(e => e !== null);
    if (bad) throw new Error(bad); // as setElementMetadata threw: a minted uid with a line break
    done.set(file, r);
  }
  for (const s of slots) {
    const r = s.edit === undefined ? undefined : done.get(s.file);
    if (!r || !r.results[s.edit!]) {
      skipped.push({ fqn: s.fqn, file: s.file, reason: s.reason ?? notFound });
      continue;
    }
    const entry = files.get(s.file) ?? { text: r.text, added: [] };
    entry.added.push(s.fqn);
    files.set(s.file, entry);
  }
  log('ids', 'backfillUids', { files: files.size, skipped: skipped.length });
  return { files, skipped };
}
