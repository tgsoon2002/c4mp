import { storageWord, storageTechOf, STORAGE_WORDS } from '../src/storage/storageWords';
import { normalizeTech } from '../src/schema/storageTech';

// b210: the everyday word of store / record / field by storage technology.
describe('storageWord', () => {
  it.each([
    ['postgres', 'database', 'table', 'column'],
    ['mysql', 'database', 'table', 'column'],
    ['sqlite', 'database', 'table', 'column'],
    ['mongodb', 'database', 'collection', 'field'],
    ['json', 'file', 'record', 'key'],
    ['yaml', 'file', 'record', 'key'],
    ['csv', 'file', 'row', 'column'],
    ['fs', 'folder', 'file', 'field'],
    ['s3', 'bucket', 'object', 'field'],
    ['redis', 'instance', 'key pattern', 'field'],
  ])('%s -> %s / %s / %s', (tech, store, record, field) => {
    expect([storageWord(tech, 'store'), storageWord(tech, 'record'), storageWord(tech, 'field')]).toEqual([store, record, field]);
    expect(Object.keys(STORAGE_WORDS)).toContain(tech);
  });

  it('reads the first known word of a technology text, case-insensitive', () => {
    expect(storageTechOf('PostgreSQL 16 / postgres')).toBe('postgres');
    expect(storageWord('Amazon S3', 'record')).toBe('object');
  });

  it.each([
    ['PostgreSQL 16', 'postgres'], ['Postgres', 'postgres'], ['pg', 'postgres'], ['psql', 'postgres'], ['MongoDB Atlas', 'mongodb'],
    ['mongo', 'mongodb'], ['AWS S3', 's3'], ['Amazon S3', 's3'], ['SQLite3', 'sqlite'], ['MariaDB', 'mysql'], ['yml', 'yaml'],
    ['Redis', 'redis'], ['cassandra', null], ['', null],
  ])('normalizeTech(%j) -> %j', (text, key) => {
    expect(normalizeTech(text)).toBe(key);
  });

  it('unknown or missing technology falls back to the kind names', () => {
    for (const t of ['cassandra', '', null, undefined]) {
      expect([storageWord(t, 'store'), storageWord(t, 'record'), storageWord(t, 'field')]).toEqual(['store', 'record', 'field']);
    }
    expect(storageWord('toString', 'store')).toBe('store');
  });
});
