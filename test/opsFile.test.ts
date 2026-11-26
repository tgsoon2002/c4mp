import { readOpsText, checkOpKeys, OpShape } from '../src/util/opsFile';

const NAMES = ['add', 'set', 'link', 'unlink', 'relate', 'remove'];
const read = (t: string) => readOpsText(t, 'ops.json', NAMES);

describe('readOpsText', () => {
  const cases: Array<[string, string, string | RegExp]> = [
    ['bad json', '{', /^ops\.json is not valid JSON \(.+\)$/],
    ['wrong version', '{"schemaVersion":2,"ops":[]}', 'ops.json: schemaVersion must be 1'],
    ['empty ops', '{"schemaVersion":1,"ops":[]}', 'ops.json: ops must be a non-empty list'],
    ['extra top key', '{"schemaVersion":1,"ops":[{"op":"set"}],"x":1}', "ops.json: unknown key 'x' (keys: schemaVersion, ops)"],
    ['not an object', '{"schemaVersion":1,"ops":[1]}', 'ops[0] must be an object with a string "op"'],
    ['did you mean', '{"schemaVersion":1,"ops":[{"op":"lnk"}]}',
      "ops[0]: unknown op 'lnk', did you mean 'link'? Ops: add, set, link, unlink, relate, remove"],
    ['no suggestion', '{"schemaVersion":1,"ops":[{"op":"zzzzzz"}]}',
      "ops[0]: unknown op 'zzzzzz'. Ops: add, set, link, unlink, relate, remove"],
  ];
  it.each(cases)('%s', (_n, text, want) => {
    const r = read(text);
    expect(r.ok).toBe(false);
    if (!r.ok) typeof want === 'string' ? expect(r.message).toBe(want) : expect(r.message).toMatch(want);
  });

  it('reads a good file', () => {
    const r = read('{"schemaVersion":1,"ops":[{"op":"add","kind":"k","name":"n"},{"op":"set","target":"x","status":"done"}]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ops[1]).toEqual({ index: 1, op: 'set', fields: { target: 'x', status: 'done' } });
  });
});

describe('checkOpKeys', () => {
  const shape: OpShape = { required: ['kind', 'name'], strings: ['signature', 'title'], lists: ['meta'], flags: ['relations'] };
  const keys = 'kind, name, signature, title, meta, relations';
  const e = (fields: Record<string, unknown>) => ({ index: 0, op: 'add', fields });
  const base = { kind: 'k', name: 'n' };
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    ['fine', { ...base, signature: 's', meta: ['a=b'], relations: true }, null],
    ['did you mean', { ...base, sigature: 's' }, `unknown key 'sigature' for add, did you mean 'signature'? Keys: ${keys}`],
    ['no suggestion', { ...base, qqqqqq: 's' }, `unknown key 'qqqqqq' for add. Keys: ${keys}`],
    ['missing', { kind: 'k' }, "'name' is required for add"],
    ['list', { ...base, meta: 'a=b' }, "'meta' must be a list of strings"],
    ['list item', { ...base, meta: [1] }, "'meta' must be a list of strings"],
    ['flag', { ...base, relations: 'yes' }, "'relations' must be true or false"],
    ['newline', { ...base, title: 'a\nb' }, "'title' must be a non-empty string"],
    ['empty required', { ...base, name: '' }, "'name' must be a non-empty string"],
  ];
  it.each(cases)('%s', (_n, fields, want) => {
    expect(checkOpKeys(e(fields), shape)).toBe(want);
  });
});
