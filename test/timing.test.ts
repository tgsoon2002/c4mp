import { timed } from '../src/log';

// b231: C4PM_TIMING=1 prints one table to stderr at exit; unset = fn is called directly.

describe('timed', () => {
  let err: jest.SpyInstance;
  let out: jest.SpyInstance;
  let exitHandler: (() => void) | undefined;
  let onSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    onSpy = jest.spyOn(process, 'on').mockImplementation(((ev: string, fn: () => void) => { if (ev === 'exit') exitHandler = fn; return process; }) as never);
    exitHandler = undefined;
  });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.C4PM_TIMING; });

  const load = () => require('../src/log').timed as typeof timed;
  const tableText = () => err.mock.calls.map((c) => String(c[0])).join('');

  it('unset: returns the value, prints nothing, registers nothing', () => {
    delete process.env.C4PM_TIMING;
    expect(load()('x', () => 42)).toBe(42);
    expect(onSpy).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  it('on: one table on stderr at exit with label and seconds, stdout untouched', () => {
    process.env.C4PM_TIMING = '1';
    const t = load();
    expect(t('scan repo', () => 'v')).toBe('v');
    expect(t('write', () => 1, (n) => `${n} files`)).toBe(1);
    expect(err).not.toHaveBeenCalled();   // nothing until exit
    exitHandler!();
    expect(tableText()).toMatch(/scan repo\s+\d+\.\d\d s/);
    expect(tableText()).toMatch(/write\s+\d+\.\d\d s\s+1 files/);
    expect(out).not.toHaveBeenCalled();
  });

  it('async fn and nested labels', async () => {
    process.env.C4PM_TIMING = '1';
    const t = load();
    const v = await t('outer', async () => {
      const inner = t('inner', () => 7);
      await new Promise((r) => setTimeout(r, 5));
      return inner + 1;
    });
    expect(v).toBe(8);
    exitHandler!();
    const lines = tableText().split('\n');
    expect(lines.find((l) => l.startsWith('outer'))).toBeDefined();
    expect(lines.find((l) => l.startsWith('  inner'))).toBeDefined();
  });

  it('an error propagates untouched and is still recorded (sync and async)', async () => {
    process.env.C4PM_TIMING = '1';
    const t = load();
    const boom = new Error('boom');
    expect(() => t('bad sync', () => { throw boom; })).toThrow(boom);
    await expect(t('bad async', async () => { throw boom; })).rejects.toBe(boom);
    exitHandler!();
    expect(tableText()).toContain('bad sync');
    expect(tableText()).toContain('bad async');
  });
});
