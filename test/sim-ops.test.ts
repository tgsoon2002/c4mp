import * as fs from 'fs';
import * as path from 'path';
import { addStage, addStep, expandSimApply, mintSimIds, moveStep, removeStage, removeStep, setStep, type SimApplyOk, type SimOpError, type SimOpOk, type SimOpResult } from '../src/sim/ops';
import { parseSim } from '../src/sim/parse';
import type { SimItem, SimStep } from '../src/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'sim');
const load = (id: string): SimItem => parseSim(fs.readFileSync(path.join(FIXTURES, `${id}.json`), 'utf8'), `${id}.json`).data as SimItem;
const S1 = load('s-1');   // flow, 9 steps
const S2 = load('s-2');   // journey, 4 stages
const flow = (id: string, targets: string[]): SimItem => ({ schemaVersion: 1, id, kind: 'flow', title: id, steps: targets.map((t) => ({ target: [t], view: 'arch' })) });
const F = flow('s-9', ['a', 'b', 'c']);

const okOf = (r: SimOpResult): SimOpOk => {
  if ('error' in r) throw new Error(`refused: ${r.error}\n${r.reasons.join('\n')}`);
  return r;
};
const errOf = (r: SimOpResult | SimApplyOk | SimOpError): SimOpError => {
  if (!('error' in r)) throw new Error('not refused');
  return r;
};
const targets = (item: SimItem): string[] => (item.steps ?? []).map((s) => s.target.join('+'));

describe('mintSimIds (Q8: max + 1 over the file names)', () => {
  it.each([
    [[], 2, ['s-1', 's-2']],
    [['s-1', 's-2', 's-7'], 1, ['s-8']],            // gaps are not reused
    [['s-3', 's-10', 's-2'], 2, ['s-11', 's-12']],  // by number, not by text
    [['s-4', 'draft', 's-04', 'S-9'], 1, ['s-5']],  // names that are not s-<N> do not count
    [['s-2'], 0, []],
  ])('%j, %i -> %j', (ids, count, want) => {
    expect(mintSimIds(ids, count)).toEqual(want);
  });
});

