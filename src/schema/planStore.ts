import type { PlanElement } from '../types';
import type { ReaderRegistry } from './readers';
import { readStore } from './readers';
import type { StoreDescription, StoreReadResult } from './reader';

// P23 (b275 part C): the plan side of the reader gateway. A plan store element becomes the plain StoreDescription
// readStore wants. Every caller that reads the code behind a store (plan show, later unplanned, generate, the
// D4 check, the viewer) goes through readPlanStore, so the metadata keys are mapped in this one place.

/** technology, metadata.reader and metadata.source of a store element. Throws when el is not a store. */
export function storeDescriptionOf(el: PlanElement): StoreDescription {
  if (el.kind !== 'store') throw new Error(`${el.id} is a ${el.kind}, not a store`);
  return { technology: el.technology ?? undefined, reader: el.metadata.reader, source: el.metadata.source };
}

/** Read the code behind a plan store. Errors are readStore's (unknown reader, ambiguous, live reader, limits, reader failure). */
export const readPlanStore = (repoRoot: string, repoFiles: string[], el: PlanElement, registry?: ReaderRegistry): StoreReadResult =>
  readStore(repoRoot, repoFiles, storeDescriptionOf(el), registry);
