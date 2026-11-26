import { getHandlers, handlerExtensions, handlerFor, wantsFileOnly } from '../src/languages';
import { LANGUAGES, LANGUAGE_IDS, SOURCE_EXTENSIONS } from '../src/languages/registry';

describe('languages', () => {
  describe('getHandlers', () => {
    it('returns TypeScript handler', () => {
      const handlers = getHandlers(['typescript']);
      expect(handlers).toHaveLength(1);
      expect(handlers[0].id).toBe('typescript');
      expect(handlers[0].extensions).toContain('.ts');
      expect(handlers[0].extensions).toContain('.tsx');
      expect(handlers[0].extensions).toContain('.js');
      expect(handlers[0].extensions).toContain('.jsx');
    });

    it('returns Python handler', () => {
      const handlers = getHandlers(['python']);
      expect(handlers).toHaveLength(1);
      expect(handlers[0].id).toBe('python');
      expect(handlers[0].extensions).toEqual(['.py']);
    });

    it('returns multiple handlers', () => {
      const handlers = getHandlers(['typescript', 'python']);
      expect(handlers).toHaveLength(2);
      expect(handlers[0].id).toBe('typescript');
      expect(handlers[1].id).toBe('python');
    });

    it('ignores the files id when building handlers', () => {
      const handlers = getHandlers(['typescript', 'files']);
      expect(handlers).toHaveLength(1);
      expect(handlers[0].id).toBe('typescript');
      expect(getHandlers(['files'])).toEqual([]);
    });

    it('wantsFileOnly is true only when files is listed', () => {
      expect(wantsFileOnly(['typescript', 'files'])).toBe(true);
      expect(wantsFileOnly(['typescript'])).toBe(false);
    });

    it('throws on unknown language', () => {
      expect(() => getHandlers(['unknown'])).toThrow('Unknown language: unknown');
    });

    it('throws on mixed known and unknown', () => {
      expect(() => getHandlers(['typescript', 'fortran'])).toThrow('Unknown language: fortran');
    });
  });

  describe('handlerExtensions', () => {
    it.each<[string, string[], string[]]>([
      ['one language', ['python'], ['.py']],
      ['id order, each handler in its own order', ['python', 'typescript'], ['.py', ...SOURCE_EXTENSIONS]],
      ['the file-only id adds nothing', ['files', 'rust'], ['.rs']],
      ['a repeated id repeats its extensions', ['rust', 'rust'], ['.rs', '.rs']],
      ['every id: the registry extensions, flattened', LANGUAGE_IDS, Object.values(LANGUAGES.extensions).flat()],
    ])('%s', (_label, ids, expected) => {
      expect(handlerExtensions(ids)).toEqual(expected);
    });

    it('throws on an unknown language', () => {
      expect(() => handlerExtensions(['typescript', 'fortran'])).toThrow('Unknown language: fortran');
    });
  });

  describe('handlerFor', () => {
    it('returns TypeScript handler for .ts file', () => {
      const handlers = getHandlers(['typescript', 'python']);
      const handler = handlerFor('src/index.ts', handlers);
      expect(handler?.id).toBe('typescript');
    });

    it('returns TypeScript handler for .tsx file', () => {
      const handlers = getHandlers(['typescript', 'python']);
      const handler = handlerFor('src/App.tsx', handlers);
      expect(handler?.id).toBe('typescript');
    });

    it('returns TypeScript handler for .js file', () => {
      const handlers = getHandlers(['typescript', 'python']);
      const handler = handlerFor('src/utils.js', handlers);
      expect(handler?.id).toBe('typescript');
    });

    it('returns Python handler for .py file', () => {
      const handlers = getHandlers(['typescript', 'python']);
      const handler = handlerFor('src/main.py', handlers);
      expect(handler?.id).toBe('python');
    });

    it('returns null for unknown extension', () => {
      const handlers = getHandlers(['typescript']);
      const handler = handlerFor('src/data.json', handlers);
      expect(handler).toBeNull();
    });

    it('returns null when no handlers provided', () => {
      const handler = handlerFor('src/index.ts', []);
      expect(handler).toBeNull();
    });

    it('prioritizes first matching handler', () => {
      const handlers = getHandlers(['python', 'typescript']);
      const handler = handlerFor('src/file.ts', handlers);
      // Should be typescript since it has .ts extension
      expect(handler?.id).toBe('typescript');
    });
  });
});
