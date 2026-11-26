import { Command } from 'commander';
import { KIND_TABLE, viewOfKind, kindsOfView } from '../src/plan/kinds';
import type { ViewName } from '../src/plan/kinds';
import { addViewOption, parseView, VIEW_NAMES } from '../src/cli/common';

// b273: the three views (kinds.ts) and the shared --view option (cli/common.ts).
const elementKinds = Object.keys(KIND_TABLE).filter(k => KIND_TABLE[k].element);

describe('views of kinds', () => {
  it('every element kind belongs to exactly one view, and kindsOfView partitions them', () => {
    const lists = VIEW_NAMES.map(v => kindsOfView(v));
    expect(lists.flat().sort()).toEqual([...elementKinds].sort());
    for (const k of elementKinds) expect(VIEW_NAMES.filter(v => kindsOfView(v).includes(k))).toEqual([viewOfKind(k)]);
  });
  it.each<[string, ViewName]>([['container', 'arch'], ['person', 'arch'], ['screen', 'io'], ['flow', 'io'], ['store', 'storage'], ['field', 'storage'], ['function', 'arch'], ['nonsense', 'arch']])(
    '%s -> %s', (kind, view) => { expect(viewOfKind(kind)).toBe(view); });
});

describe('--view option', () => {
  const parse = (...args: string[]) => {
    const cmd = addViewOption(new Command()).exitOverride();
    cmd.parse(['node', 'x', ...args]);
    return parseView(cmd.opts());
  };
  it('defaults to arch', () => { expect(parse()).toBe('arch'); });
  it.each(VIEW_NAMES)('accepts %s', (v) => { expect(parse('--view', v)).toBe(v); });
  it('a bad value is an invalid CmdError naming the three values', () => {
    expect(parse('--view', 'frontend')).toMatchObject({ code: 'invalid', message: expect.stringContaining('arch, io, storage') });
  });
});
