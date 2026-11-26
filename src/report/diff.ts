import * as compare from '../compare/index';
import { formatGithubDiff } from './github';
import type { SnapshotDiff } from '../types';

/** The text formats of a snapshot diff. */
export type DiffFormat = 'text' | 'markdown' | 'github';

/** A snapshot diff as text: plain text, markdown, or GitHub annotations + markdown. Any other value gives plain text. */
export function formatDiff(diff: SnapshotDiff, format: DiffFormat): string {
  if (format === 'github') return formatGithubDiff(diff);
  if (format === 'markdown') return compare.formatMarkdown(diff);
  return compare.formatText(diff);
}

// b475 (ARR-CL-A1): the old library names (src/index.ts) for the diff text, kept as deprecated aliases.

/** @deprecated Use formatDiff(diff, 'text'). */
export const formatText: typeof compare.formatText = compare.formatText;

/** @deprecated Use formatDiff(diff, 'markdown'). */
export const formatMarkdown: typeof compare.formatMarkdown = compare.formatMarkdown;
