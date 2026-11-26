/**
 * C4PM Public API
 *
 * Exports the main functions for programmatic use of C4PM. b475 (ARR-CL-A1): the library API is the Services
 * (Project & scan, Query layer, Report, Plan editing) and Foundation types; it imports no Engine or Reader.
 * The old names still work as deprecated aliases (same function, same signature, same result); each one's JSDoc names
 * the function to call instead. installHooks / uninstallHooks stay with Dev tooling (src/hooks.ts), an entry point.
 */

// Project & scan: open a project, snapshot, history, diff, watch
export { openProject, setupProject, createConfig } from './scan/project';
export type { OpenProjectOptions, OpenedProject, StoreNeed } from './scan/project';
export { takeSnapshot, recordHistory, listSnapshots, diffSnapshots } from './scan/snapshots';
export type { TakenSnapshot, DiffSource } from './scan/snapshots';
export { startWatch } from './scan/watchSession';
export type { WatchCallbacks } from './scan/watchSession';

// Report: the diff text
export { formatDiff } from './report/diff';
export type { DiffFormat } from './report/diff';

// Query layer: check the plan against the code, the findings text
export { runCheck } from './query/check';
export type { CheckResult } from './query/check';
export { formatFindings } from './query/format';

// Plan editing: draft the plan, load it
export { generatePlan } from './services/planGenerate';
export type { GeneratePlanOptions, GeneratePlanResult } from './services/planGenerate';
export { loadPlanState } from './services/planState';
export type { PlanState } from './services/planState';

// Deprecated aliases (the old names), each provided by the Service that replaces it
export { runSnapshot, compareSnapshots, loadConfig, initConfig, DEFAULT_CONFIG, initProject, watchRepo } from './scan/libraryAliases';
export type { InitResult } from './scan/libraryAliases';
export { formatText, formatMarkdown } from './report/diff';
export { checkPlan } from './query/check';
export { generateC4, listC4Files, parsePlan } from './services/planGenerate';

// Dev tooling (an entry point, no Service home): git hooks
export { installHooks, uninstallHooks } from './hooks';

export type { Snapshot, SnapshotMeta, Container, Component, CodeElement, FileOutline, FileImports, SnapshotDiff, C4pmConfig, FailOn, Plan, PlanFinding } from './types';
