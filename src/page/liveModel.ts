import { openProject } from '../scan/project';
import { computeFingerprint } from '../scan/fingerprint';
import { startProjectWatch } from '../scan/watchSession';
import { readerExtensions } from '../schema/readers';
import { textStamp } from '../util/stamp';
import { log } from '../log';
import type { C4pmConfig } from '../types';
import { buildPageModel, pageData, type BuildViewOptions } from './html';

/**
 * Phase 30 SV5 (b792, b58 server side): the live model behind `c4pm serve`. It holds the page data of one repo, watches
 * everything a page build reads (startProjectWatch) and rebuilds after a change, in this process (Q8). Builds are
 * synchronous and never overlap. The model always keeps the last good data; a failed build keeps it and records the error.
 */

/** What a page build gives the live model (buildPageModel's result; a test passes its own builder). */
export type PageBuild = ReturnType<typeof buildPageModel>;

/** One build attempt, for the command's log and the timings: which files triggered it, how long it took, what it did. */
export interface LiveBuildReport {
  /** The changed files the watcher reported (empty for the first build). */
  files: string[];
  ms: number;
  /** new: a new generation; same: built, nothing the page sees changed; skipped: fingerprint unchanged, no build; failed. */
  outcome: 'new' | 'same' | 'skipped' | 'failed';
  generation: number;
  error: string | null;
}

export interface LiveModelOptions {
  from?: string | null;
  store?: string;
  sprint?: string | null;
  /** The watcher's debounce: changes closer than this make one rebuild. */
  debounceMs: number;
  /** After every build attempt, the first one included. */
  onBuild?: (report: LiveBuildReport) => void;
  /** Test seams, default the real ones: the page build, the project watcher, the input fingerprint. */
  build?: (opts: BuildViewOptions) => PageBuild;
  watch?: (repoRoot: string, config: C4pmConfig, opts: { debounceMs: number; onChange: (files: string[]) => void }) => () => void;
  fingerprint?: (repoRoot: string, config: C4pmConfig) => string;
}

/** One state of the model. Replaced (never changed in place) on every change, so a reader may keep it. */
export interface LiveState {
  /** 1 for the first build; one more each time the page data or a stamp changes. */
  generation: number;
  /** JSON.stringify(pageData(model)) of the last good build: the `data` of api/boot, sent as it is. */
  dataJson: string;
  /** textStamp of the plan texts and of the board text the data was built from (SV10, SV11: "changed since loaded"). */
  stamps: { plan: string; board: string };
  /** True from a change until its rebuild ends. */
  building: boolean;
  /** The message of the last build when it failed; null after a good one. The data is then the last good data. */
  error: string | null;
}

export interface LiveModel {
  current(): LiveState;
  /**
   * The long-poll of api/wait (SV6). Resolves at once when `since` is not the current generation (a newer one, or a page
   * from an earlier server run); else at the next change of the state (a rebuild starts, ends, fails or makes a new
   * generation) or after timeoutMs with the state as it is. stop() resolves every waiter.
   */
  waitFor(since: number, timeoutMs: number): Promise<LiveState>;
  /** Stops the watcher and any queued rebuild and answers every waiter. Nothing is left running. */
  stop(): void;
}

