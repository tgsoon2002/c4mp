import { runChrome } from './helpers/chrome';
import { SPAWN_TIMEOUT_MS } from './helpers/runCli';

// execFileSync's timeout error is circular (err.error === err); runChrome must hide that.

const SLEEP = ['-e', 'setTimeout(()=>{},5000)'];

describe('runChrome', () => {
  it('timeout: plain, serializable Error naming the timeout; retried once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let err: any;
    try {
      runChrome(SLEEP, { bin: process.execPath, timeout: 100 });
    } catch (e) {
      err = e;
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/chrome failed: timeout \(ETIMEDOUT\)/);
    expect(err.message).toMatch(/2 attempts/);
    expect(err.cause).toBeUndefined();
    expect(err.error).toBeUndefined();
    expect(() => JSON.stringify(err)).not.toThrow();
    expect(() => structuredClone(err)).not.toThrow();
  });

  it('timeout without retry: single attempt, no warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => runChrome(SLEEP, { bin: process.execPath, timeout: 100, retryOnTimeout: false })).toThrow(/1 attempt\)/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('non-timeout failure: not retried, plain Error with exit status', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let err: any;
    try {
      // a long timeout: a node child held at start (macOS stall) must still end with exit 3, not ETIMEDOUT
      runChrome(['-e', 'process.exit(3)'], { bin: process.execPath, timeout: SPAWN_TIMEOUT_MS });
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/chrome failed: exit 3 after \d+ms \(1 attempt\)/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('success returns stdout', () => {
    expect(runChrome(['-e', 'process.stdout.write("ok")'], { bin: process.execPath })).toBe('ok');
  });
});
