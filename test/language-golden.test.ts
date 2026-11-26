// R0 (b185): every fixture's outline, imports and resolve results must match the committed golden byte for byte.
// A difference is a behaviour change: stop and report it, never regenerate the golden to make this pass.
// Regenerate only on purpose: npm run build && node scripts/language-golden.js
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const golden = require('../scripts/language-golden.js') as {
  fixtureGoldens(): { fixture: string; file: string; text: string }[];
};

describe('language golden net', () => {
  const goldens = golden.fixtureGoldens();

  it.each(goldens.map((g) => [g.fixture, g] as const))('%s matches its golden file', (_name, g) => {
    expect(fs.existsSync(g.file)).toBe(true);
    expect(g.text).toBe(fs.readFileSync(g.file, 'utf8'));
  });
});