describe('step operations (flow, 1-based)', () => {
  it('addStep: at the end (null), first (1), in the middle; the input is never changed', () => {
    const step: SimStep = { target: ['x'], view: 'io', caption: 'X' };
    expect(targets(okOf(addStep(F, step, null)).item)).toEqual(['a', 'b', 'c', 'x']);
    expect(targets(okOf(addStep(F, step, 1)).item)).toEqual(['x', 'a', 'b', 'c']);
    const mid = okOf(addStep(F, step, 3));
    expect(targets(mid.item)).toEqual(['a', 'b', 'x', 'c']);
    expect(mid.lines).toEqual(['add step 3 to s-9: io  x']);
    expect(targets(F)).toEqual(['a', 'b', 'c']);
    const empty: SimItem = { schemaVersion: 1, id: 's-3', kind: 'flow', title: 'T' };
    expect(okOf(addStep(empty, step, null)).item.steps).toEqual([step]);
  });

  it('setStep: sets fields, `none` or null clears an optional one (call too), lines show before -> after', () => {
    const r = okOf(setStep(S1, 2, { caption: 'New caption', durationSec: 'none', call: { from: 'u-add', label: 'add', reply: true } }));
    const step = (r.item.steps as SimStep[])[1];
    expect(step.caption).toBe('New caption');
    expect(step.durationSec).toBeUndefined();
    expect(step.call).toEqual({ from: 'u-add', label: 'add', reply: true });
    expect(r.lines).toEqual([
      'set step 2 of s-1:',
      '  call: {"from":"u-add","to":"shop.api.cart.addItem","label":"POST /cart/items"} -> {"from":"u-add","label":"add","reply":true}',
      '  caption: The web app calls Cart.addItem (planned function, no uid). -> New caption',
      '  durationSec: 5 -> (none)',
    ]);
    const cleared = okOf(setStep(S1, 2, { call: null, state: 'NONE', target: ['t1', 't2'], view: 'storage' }));
    expect((cleared.item.steps as SimStep[])[1]).toEqual({ target: ['t1', 't2'], view: 'storage', caption: (S1.steps as SimStep[])[1].caption, durationSec: 5 });
    expect(okOf(setStep(S1, 1, { caption: (S1.steps as SimStep[])[0].caption })).lines).toEqual(['set step 1 of s-1:', '  nothing changes']);
  });

  it('removeStep and moveStep', () => {
    const removed = okOf(removeStep(F, 2));
    expect(targets(removed.item)).toEqual(['a', 'c']);
    expect(removed.lines).toEqual(['remove step 2 of s-9: arch  b']);
    expect(targets(okOf(moveStep(F, 1, 3)).item)).toEqual(['b', 'c', 'a']);
    expect(targets(okOf(moveStep(F, 3, 1)).item)).toEqual(['c', 'a', 'b']);
    expect(okOf(moveStep(F, 2, 2)).lines).toEqual(['move step 2 of s-9: already there, nothing changes']);
  });

  it.each<[string, () => SimOpResult, string, string[]]>([
    ['add at 0', () => addStep(F, { target: ['x'], view: 'io' }, 0), 'step 0 is out of range: s-9 has 3 steps, give 1..4', []],
    ['add past the end + 1', () => addStep(F, { target: ['x'], view: 'io' }, 5), 'step 5 is out of range: s-9 has 3 steps, give 1..4', []],
    ['set on a missing step', () => setStep(F, 4, { caption: 'x' }), 'step 4 is out of range: s-9 has 3 steps, give 1..3', []],
    ['remove 1.5', () => removeStep(F, 1.5), 'step 1.5 is out of range: s-9 has 3 steps, give 1..3', []],
    ['move to 4', () => moveStep(F, 1, 4), 'step 4 is out of range: s-9 has 3 steps, give 1..3', []],
    ['remove on an empty flow', () => removeStep(flow('s-3', []), 1), 'step 1 is out of range: s-3 has 0 steps', []],
    ['a step op on a journey', () => addStep(S2, { target: ['x'], view: 'io' }, null), 's-2 is a journey: it has stages, not steps (use the stage commands)', []],
    ['clear a required field', () => setStep(F, 1, { target: null as unknown as string[], view: 'none' as unknown as 'io' }), 'cannot set step 1 of s-9, nothing changed', ['target is required: it can be changed, not cleared', 'view is required: it can be changed, not cleared']],
    ['an unknown patch key', () => setStep(F, 1, { goal: 'x' } as never), "a step has no field 'goal' (fields: target, view, call, state, rows, caption, durationSec)", []],
    ['a value the reader refuses', () => addStep(F, { target: [], view: 'io', durationSec: 0 }, null), 'this would make s-9 invalid (2 problems), nothing changed',
      ['steps[3].target: must be a ref (c-item uid, plan fqn or path#name) or a non-empty list of refs (found [])', 'steps[3].durationSec: must be a number of seconds > 0 (found 0)']],
    ['a bad view word through set', () => setStep(F, 2, { view: 'front-end' as 'io' }), 'this would make s-9 invalid (1 problem), nothing changed', ['steps[1].view: must be arch, io, storage (found "front-end")']],
  ])('refused: %s', (_label, run, error, reasons) => {
    expect(errOf(run())).toEqual({ error, reasons });
  });
});

