import * as path from 'path';
import { parsePlanTexts } from '../../src/plan/parser';
import { buildStorageState } from '../../src/storage/storageState';
import { listStoreFiles } from '../../src/schema/storeScan';
import { buildStorageView } from '../../src/view/storageModel';
import { loadSample } from './nav-view';
import type { ViewModel, ViewNode } from '../../src/types';

// STOR-6a (b339): storage-view data for the renderer tests. The page does not carry C4PM_DATA.storageView yet (STOR-5w, b609), so
// the tests build it with buildStorageView (STOR-5) on the Drizzle reader fixture and put it into the sample ViewModel themselves.

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'schema-drizzle');

/** One container 'Api' with one postgres store 'Main DB' (reader drizzle, source db/schema) that plans the record 'classes' only. */
const PLAN = [
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' {",
  "      db = store 'Main DB' {",
  "        technology 'postgres'",
  "        metadata { reader 'drizzle' source 'db/schema' }",
  "        classes = record 'classes'",
  "        ghost = record 'ghost' {",
  "          owner = field 'owner' { metadata { type 'uuid' } }",
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

/** The storage-view tree of the Drizzle fixture (fresh object each call); `planText` (STOR-6b) = another plan over the same fixture. */
export function drizzleStorageView(planText: string = PLAN): { root: ViewNode; edges: NonNullable<ViewModel['storageView']>['edges'] } {
  const plan = parsePlanTexts(FIXTURE, new Map([['a.c4', planText]]));
  const view = buildStorageView(plan, buildStorageState(plan, { repoRoot: FIXTURE, files: listStoreFiles(FIXTURE, { ignore: [], languages: ['typescript'] }) }));
  if (!view) throw new Error('drizzleStorageView: the plan has no store');
  return view;
}

/** The sample ViewModel with `storageView` (default: the Drizzle fixture's; null: none). */
export function storageModel(view: ViewModel['storageView'] | null = drizzleStorageView()): ViewModel {
  const m = loadSample();
  if (view) m.storageView = view;
  else delete m.storageView;
  return m;
}

export const CLASSES = 'app.api.db.classes';
export const ENROLLMENTS = 'db/schema/enrollment.ts#enrollments';
export const CLASS_ID = `${ENROLLMENTS}.class_id`;
export const CLASSES_ID = 'db/schema/classes.ts#classes.id';
