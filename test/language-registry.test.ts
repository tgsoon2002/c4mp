import { defineLanguage } from '../src/languages/define';
import { buildRegistry, LANGUAGES, CPP_EXTENSIONS, LANGUAGE_IDS, LANGUAGE_IGNORE_DIRS, LANGUAGE_MANIFESTS, SOURCE_EXTENSIONS, TYPE_OUTLINE_EXTENSIONS } from '../src/languages/registry';
import { handlerFor } from '../src/languages';

// R3 (b188): a language is one descriptor; the registry derives everything else from the list.
describe('language registry', () => {
  // A fake language: one descriptor, reusing the python grammar so it can really parse.
  const fake = defineLanguage({
    id: 'fake',
    extensions: ['.fk'],
    grammar: () => require('tree-sitter-python'),
    manifests: { 'fake.toml': 'Fake (Toml)' },
    suffixManifests: { '.fkproj': 'Fake (Project)' },
    ignoreDirs: ['fake-out'],
    smoke: [{ pkg: 'tree-sitter-python', snippet: 'x = 1\n', want: ['module'] }],
    outline: (tree, file, code) => ({ file, lineCount: code.split('\n').length, parseError: tree.rootNode.hasError, elements: [] }),
    outlineTypes: false,
  });

  it('derives ids, handlers, extensions, manifests, ignores and smoke list from one descriptor', () => {
    const reg = buildRegistry([...LANGUAGES.descriptors, fake]);
    expect(reg.ids).toEqual([...LANGUAGES.ids, 'fake']);
    expect(reg.handlers.fake).toBe(fake);
    expect(reg.extensions.fake).toEqual(['.fk']);
    expect(reg.manifests.fake).toEqual({ files: { 'fake.toml': 'Fake (Toml)' }, suffixes: { '.fkproj': 'Fake (Project)' } });
    expect(reg.ignoreDirs.fake).toEqual(['fake-out']);
    expect(reg.smoke[reg.smoke.length - 1]).toMatchObject({ label: 'fake', pkg: 'tree-sitter-python' });
  });

  it('fills the defaults: grammar parse, no imports, a resolver that answers unresolved', () => {
    expect(handlerFor('a/b.fk', [fake])).toBe(fake);
    const tree = fake.parse('def f():\n  pass\n', 'a/b.fk');
    expect(tree.rootNode.hasError).toBe(false);
    expect(fake.imports(tree)).toEqual([]);
    expect(fake.createResolver('/repo', ['a/b.fk'])('a/b.fk', 'x')).toEqual({ status: 'unresolved' });
    expect('calls' in fake).toBe(false);
  });

  // b573: retryMacros is a second parse, only for a file with errors, kept only when it has fewer errors.
  const retrying = defineLanguage({
    id: 'fake-retry', extensions: ['.fkr'], grammar: () => require('tree-sitter-python'), smoke: [], outlineTypes: false,
    retryMacros: /\bMACRO\b|\bKEEP\b/g,
    outline: (tree, file, code) => ({ file, lineCount: code.split('\n').length, parseError: tree.rootNode.hasError, elements: [] }),
  });

  it('retryMacros: a file with errors is parsed again with the matches blanked, lines and columns kept', () => {
    const tree = retrying.parse('x = 1\nMACRO def f():\n  pass\n', 'a.fkr');
    expect(tree.rootNode.hasError).toBe(false);
    const fn = tree.rootNode.descendantsOfType('function_definition')[0];
    expect([fn.startPosition, fn.childForFieldName('name')!.text]).toEqual([{ row: 1, column: 6 }, 'f']);
  });

  it('retryMacros: a clean file is never blanked; a retry without fewer errors is not kept', () => {
    expect(retrying.parse('MACRO = 1\n', 'a.fkr').rootNode.text).toBe('MACRO = 1\n');
    const broken = 'def f(:\n  KEEP = 1\n';
    const tree = retrying.parse(broken, 'a.fkr');
    expect(tree.rootNode.hasError).toBe(true);
    expect(tree.rootNode.text).toContain('KEEP');
  });

  it('retryMacros and blankMacros need the grammar parse', () => {
    const own = { id: 'own', extensions: ['.own'], parse: fake.parse, smoke: [], outline: fake.outline, outlineTypes: false };
    expect(() => defineLanguage({ ...own, retryMacros: /X/g })).toThrow('language own: blankMacros and retryMacros need the grammar parse');
    expect(() => defineLanguage({ ...own, blankMacros: /X/g })).toThrow('language own: blankMacros and retryMacros need the grammar parse');
  });

  it('rejects a repeated id', () => {
    expect(() => buildRegistry([fake, fake])).toThrow('language fake listed twice');
  });

  it('keeps the constant names, now derived from the registry', () => {
    expect(LANGUAGE_IDS).toEqual(['typescript', 'python', 'rust', 'csharp', 'php', 'cpp', 'swift', 'files']);
    expect(SOURCE_EXTENSIONS).toEqual(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
    expect(CPP_EXTENSIONS).toEqual(['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h']);
    // b510: every language but Python lists types in its outline.
    expect(TYPE_OUTLINE_EXTENSIONS).toEqual(LANGUAGES.descriptors.filter((d) => d.id !== 'python').flatMap((d) => d.extensions));
    expect(LANGUAGE_IGNORE_DIRS).toEqual({ rust: ['target'], php: ['vendor'], csharp: ['bin', 'obj'], cpp: ['cmake-build-*'],
      swift: ['.build', 'DerivedData', 'Pods'] });
    expect(LANGUAGE_MANIFESTS).toEqual({
      php: { files: { 'composer.json': 'PHP (Composer)' } },
      csharp: { suffixes: { '.csproj': 'C# (.NET)' } },
      swift: { files: { 'Package.swift': 'Swift (SwiftPM)' } },
    });
    expect(LANGUAGES.smoke.map((s) => s.label)).toEqual(['typescript', 'tsx', 'python', 'rust', 'c-sharp', 'php', 'cpp', 'swift']);
  });
});