describe('stage operations (journey, 1-based)', () => {
  it('addStage keeps name, from, channel of an outside stage; flow and inline step stages too; removeStage', () => {
    const outside = { name: 'Reminder', outside: 'Gets a reminder', from: 'Shop', channel: 'email', goal: 'Come back' };
    const r = okOf(addStage(S2, outside, 2));
    expect((r.item.stages ?? [])[1]).toEqual(outside);
    expect(r.item.stages).toHaveLength(5);
    expect(r.lines).toEqual(['add stage 2 to s-2: Reminder (outside: Gets a reminder)']);
    expect(okOf(addStage(S2, { flow: 's-1' }, null)).lines).toEqual(['add stage 5 to s-2: flow s-1']);
    const inline = okOf(addStage(S2, { target: ['u-x'], view: 'io', name: 'Look', call: { label: 'opens' } }, 1));
    expect((inline.item.stages ?? [])[0]).toEqual({ name: 'Look', target: ['u-x'], view: 'io', call: { label: 'opens' } });
    const removed = okOf(removeStage(S2, 3));
    expect((removed.item.stages ?? []).map((s) => s.name)).toEqual(['Discover', 'Sign in', 'Follow-up']);
    expect(removed.lines).toEqual(['remove stage 3 of s-2: Buy (flow s-1)']);
  });

  it.each<[string, () => SimOpResult, string, string[]]>([
    ['a stage op on a flow', () => addStage(F, { outside: 'x' }, null), 's-9 is a flow: it has steps, not stages (use the step commands)', []],
    ['remove past the end', () => removeStage(S2, 5), 'stage 5 is out of range: s-2 has 4 stages, give 1..4', []],
    ['from on a flow stage', () => addStage(S2, { flow: 's-1', from: 'x' } as never, null), 'this would make s-2 invalid (1 problem), nothing changed', ['stages[4].from: not allowed on a flow stage']],
    ['two forms in one stage', () => addStage(S2, { flow: 's-1', outside: 'x' } as never, 1), 'this would make s-2 invalid (1 problem), nothing changed', ['stages[0]: a stage needs exactly one of flow, outside or target (found flow, outside)']],
  ])('refused: %s', (_label, run, error, reasons) => {
    expect(errOf(run())).toEqual({ error, reasons });
  });
});

