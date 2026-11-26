import { parseFk, formatFk, parseIndex, formatIndex, indexKey, checkKey } from '../src/storage/storageMeta';
import { parsePlanTexts } from '../src/plan/parser';
import { setElementMetadata } from '../src/c4/editMeta';
import { addElementText } from '../src/c4/editAdd';

// b210: fk / index value formats and dotted metadata keys.
describe('storageMeta', () => {
  it('fk roundtrips; malformed fk is null', () => {
    expect(parseFk('customers.id')).toEqual({ record: 'customers', field: 'id' });
    expect(formatFk(parseFk('customers.id')!)).toBe('customers.id');
    expect(parseFk('nodot')).toBeNull();
    expect(parseFk('.id')).toBeNull();
    expect(parseFk('rec.')).toBeNull();
  });

  it.each(['email', 'unique email', 'a,b', 'unique a,b where deleted_at is null', "status where status = 'open'"])(
    'index %j roundtrips', (text) => {
      expect(formatIndex(parseIndex(text)!)).toBe(text);
    });

  it('index parts; no column is null', () => {
    expect(parseIndex('unique a,b where x > 1')).toEqual({ unique: true, columns: ['a', 'b'], where: 'x > 1' });
    expect(parseIndex('unique  where x')).toBeNull();
    expect(indexKey('by_email')).toBe('index.by_email');
    expect(checkKey('positive')).toBe('check.positive');
  });

  it('dotted metadata key survives parse, set and add unchanged', () => {
    const text = "model {\n  db = system 'Db' {\n    t = record 'T' {\n      metadata {\n        index.by_email 'unique email'\n        check.positive 'qty > 0'\n      }\n    }\n  }\n}\n";
    const plan = parsePlanTexts('/x', new Map([['p.c4', text]]));
    expect(plan.issues).toEqual([]);
    expect(plan.elements.find(e => e.id === 'db.t')!.metadata).toEqual({ 'index.by_email': 'unique email', 'check.positive': 'qty > 0' });
    const set = setElementMetadata(text, 'db.t', 'index.by_name', 'name');
    expect(set.changed).toBe(true);
    const after = parsePlanTexts('/x', new Map([['p.c4', set.text]])).elements.find(e => e.id === 'db.t')!.metadata;
    expect(after).toEqual({ 'index.by_email': 'unique email', 'check.positive': 'qty > 0', 'index.by_name': 'name' });
    const added = addElementText(text, 'db', { id: 'u', kind: 'record', title: 'U', metadata: [['index.k', 'a,b']] });
    expect(parsePlanTexts('/x', new Map([['p.c4', added.text]])).elements.find(e => e.id === 'db.u')!.metadata).toEqual({ 'index.k': 'a,b' });
  });
});
