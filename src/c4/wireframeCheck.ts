/**
 * W7 (b303): the check rules on wireframe files (PHASE_20_WIREFRAMES.md section 6, C5; PHASE_20_23_PLAN.md A7, S10, Q1).
 * Pure: it reads the plan and one load of the files (wireframeFiles.ts loadWireframes, the same load the page uses) and
 * resolves refs with the one resolver (wireframeRefs.ts wireframeOf). Called by collectFindings only, never by checkPlan
 * (T3: the write gate sees checkPlan, so `plan add control` under a wireframed screen is never refused). Imports nothing
 * from src/view (T1). One finding per problem, stable messages.
 */
import type { Plan, PlanElement, PlanFinding } from '../types';
import { WIREFRAME_MAX_BYTES, type WireframeFile, type WireframeLoad } from './wireframeFiles';
import { wireframeOf } from './wireframeRefs';

/** The part of `fqn` below the screen (`shop.web.home.top_bar.search` -> `top_bar.search`). */
function fromScreen(screenFqn: string, fqn: string): string {
  return fqn.startsWith(screenFqn + '.') ? fqn.slice(screenFqn.length + 1) : fqn;
}

/** The fix for a file c4pm cannot use, by the loader's reason (wireframeFiles.ts loadOne / readGuarded). First match wins. */
const UNUSABLE_FIXES: ReadonlyArray<[RegExp, string]> = [
  [/symbolic link/, 'kept out for safety; write it as a plain file in io/'],
  [/over (the )?\d+ KB/, 'move shared layout to io/site.css'],
  [/not a regular file/, 'write it as a plain file in io/'],
  [/cannot be read/, 'make the file readable'],
  [/characters a wireframe file name cannot hold/, 'give the screen an id of letters, digits, _ and -'],
];
const UNUSABLE_FIX_OTHER = `write it as a plain file in io/, at most ${WIREFRAME_MAX_BYTES / 1024} KB`;

function unusableFix(reason: string): string {
  const hit = UNUSABLE_FIXES.find(([re]) => re.test(reason));
  return hit ? hit[1] : UNUSABLE_FIX_OTHER;
}

/** The rules on one usable file: out of date (missing parts, unknown and ambiguous refs), inline style, bad stylesheets. */
function fileFindings(plan: Plan, screen: PlanElement, file: WireframeFile): PlanFinding[] {
  const out: PlanFinding[] = [];
  const wf = wireframeOf(plan, screen.id, file);
  for (const fqn of wf.missing) {
    out.push({ severity: 'warning', rule: 'wireframe-out-of-date', id: screen.id, message: `no data-c4 for ${fromScreen(screen.id, fqn)}` });
  }
  for (const r of wf.refs) {
    if (r.problem === 'unknown') {
      out.push({ severity: 'warning', rule: 'wireframe-out-of-date', id: screen.id, message: `data-c4 "${r.ref}" names nothing under the screen` });
    } else if (r.problem === 'ambiguous') {
      const paths = (r.candidates ?? []).map(c => fromScreen(screen.id, c));
      out.push({
        severity: 'warning', rule: 'wireframe-out-of-date', id: screen.id,
        message: `data-c4 "${r.ref}" names ${paths.length} parts (${paths.join(', ')}); write the dotted path`,
      });
    }
  }
  const attrs = file.styleAttrs ?? 0;
  const blocks = file.styleBlocks ?? 0;
  if (attrs + blocks > 0) {
    out.push({
      severity: 'info', rule: 'wireframe-inline-style', id: file.file,
      message: `${file.file}: ${attrs} style attribute(s), ${blocks} <style> block(s); move them to classes in io/site.css`,
    });
  }
  for (const b of file.badLinks) {
    const tag = b.href === null ? '<link>' : `<link href="${b.href}">`;
    out.push({ severity: 'warning', rule: 'wireframe-bad-stylesheet', id: file.file, message: `${tag} dropped: ${b.reason}` });
  }
  return out;
}

/**
 * The wireframe findings of a plan from one load. `unsupported` (no plan folder, K1) gives none: the loader logged it.
 * wireframe-missing (info) fires only when io/ exists (K2); a file c4pm cannot use, or an io/ that is not a plain folder,
 * is wireframe-missing too, with the reason and the fix (K Q1). Order: screens in plan order, then orphans, then io.
 */
export function checkWireframes(plan: Plan, load: WireframeLoad): PlanFinding[] {
  if (load.status === 'unsupported') return [];
  const screens = plan.elements.filter(e => e.kind === 'screen');
  const out: PlanFinding[] = [];

  if (load.ioError === undefined) {
    for (const screen of screens) {
      const file = load.files.get(screen.id);
      if (file === undefined) {
        if (load.hasIo) out.push({ severity: 'info', rule: 'wireframe-missing', id: screen.id, message: `${screen.title}: no wireframe (io/${screen.id}.html)` });
      } else if (file.error !== undefined) {
        out.push({
          severity: 'info', rule: 'wireframe-missing', id: screen.id,
          message: `${screen.id}: io/${screen.id}.html skipped (${file.error}); ${unusableFix(file.error)}`,
        });
      } else {
        out.push(...fileFindings(plan, screen, file));
      }
    }
  }
  for (const orphan of load.orphans) {
    out.push({ severity: 'warning', rule: 'wireframe-orphan', id: orphan, message: `${orphan} names no screen of the plan (renamed or removed?)` });
  }
  if (load.ioError !== undefined) {
    for (const screen of screens) {
      out.push({
        severity: 'info', rule: 'wireframe-missing', id: screen.id,
        message: `${screen.id}: no wireframe read, ${load.io} skipped (${load.ioError}); make ${load.io} a plain folder in the plan folder`,
      });
    }
  }
  return out;
}
