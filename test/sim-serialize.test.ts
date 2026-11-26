import * as fs from 'fs';
import * as path from 'path';
import { parseSim } from '../src/sim/parse';
import { serializeSim } from '../src/sim/serialize';
import type { SimItem } from '../src/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'sim');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const keysOf = (o: unknown): string[] => Object.keys(o as object);

describe('serializeSim', () => {
  it.each(['s-1.json', 's-2.json'])('round trip of the plan example %s is byte-equal', (name) => {
    const r = parseSim(read(name), name);
    expect(r.issues).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(serializeSim(r.data!)).toBe(read(name));
  });

  it('the fixtures hold the 2026-11-15 keys: step call, stage names, outside from + channel, journey person', () => {
    const s1 = parseSim(read('s-1.json'), 's-1.json').data!;
    expect(s1.steps![1].call).toEqual({ from: 'u-add', to: 'shop.api.cart.addItem', label: 'POST /cart/items' });
    const s2 = parseSim(read('s-2.json'), 's-2.json').data!;
    expect(s2.person).toBe('customer');
    expect(s2.stages!.map((s) => s.name)).toEqual(['Discover', 'Sign in', 'Buy', 'Follow-up']);
    expect(s2.stages![3]).toMatchObject({ from: 'Newsletter tool', channel: 'email' });
  });

  it('key order: item, step, call (memory order does not matter)', () => {
    const item = {
      extra: { later: 1 }, steps: [{ extra: { z: 1 }, durationSec: 2, caption: 'c', rows: { r: [] }, state: 's', call: { reply: true, label: 'l', to: 't', from: 'f' }, view: 'io', target: ['a'] }],
      description: 'd', person: 'p', title: 'T', kind: 'flow', id: 's-1', schemaVersion: 1,
    } as unknown as SimItem;
    const out = JSON.parse(serializeSim(item));
    expect(keysOf(out)).toEqual(['schemaVersion', 'id', 'kind', 'title', 'person', 'description', 'steps', 'later']);
    expect(keysOf(out.steps[0])).toEqual(['target', 'view', 'call', 'state', 'rows', 'caption', 'durationSec', 'z']);
    expect(keysOf(out.steps[0].call)).toEqual(['from', 'to', 'label', 'reply']);
  });

  it('key order: each stage form', () => {
    const item = {
      schemaVersion: 1, id: 's-2', kind: 'journey', title: 'J', stages: [
        { durationSec: 1, caption: 'c', state: 's', channel: 'email', from: 'Tool', goal: 'g', outside: 'Mail', name: 'N' },
        { goal: 'g', flow: 's-1', name: 'N' },
        { goal: 'g', durationSec: 1, caption: 'c', rows: { r: [] }, state: 's', call: { to: 't' }, view: 'arch', target: ['a', 'b'], name: 'N' },
      ],
    } as unknown as SimItem;
    const out = JSON.parse(serializeSim(item));
    expect(keysOf(out.stages[0])).toEqual(['name', 'outside', 'goal', 'from', 'channel', 'state', 'caption', 'durationSec']);
    expect(keysOf(out.stages[1])).toEqual(['name', 'flow', 'goal']);
    expect(keysOf(out.stages[2])).toEqual(['name', 'target', 'goal', 'view', 'call', 'state', 'rows', 'caption', 'durationSec']);
  });

  it('one target is written as a string, several as a list', () => {
    const item: SimItem = { schemaVersion: 1, id: 's-1', kind: 'flow', title: 'T', steps: [{ target: ['a'], view: 'arch' }, { target: ['a', 'b'], view: 'io' }] };
    const out = JSON.parse(serializeSim(item));
    expect(out.steps[0].target).toBe('a');
    expect(out.steps[1].target).toEqual(['a', 'b']);
  });

  it('absent keys are not written; deterministic; 2-space JSON with one final newline', () => {
    const item: SimItem = { schemaVersion: 1, id: 's-1', kind: 'flow', title: 'T' };
    const text = serializeSim(item);
    expect(text).toBe('{\n  "schemaVersion": 1,\n  "id": "s-1",\n  "kind": "flow",\n  "title": "T"\n}\n');
    expect(serializeSim(item)).toBe(text);
  });

  it('a call with every key and unknown keys round-trips byte-equal', () => {
    const text = serializeSim({
      schemaVersion: 1, id: 's-1', kind: 'flow', title: 'T',
      steps: [{ target: ['a'], view: 'arch', call: { from: 'x', to: 'a', label: 'GET /a', reply: true, extra: { dashed: true } } }],
    });
    const r = parseSim(text, 's-1.json');
    expect(r.issues).toEqual([]);
    expect(serializeSim(r.data!)).toBe(text);
  });
});