/** The page data and the stamps of one build. */
function builtState(built: PageBuild): Pick<LiveState, 'dataJson' | 'stamps'> {
  return {
    dataJson: JSON.stringify(pageData(built.model)),
    stamps: { plan: textStamp(built.inputs.planTexts), board: textStamp([['board', built.inputs.boardText]]) },
  };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Build the page data of repoRoot once (a config, plan-scan or `--from` error throws to the caller, nothing is left
 * running), then watch the project and rebuild after each debounced change:
 * - a change while a rebuild is queued or runs joins it or queues one more (never two builds at once);
 * - the input fingerprint (SV3) unchanged since the last build: no build;
 * - the page data and both stamps equal to the last: no new generation (a touched file);
 * - a build that throws keeps the last good data and sets `error`; the next good build clears it.
 * The watcher and the fingerprint use the config read at the start.
 */
export function createLiveModel(repoRoot: string, cli: Partial<C4pmConfig>, opts: LiveModelOptions): LiveModel {
  const build = opts.build ?? buildPageModel;
  const watch = opts.watch ?? startProjectWatch;
  const fingerprint = opts.fingerprint ?? ((root: string, config: C4pmConfig) => computeFingerprint(root, config, readerExtensions()));
  // b915: the store view uses (writeProjectView, viewExport.ts:33-38): the explicit store beats config.store, which beats
  // the anchor default; without both, none (buildPageModel would fall back to the legacy ~/.c4pm/store, html.ts:345).
  const opened = openProject(repoRoot, opts.store ? { ...cli, store: opts.store } : cli, { store: 'known' });
  const { config } = opened;
  const buildOpts: BuildViewOptions = { repo: repoRoot, config: cli, from: opts.from, store: opened.store ?? undefined, sprint: opts.sprint };

  const waiters = new Set<{ resolve: (s: LiveState) => void; timer: NodeJS.Timeout }>();
  let pending: Set<string> | null = null;   // changed files not built yet
  let timer: NodeJS.Timeout | null = null;  // the queued rebuild
  let stopped = false;

  const report = (files: string[], startedAt: number, outcome: LiveBuildReport['outcome']): void => {
    const r: LiveBuildReport = { files, ms: Date.now() - startedAt, outcome, generation: state.generation, error: state.error };
    log('live', 'build', r);
    opts.onBuild?.(r);
  };

  const settle = (w: { resolve: (s: LiveState) => void; timer: NodeJS.Timeout }): void => {
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(state);
  };

  const update = (patch: Partial<LiveState>): void => {
    state = { ...state, ...patch };
    for (const w of [...waiters]) settle(w);
  };

  const run = (): void => {
    timer = null;
    if (stopped || !pending) return;
    const files = [...pending].sort();
    pending = null;
    const startedAt = Date.now();
    let patch: Partial<LiveState> = {};
    let outcome: LiveBuildReport['outcome'];
    try {
      const now = fingerprint(repoRoot, config);
      if (now === fp) {
        outcome = 'skipped';
      } else {
        fp = now;
        const next = builtState(build(buildOpts));
        const same = next.dataJson === state.dataJson && next.stamps.plan === state.stamps.plan && next.stamps.board === state.stamps.board;
        outcome = same ? 'same' : 'new';
        patch = same ? { error: null } : { ...next, generation: state.generation + 1, error: null };
      }
    } catch (err) {
      outcome = 'failed';
      patch = { error: errorText(err) };
    }
    // a change that came while this build ran: one more build, still `building`
    if (pending && !stopped) {
      update(patch);
      timer = setTimeout(run, 0);
    } else {
      update({ ...patch, building: false });
    }
    report(files, startedAt, outcome);
  };

  const onChange = (files: string[]): void => {
    if (stopped) return;
    pending = pending ?? new Set();
    for (const f of files) pending.add(f);
    if (state.building) return;   // the queued or running rebuild takes these files too
    update({ building: true });   // waiters hear it first: the page can show "updating"
    timer = setTimeout(run, 0);
  };

  // The fingerprint before the first build and the watcher before it too: a change made while it runs is not lost.
  let fp = fingerprint(repoRoot, config);
  const stopWatch = watch(repoRoot, config, { debounceMs: opts.debounceMs, onChange });
  const startedAt = Date.now();
  let state: LiveState;
  try {
    state = { generation: 1, ...builtState(build(buildOpts)), building: false, error: null };
  } catch (err) {
    stopWatch();
    throw err;
  }
  report([], startedAt, 'new');

  return {
    current: () => state,
    waitFor(since: number, timeoutMs: number): Promise<LiveState> {
      if (stopped || since !== state.generation) return Promise.resolve(state);
      return new Promise((resolve) => {
        const w = { resolve, timer: setTimeout(() => settle(w), timeoutMs) };
        waiters.add(w);
      });
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopWatch();
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      update({ building: false });
    },
  };
}
