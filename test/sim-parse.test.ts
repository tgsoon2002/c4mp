import { normaliseView, parseSim, SIM_ID_RE } from '../src/sim/parse';
import { serializeSim } from '../src/sim/serialize';

type Obj = Record<string, unknown>;
const FILE = 's-1.json';
const flow = (steps: unknown[], top: Obj = {}): string => JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Buy', ...top, steps });
const journey = (stages: unknown[], top: Obj = {}): string => JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'journey', title: 'Trip', ...top, stages });
const step = (more: Obj = {}): Obj => ({ target: 'u-a', view: 'arch', ...more });
const messages = (text: string): string[] => parseSim(text, FILE).issues.map((i) => i.message);

describe('SIM_ID_RE and normaliseView', () => {
  it.each(['s-1', 's-10', 's-999'])('%s is an id', (id) => { expect(SIM_ID_RE.test(id)).toBe(true); });
  it.each(['s-0', 's-01', 's1', 'b1', 's-', 's-1a'])('%s is not', (id) => { expect(SIM_ID_RE.test(id)).toBe(false); });
  it.each([['arch', 'arch'], ['io', 'io'], ['storage', 'storage'], ['architecture', 'arch'], ['front', 'io'], ['data', 'storage'], ['Arch', null], ['toString', null], ['', null]])(
    '%s -> %s', (w, v) => { expect(normaliseView(w)).toBe(v); });
});

