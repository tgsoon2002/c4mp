// S2 findings policy (Document/Roadmap/PHASE_23_24_PLAN.md section 3): pure presentation types.
// No I/O here. The ack file format and CLI are not decided yet (K2), so AckEntry is only the in-memory shape.
import type { PlanFinding, Severity } from '../types';

/** One acknowledgement: hides the findings of `rule` whose id equals `id`, or matches `glob` (ignoreMatch syntax). Exactly one of id/glob. */
export interface AckEntry { rule: string; id?: string; glob?: string; reason: string; added: string }

/** One shown line: one raw finding, or several findings of the same severity + rule in the same file. */
export interface FindingRow {
  severity: Severity;
  rule: string;
  /** the file (ids of the form `file#name`) or the single finding id */
  key: string;
  /** raw finding ids, in input order */
  ids: string[];
  count: number;
  /** the raw message when count is 1, else a summary */
  message: string;
  findings: PlanFinding[];
}

export interface HiddenGroup { severity: Severity; rule: string; count: number; files: number }

export interface PresentOptions {
  /** findings below this severity are hidden (counted in `hidden`); default info */
  minSeverity?: Severity;
  /** false hides info findings (counted in `hidden`); default true */
  showInfo?: boolean;
  /** false gives one row per finding; default true (merge `file#name` ids per file) */
  group?: boolean;
  acks?: AckEntry[];
}

export interface Presented {
  shown: FindingRow[];
  hidden: HiddenGroup[];
  /** findings hidden by an ack */
  acknowledged: number;
  /** acks that match no raw finding (computed before any filter) */
  staleAcks: AckEntry[];
  summary: string[];
}