describe('expandSimApply', () => {
  const EXISTING = [S1, S2];
  const counts: number[] = [];
  const newIds = (n: number): string[] => { counts.push(n); return mintSimIds(['s-1', 's-2', 's-5'], n); };
  beforeEach(() => { counts.length = 0; });
  const applyOk = (spec: unknown): SimApplyOk => {
    const r = expandSimApply(EXISTING, spec, newIds);
    if ('error' in r) throw new Error(`refused: ${r.error}\n${r.reasons.join('\n')}`);
    return r;
  };

  it('new s-items get ids in file order (newIds called once); flowRef names a new flow, forward refs allowed; an entry with id replaces', () => {
    const r = applyOk({ sims: [
      { ref: 'trip', kind: 'journey', title: 'Trip', person: 'customer', stages: [{ name: 'Pay', flowRef: 'pay', goal: 'Pay' }, { flow: 's-1' }, { outside: 'Mail', from: 'Shop', channel: 'email' }] },
      { id: 's-1', kind: 'flow', title: 'Buy (replaced)', steps: [{ target: 'u-add', view: 'front', call: { label: 'add' } }] },
      { ref: 'pay', kind: 'flow', title: 'Pay', steps: [] },
    ] });
    expect(counts).toEqual([2]);
    expect(r.minted).toEqual([{ index: 0, id: 's-6', ref: 'trip' }, { index: 2, id: 's-7', ref: 'pay' }]);
    expect(r.items.map((s) => s.id)).toEqual(['s-6', 's-1', 's-7']);
    expect(r.items[0].stages).toEqual([{ name: 'Pay', flow: 's-7', goal: 'Pay' }, { flow: 's-1' }, { outside: 'Mail', from: 'Shop', channel: 'email' }]);
    expect(r.items[0].schemaVersion).toBe(1);
    expect(r.items[1].steps).toEqual([{ target: ['u-add'], view: 'io', call: { label: 'add' } }]);
    expect(r.lines).toEqual([
      'write 3 s-items: 2 new, 1 replaced',
      '  s-6  new  journey  Trip  (3 stages)  (ref trip)',
      '  s-1  replace  flow  Buy (replaced)  (1 step)',
      '  s-7  new  flow  Pay  (0 steps)  (ref pay)',
    ]);
  });

  it('unknown keys inside an entry are kept (as the reader keeps them) and shown as notes; __proto__ stays data', () => {
    const r = applyOk(JSON.parse('{"sims": [{"kind": "flow", "title": "T", "later": 1, "__proto__": {"x": 1}, "steps": [{"target": "a", "view": "arch", "speed": 2}]}]}'));
    expect(r.items[0].extra).toEqual(JSON.parse('{"later": 1, "__proto__": {"x": 1}}'));
    expect(Object.getPrototypeOf(r.items[0].extra)).toBe(Object.prototype);
    expect((r.items[0].steps as SimStep[])[0].extra).toEqual({ speed: 2 });
    expect(r.lines.slice(2)).toEqual([
      "  note: sims[0]: unknown key 'later' (kept as written)",
      "  note: sims[0]: unknown key '__proto__' (kept as written)",
      "  note: sims[0]: steps[0]: unknown key 'speed' (kept as written)",
    ]);
  });

  it.each<[string, unknown, string, string[]]>([
    ['not an object', [], 'the file must be a JSON object {"sims": [ ... ]}', []],
    ['an unknown top key', { sims: [{ kind: 'flow', title: 'T' }], items: [] }, `unknown key 'items' (only "sims" is allowed)`, []],
    ['an empty list', { sims: [] }, '"sims" is empty: nothing to write', []],
  ])('refused: %s', (_label, spec, error, reasons) => {
    expect(expandSimApply(EXISTING, spec, newIds)).toEqual({ error, reasons });
    expect(counts).toEqual([]);
  });

  it('one bad entry refuses the whole file; every problem is listed with its entry', () => {
    const r = errOf(expandSimApply(EXISTING, { sims: [
      { kind: 'flow', title: 'Good' },
      'text',
      { id: 's-4', kind: 'flow', title: 'T' },
      { id: 's-1', ref: 'x', kind: 'flow', title: 'T' },
      { id: 's-1', kind: 'flow', title: 'T' },
      { id: 'flow-1', kind: 'flow', title: 'T' },
      { ref: 'a b', kind: 'flow', title: 'T' },
      { ref: 'j', kind: 'journey', title: 'J', stages: [{ flowRef: 'nope' }, { flowRef: 'j' }, { flow: 's-2' }, { flow: 's-40' }, { flow: 's-1', flowRef: 'j' }] },
      { ref: 'j', kind: 'flow', title: 'T' },
      { kind: 'flow', title: '', schemaVersion: 2 },
      { kind: 'flow', title: 'T', stages: [] },
    ] }, newIds));
    expect(r.error).toBe('14 problems in the file, nothing changed');
    expect(r.reasons).toEqual([
      'sims[1]: must be an object',
      "sims[2] (s-4): 's-4' is not an s-item (an entry with an id replaces an existing s-item; leave the id out for a new one)",
      "sims[3] (ref x): 'ref' names a new s-item; an entry with an id is named by its id",
      "sims[4] (s-1): 's-1' is replaced by an earlier entry too",
      "sims[5] (flow-1): 'id' must be an s-item id s-<N> (leave it out for a new s-item)",
      "sims[6] (ref a b): 'ref' must be letters, digits, '_' or '-'",
      "sims[8] (ref j): 'ref' 'j' is already used by an earlier entry",
      `sims[7] (ref j): stages[0].flowRef 'nope' matches no "ref" in the file`,
      "sims[7] (ref j): stages[4]: give 'flow' or 'flowRef', not both",
      "sims[7] (ref j): stages[1].flow: 's-8' is a journey, not a flow",   // its own ref: sims[7] is s-8
      "sims[7] (ref j): stages[2].flow: 's-2' is a journey, not a flow",
      "sims[7] (ref j): stages[3].flow: 's-40' is not an s-item (existing or in this file)",
      'sims[9]: schemaVersion: must be 1 (found 2)',
      'sims[10]: stages: not allowed on a flow',
    ]);
  });
});
