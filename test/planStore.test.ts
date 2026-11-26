import * as path from 'path';
import { storeDescriptionOf, readPlanStore, readStore } from '../src/schema';
import type { PlanElement } from '../src/types';

// b275 part C: plan store element -> StoreDescription -> reader gateway.
const ROOT = path.join(__dirname, 'fixtures', 'schema-drizzle');
const FILES = ['db/columns.ts', 'db/schema/users.ts', 'db/schema/classes.ts', 'db/schema/index.ts', 'other/mysql.ts', 'other/edge.ts'];

const el = (over: Partial<PlanElement> = {}): PlanElement => ({
  id: 'app.api.main', kind: 'store', title: 'Main', description: null, technology: null, links: [], metadata: {},
  parent: 'app.api', source: { file: 'a.c4', line: 1 }, ...over,
});

describe('storeDescriptionOf', () => {
  it('maps technology, metadata.reader and metadata.source', () => {
    expect(storeDescriptionOf(el({ technology: 'PostgreSQL 16', metadata: { reader: 'drizzle', source: 'db' } })))
      .toEqual({ technology: 'PostgreSQL 16', reader: 'drizzle', source: 'db' });
  });
  it('absent technology and metadata give undefined fields', () => {
    expect(storeDescriptionOf(el())).toEqual({ technology: undefined, reader: undefined, source: undefined });
  });
  it.each(['record', 'field', 'container'])('throws on a %s', (kind) => {
    expect(() => storeDescriptionOf(el({ kind }))).toThrow(/not a store/);
  });
});

describe('readPlanStore', () => {
  it('equals readStore on the drizzle fixture', () => {
    const store = el({ technology: 'PostgreSQL 16', metadata: { source: 'db' } });
    const res = readPlanStore(ROOT, FILES, store);
    expect(res).toEqual(readStore(ROOT, FILES, { technology: 'PostgreSQL 16', source: 'db' }));
    expect(res.reader).toBe('drizzle');
  });
  it('lets readStore errors through (unknown reader id)', () => {
    expect(() => readPlanStore(ROOT, FILES, el({ metadata: { reader: 'nope' } }))).toThrow(/unknown reader 'nope'/);
  });
});
