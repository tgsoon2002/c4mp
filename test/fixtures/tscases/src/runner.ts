// A source file with its own `describe` and `it`: not a test file (no tests glob), so no test cases.
export function describe(name: string, fn: () => void): void { fn(); }
export function it(name: string, fn: () => void): void { fn(); }

describe('not a suite', () => {
  it('not a case', () => {});
});
