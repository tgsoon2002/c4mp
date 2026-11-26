import { scanExtensions } from '../src/pipeline';
import { DEFAULT_CONFIG } from '../src/config';
import { FILE_ONLY_EXTENSIONS } from '../src/constants';
import { SOURCE_EXTENSIONS, PYTHON_EXTENSIONS } from '../src/languages/registry';

const withLanguages = (languages: string[]) => ({ ...DEFAULT_CONFIG, languages });

describe('scanExtensions', () => {
  it("['typescript'] gives only the TypeScript handler extensions", () => {
    expect(scanExtensions(withLanguages(['typescript']))).toEqual([...SOURCE_EXTENSIONS]);
  });

  it("['typescript','python'] adds the Python extensions", () => {
    expect(scanExtensions(withLanguages(['typescript', 'python']))).toEqual([
      ...SOURCE_EXTENSIONS,
      ...PYTHON_EXTENSIONS,
    ]);
  });

  it("['typescript','files'] adds the file-only extensions", () => {
    expect(scanExtensions(withLanguages(['typescript', 'files']))).toEqual([
      ...SOURCE_EXTENSIONS,
      ...FILE_ONLY_EXTENSIONS,
    ]);
  });
});
