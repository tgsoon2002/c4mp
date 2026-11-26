import { checkLanguages } from '../src/services/languageCheck';
import { formatLanguageCheck } from '../src/cli/languagesCmd';
import { LANGUAGES } from '../src/languages/registry';

describe('checkLanguages (c4pm languages)', () => {
  const result = checkLanguages();

  it('checks every smoke entry of every language and all pass here', () => {
    expect(result.grammars.map((g) => g.label)).toEqual(LANGUAGES.smoke.map((s) => s.label));
    expect(result.grammars.filter((g) => !g.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.languages.map((l) => l.id)).toEqual(LANGUAGES.ids);
  });

  it('prints one PASS line per grammar and ALL PASS', () => {
    const lines = formatLanguageCheck(result);
    expect(lines.filter((l) => l.startsWith('PASS '))).toHaveLength(result.grammars.length);
    expect(lines[lines.length - 1]).toBe('ALL PASS');
  });

  it('prints FAIL with the reason and the count when a grammar failed', () => {
    const failed = { ...result, ok: false, grammars: [{ ...result.grammars[0], ok: false, error: 'boom' }] };
    expect(formatLanguageCheck(failed).slice(-2)).toEqual([`FAIL ${failed.grammars[0].label}: boom`, '1 language(s) FAILED. Send this output to K.']);
  });
});
