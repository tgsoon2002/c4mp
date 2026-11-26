/**
 * b456 (SR1): the service behind `c4pm plan upgrade`. Loads the plan, rewrites the old plan words of every plan file to
 * the current standard (c4/planUpgrade.ts upgradePlanText) and hands the new texts to the write gate (runWrite): dry run
 * prints the diff, --yes writes (atomic, with rollback), --force for plan files outside .c4pm/ and C4PM/, --check runs
 * the full check. Safe to repeat: a plan already in the current words is "no change".
 * L3: imports Plan editing (planState), the engine (L2) and nothing from src/cli/; bin/cli.ts hands it to the command.
 */
import type { C4pmConfig } from '../types';
import { upgradePlanText } from '../c4/planUpgrade';
import type { UpgradeChange } from '../c4/planUpgrade';
import { PLAN_STANDARD_VERSION } from '../plan/renames';
import { NO_PLAN_MESSAGE } from '../query/planShow';
import { cmdError, failedReport, loadPlanState, runWrite } from './planState';
import type { Opts, WriteReport } from './planState';

/** Rewrites of every plan file (files with none left out), in plan file order. */
export function planUpgradeChanges(texts: Map<string, string>): { file: string; text: string; changes: UpgradeChange[] }[] {
  const out: { file: string; text: string; changes: UpgradeChange[] }[] = [];
  for (const [file, text] of texts) {
    const r = upgradePlanText(text);
    if (r.changes.length > 0) out.push({ file, text: r.text, changes: r.changes });
  }
  return out;
}

/** `layer -> subregion x5, ...`: each distinct rewrite with its count, in first-seen order. */
const pairsOf = (upgraded: { changes: UpgradeChange[] }[]): string => {
  const counts = new Map<string, number>();
  for (const c of upgraded.flatMap((u) => u.changes)) counts.set(`${c.from} -> ${c.to}`, (counts.get(`${c.from} -> ${c.to}`) ?? 0) + 1);
  return [...counts].map(([pair, n]) => `${pair} x${n}`).join(', ');
};

/** `c4pm plan upgrade`: the gate's report (dry run unless opts.yes). */
export function planUpgradeService(repo: string, cli: Partial<C4pmConfig>, opts: Opts): WriteReport {
  const state = loadPlanState(repo, cli);
  if (!state) return failedReport('upgrade', opts, cmdError('no-plan', NO_PLAN_MESSAGE));
  const upgraded = planUpgradeChanges(state.texts);
  const newTexts = new Map(state.texts);
  for (const u of upgraded) newTexts.set(u.file, u.text);
  const words = upgraded.reduce((n, u) => n + u.changes.length, 0);
  const notes = words === 0
    ? [`nothing to upgrade: the plan already uses the words of plan standard ${PLAN_STANDARD_VERSION}`]
    : [`${words} old plan word${words === 1 ? '' : 's'} in ${upgraded.length} file${upgraded.length === 1 ? '' : 's'} (${pairsOf(upgraded)}), plan standard ${PLAN_STANDARD_VERSION}`];
  // The parser reads old and new words alike, so the re-parsed plan cannot show a leftover word; the postcondition is
  // that a second pass finds nothing (the rewrite is complete and idempotent).
  const post = (): string | null => (planUpgradeChanges(newTexts).length > 0 ? 'an old plan word is still in the plan after the upgrade' : null);
  return runWrite({ command: 'upgrade', opts, state, target: null, newTexts, notes, post, report: { headline: `upgrade to plan standard ${PLAN_STANDARD_VERSION}` } });
}