describe('parseSim: valid input', () => {
  it('a minimal flow: data, no issues, no notes; one target is a list in memory', () => {
    const r = parseSim(flow([step()]), FILE);
    expect(r.issues).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.data).toEqual({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Buy', steps: [{ target: ['u-a'], view: 'arch' }] });
  });

  it('a flow and a journey without steps/stages (drafting) parse; absent stays absent', () => {
    const f = parseSim(JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Draft' }), FILE);
    expect(f.issues).toEqual([]);
    expect(f.data!.steps).toBeUndefined();
    expect(parseSim(JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Draft', steps: [] }), FILE).data!.steps).toEqual([]);
  });

  it('person on a flow and on a journey (Q7); refs and words trimmed, free text kept as written', () => {
    const f = parseSim(flow([step({ target: [' u-a ', 'src/a.ts#f'], caption: '  Two  ' })], { person: ' customer ' }), FILE);
    expect(f.issues).toEqual([]);
    expect(f.data!.person).toBe('customer');
    expect(f.data!.steps![0]).toEqual({ target: ['u-a', 'src/a.ts#f'], view: 'arch', caption: '  Two  ' });
    expect(parseSim(journey([{ outside: 'Ad' }], { person: 'K' }), FILE).data!.person).toBe('K');
  });

  it('step call with every key (QF1) and every stage form with name, from, channel (QF2)', () => {
    const f = parseSim(flow([step({ call: { from: 'u-x', to: 'u-a', label: 'POST /a', reply: true } })]), FILE);
    expect(f.issues).toEqual([]);
    expect(f.data!.steps![0].call).toEqual({ from: 'u-x', to: 'u-a', label: 'POST /a', reply: true });
    const j = parseSim(journey([
      { name: 'Out', outside: 'Mail', from: 'Newsletter tool', channel: 'email', state: 's', caption: 'c', durationSec: 2, goal: 'g' },
      { name: 'Buy', flow: 's-2', goal: 'g' },
      { name: 'Here', target: 'u-a', view: 'io', call: { reply: false }, rows: { 'u-r': [{ a: 1 }] } },
    ]), FILE);
    expect(j.issues).toEqual([]);
    expect(j.data!.stages).toEqual([
      { name: 'Out', outside: 'Mail', from: 'Newsletter tool', channel: 'email', state: 's', caption: 'c', durationSec: 2, goal: 'g' },
      { name: 'Buy', flow: 's-2', goal: 'g' },
      { name: 'Here', target: ['u-a'], view: 'io', call: { reply: false }, rows: { 'u-r': [{ a: 1 }] } },
    ]);
  });

  it('old view words are read and written as the new words (Q1)', () => {
    const r = parseSim(flow([step({ view: 'architecture' }), step({ view: 'front' }), step({ view: 'data' })]), FILE);
    expect(r.issues).toEqual([]);
    expect(r.data!.steps!.map((s) => s.view)).toEqual(['arch', 'io', 'storage']);
    expect(serializeSim(r.data!)).not.toMatch(/architecture|front|"data"/);
  });
});

describe('parseSim: unknown keys are notes, kept and written back', () => {
  const text = JSON.stringify({
    schemaVersion: 1, id: 's-1', kind: 'flow', title: 'Buy',
    steps: [{ target: 'u-a', view: 'arch', call: { from: 'u-x', colour: 'red' }, constructor: 'kept', __proto__x: 1 }], future: { a: 1 },
  }, null, 2) + '\n';

  it('notes with the path; no issues; data has them in extra', () => {
    const r = parseSim(text, FILE);
    expect(r.issues).toEqual([]);
    expect(r.notes).toEqual([
      { file: FILE, message: "steps[0].call: unknown key 'colour' (kept as written)" },
      { file: FILE, message: "steps[0]: unknown key 'constructor' (kept as written)" },
      { file: FILE, message: "steps[0]: unknown key '__proto__x' (kept as written)" },
      { file: FILE, message: "unknown key 'future' (kept as written)" },
    ]);
    expect(r.data!.extra).toEqual({ future: { a: 1 } });
    expect(r.data!.steps![0].call!.extra).toEqual({ colour: 'red' });
  });

  it('round trip is byte-equal (unknown keys after the known ones, a key named constructor survives)', () => {
    expect(serializeSim(parseSim(text, FILE).data!)).toBe(text);
  });

  it('a key named __proto__ stays an own key and round-trips', () => {
    const t = '{\n  "schemaVersion": 1,\n  "id": "s-1",\n  "kind": "flow",\n  "title": "Buy",\n  "__proto__": {\n    "x": 1\n  }\n}\n';
    const r = parseSim(t, FILE);
    expect(Object.prototype.hasOwnProperty.call(r.data!.extra, '__proto__')).toBe(true);
    expect(serializeSim(r.data!)).toBe(t);
  });
});

describe('parseSim: issues -> data null, exact message', () => {
  const cases: [string, string, string][] = [
    ['not an object', '[1]', 'must be a JSON object {"schemaVersion": 1, "id": "s-<N>", "kind": "flow" | "journey", "title": "..."}'],
    ['schemaVersion 2', JSON.stringify({ schemaVersion: 2, id: 's-1', kind: 'flow', title: 'T' }), 'schemaVersion: must be 1 (found 2)'],
    ['id/file mismatch', flow([], { id: 's-2' }), "id: 's-2' does not match the file name 's-1.json' (the file must be <id>.json)"],
    ['bad id', flow([], { id: 'x-1' }), 'id: must match s-<N> (found "x-1")'],
    ['missing title', JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow' }), 'title: is required'],
    ['empty title', flow([], { title: ' ' }), 'title: must be a non-empty string (found " ")'],
    ['bad kind', flow([], { kind: 'story' }), 'kind: must be flow or journey (found "story")'],
    ['steps on a journey', JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'journey', title: 'T', steps: [] }), 'steps: not allowed on a journey'],
    ['stages on a flow', JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'T', stages: [] }), 'stages: not allowed on a flow'],
    ['steps not a list', JSON.stringify({ schemaVersion: 1, id: 's-1', kind: 'flow', title: 'T', steps: {} }), 'steps: must be a list (found {})'],
    ['step not an object', flow(['u-a']), 'steps[0]: a step must be an object'],
    ['missing target', flow([{ view: 'io' }]), 'steps[0].target: is required'],
    ['target empty list', flow([step({ target: [] })]), 'steps[0].target: must be a ref (c-item uid, plan fqn or path#name) or a non-empty list of refs (found [])'],
    ['target with a number', flow([step({ target: ['u-a', 3] })]), 'steps[0].target: must be a ref (c-item uid, plan fqn or path#name) or a non-empty list of refs (found ["u-a",3])'],
    ['missing view', flow([{ target: 'u-a' }]), 'steps[0].view: is required'],
    ['bad view', flow([step({ view: 'front-end' })]), 'steps[0].view: must be arch, io, storage (found "front-end")'],
    ['durationSec 0', flow([step({ durationSec: 0 })]), 'steps[0].durationSec: must be a number of seconds > 0 (found 0)'],
    ['durationSec text', flow([step({ durationSec: '4' })]), 'steps[0].durationSec: must be a number of seconds > 0 (found "4")'],
    ['state empty', flow([step({ state: '' })]), 'steps[0].state: must be a non-empty string (found "")'],
    ['rows not an object', flow([step({ rows: [] })]), 'steps[0].rows: must be an object { "<record uid>": [ {row}, ... ] } (found [])'],
    ['rows not a list of objects', flow([step({ rows: { 'u-r': [1] } })]), 'steps[0].rows.u-r: must be a list of row objects'],
    ['person not a string', flow([], { person: 7 }), 'person: must be a non-empty string (found 7)'],
    ['description empty', flow([], { description: '' }), 'description: must be a non-empty string (found "")'],
    // QF1: call
    ['call not an object', flow([step({ call: 'u-x' })]), 'steps[0].call: must be an object { from?, to?, label?, reply? } (found "u-x")'],
    ['call is a list', flow([step({ call: [] })]), 'steps[0].call: must be an object { from?, to?, label?, reply? } (found [])'],
    ['call.from empty', flow([step({ call: { from: '' } })]), 'steps[0].call.from: must be a non-empty string (found "")'],
    ['call.to a number', flow([step({ call: { to: 5 } })]), 'steps[0].call.to: must be a non-empty string (found 5)'],
    ['call.label empty', flow([step({ call: { label: ' ' } })]), 'steps[0].call.label: must be a non-empty string (found " ")'],
    ['call.reply text', flow([step({ call: { reply: 'yes' } })]), 'steps[0].call.reply: must be true or false (found "yes")'],
    // a stage-only key on a step
    ['from on a step', flow([step({ from: 'u-x' })]), 'steps[0].from: not allowed on a step'],
    ['name on a step', flow([step({ name: 'One' })]), 'steps[0].name: not allowed on a step'],
    // stages
    ['stage not an object', journey(['s-2']), 'stages[0]: a stage must be an object'],
    ['stage with no form', journey([{ goal: 'g' }]), 'stages[0]: a stage needs exactly one of flow, outside or target (found none)'],
    ['stage with two forms', journey([{ flow: 's-2', outside: 'x' }]), 'stages[0]: a stage needs exactly one of flow, outside or target (found flow, outside)'],
    ['flow stage bad id', journey([{ flow: 'b2' }]), 'stages[0].flow: must be an s-item id s-<N> (found "b2")'],
    ['outside empty', journey([{ outside: '' }]), 'stages[0].outside: must be a non-empty string (found "")'],
    ['inline step stage without view', journey([{ target: 'u-a' }]), 'stages[0].view: is required'],
    ['state on a flow stage', journey([{ flow: 's-2', state: 's' }]), 'stages[0].state: not allowed on a flow stage'],
    ['view on an outside stage', journey([{ outside: 'x', view: 'io' }]), 'stages[0].view: not allowed on an outside stage'],
    // QF2: name, from, channel
    ['stage name empty', journey([{ name: '', outside: 'x' }]), 'stages[0].name: must be a non-empty string (found "")'],
    ['stage name a number', journey([{ name: 2, flow: 's-2' }]), 'stages[0].name: must be a non-empty string (found 2)'],
    ['outside from a number', journey([{ outside: 'x', from: 3 }]), 'stages[0].from: must be a non-empty string (found 3)'],
    ['outside channel empty', journey([{ outside: 'x', channel: '' }]), 'stages[0].channel: must be a non-empty string (found "")'],
    ['from on a flow stage', journey([{ flow: 's-2', from: 'Shop' }]), 'stages[0].from: not allowed on a flow stage'],
    ['channel on a flow stage', journey([{ flow: 's-2', channel: 'email' }]), 'stages[0].channel: not allowed on a flow stage'],
    ['from on an inline step stage', journey([{ target: 'u-a', view: 'io', from: 'Shop' }]), 'stages[0].from: not allowed on an inline step stage'],
    ['channel on an inline step stage', journey([{ target: 'u-a', view: 'io', channel: 'phone' }]), 'stages[0].channel: not allowed on an inline step stage'],
  ];
  it.each(cases)('%s', (_name, text, message) => {
    const r = parseSim(text, FILE);
    expect(r.data).toBeNull();
    expect(r.issues).toEqual([{ file: FILE, message }]);
  });

  it('bad JSON: one issue, never throws', () => {
    const r = parseSim('{ nope', FILE);
    expect(r.data).toBeNull();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(/^not valid JSON \(/);
  });

  it('every problem of a file is reported, not only the first', () => {
    expect(messages(flow([step({ view: 'x', durationSec: -1 }), { target: 'u-b' }], { person: '' }))).toEqual([
      'person: must be a non-empty string (found "")',
      'steps[0].view: must be arch, io, storage (found "x")',
      'steps[0].durationSec: must be a number of seconds > 0 (found -1)',
      'steps[1].view: is required',
    ]);
  });
});
