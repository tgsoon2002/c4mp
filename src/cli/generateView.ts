/**
 * b273 (D6): `c4mp plan generate --view storage`. Adds a store (with its records and fields) for every reader hit that no
 * plan store covers, from the code only. Goes through the plan write gate like `plan add`: dry run unless --yes, atomic,
 * rolled back on a problem. Never touches an existing store. `--view arch` (no --view) is the old generate in bin/cli.ts,
 * which writes at once; this file only decides whether a call is a view call and runs the io and storage ones.
 * b472 (row P2): the storage work is the Plan editing service's (src/services/planGenerate.ts generateStorageView).
 */
import { emitError, emitResult, cmdError, parseView, withQuietLogs } from './common';
import type { Opts, PlanEditDeps } from './common';
import { generateStorageView } from '../services/planGenerate';

export const NO_IO_GENERATE_MESSAGE = 'nothing to generate: no reader for io yet';

/** Options that only the view path has; any of them (or a --view other than arch) sends `plan generate` here. */
const VIEW_ONLY_OPTIONS = ['container', 'yes', 'force'];

/** True when this `plan generate` call is not the old arch generate. A bad --view counts (it is reported here). */
export const isViewGenerate = (opts: Opts): boolean =>
  (opts.view !== undefined && opts.view !== 'arch') || VIEW_ONLY_OPTIONS.some(k => opts[k] !== undefined);

/** Run a view call of `plan generate`; returns the exit code. */
export function runGenerateView(opts: Opts, deps: PlanEditDeps): number {
  const view = parseView(opts);
  if (typeof view !== 'string') return emitError(opts, 'generate', view);
  if (view !== 'storage') {
    const stray = VIEW_ONLY_OPTIONS.filter(k => opts[k] !== undefined).map(k => `--${k}`);
    if (stray.length > 0) {
      return emitError(opts, 'generate', cmdError('invalid', `${stray.join(', ')} only work with --view storage (plan generate without --view writes at once)`));
    }
    if (view === 'io') {
      console.log(NO_IO_GENERATE_MESSAGE);
      return 0;
    }
  }
  return emitResult(opts, withQuietLogs(() => generateStorageView(opts.repo as string, deps.buildCliConfig(opts), opts)));
}
