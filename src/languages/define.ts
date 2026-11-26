import type Parser from 'tree-sitter';
import type { LanguageHandler } from '../types';
import { noResolver, parseErrorCount, parseWithGrammar } from './treesitter';

/** One grammar check of `c4pm languages`: parse `snippet` cleanly and find every `want` node type. */
export interface SmokeCheck {
  label?: string;        // smoke line label; default: the language id
  pkg: string;           // grammar package
  key?: string;          // export of the package to use; default: the module itself
  file?: string;         // file name the language parses the snippet as (picks the grammar when a language has several); default: smoke + first extension
  snippet: string;
  want: string[];
}

/** Phase 26: how a test case looks in one language (testCases.ts applies it). A function or method is a test when either part matches. */
export interface TestCasePattern {
  /** Matches the element name (`test_total`, `TestOrders.test_total`, `TEST(Suite, Name)`). */
  names?: RegExp;
  /** Matches the element's header: the attribute, decorator and comment lines right above it and its own
   *  lines up to the declaration (`#[test]`, `[Fact]`, `@Test`, a `@test` docblock). */
  marks?: RegExp;
}

/** Phase 26 (T26-9): one file in a container root that shows a test runner is used. */
export interface TestRunnerProbe {
  /** File name, or a pattern over the root's entry names; omitted: the language's own `manifests` and `suffixManifests`. */
  file?: string | RegExp;
  /** The file must contain a match; omitted: it only has to exist. */
  contains?: RegExp;
}

/** Phase 26 (T26-9): one test runner of a language (testRunner.ts detects it and fills its command). */
export interface TestRunnerDef {
  id: string;                 // 'jest', 'pytest'
  /** The runner is used when any probe matches in the container root. */
  detect: TestRunnerProbe[];
  /** Command template, run in the container root: {file} (relative to it), {name}, {nameRegex} (as in config `tests.command`). */
  command: string;
}

/** Phase 26 (T26-9): how a language's tests are run. */
export interface TestRunnerSpec {
  /** In priority order: the first runner detected wins. */
  runners: TestRunnerDef[];
  /** A case's outline name as its runners write it (`{name}`); the ` (2)` dedupe suffix is already removed. Default: unchanged. */
  name?: (name: string) => string;
  /** Why no command when no runner is detected (e.g. gtest: only the build knows the test binary). */
  unknown?: string;
}

/** What a language module writes: its data and its rules. Everything optional has a default. */
export interface LanguageSpec {
  id: string;
  extensions: string[];
  /** Grammar module, required statically inside the function so the binary bundler finds it. */
  grammar?: () => unknown;
  /** Own parse instead of `grammar` (TypeScript: two grammars, chosen by file extension). */
  parse?: (code: string, file: string) => Parser.Tree;
  /**
   * Known macros the grammar cannot read (there is no preprocessor), e.g. C++ `FMT_BEGIN_NAMESPACE`: each
   * match (a global regex) is replaced by spaces of the same length before the `grammar` parse, so every
   * line and column stays. Not with an own `parse`.
   */
  blankMacros?: RegExp;
  /**
   * Likely macros, tried only when the `grammar` parse has errors (b573), e.g. C++ `FMT_EXPORT class x`: each match
   * (a global regex) is blanked as with `blankMacros` (newlines kept) and the file parsed again; the parse with fewer
   * errors is kept. A file that parses cleanly is never changed by it. Not with an own `parse`.
   */
  retryMacros?: RegExp;
  /** Manifest file name -> tech label, a container only when this language is selected. */
  manifests?: Record<string, string>;
  /** Manifest file-name suffix -> tech label (same gate as `manifests`). */
  suffixManifests?: Record<string, string>;
  /** Build output / third-party folders skipped at any depth when this language is selected (`*` allowed). */
  ignoreDirs?: string[];
  smoke: SmokeCheck[];
  outline: LanguageHandler['outline'];
  /**
   * True when `outline` lists types (kind 'type': interface, enum, trait, protocol). Required, so every language
   * states it: `check` reports a link to a missing type only in files of these languages (b510).
   */
  outlineTypes: boolean;
  /** Default: no imports. */
  imports?: LanguageHandler['imports'];
  /** Default: noResolver (never asked when there are no imports). */
  resolver?: LanguageHandler['createResolver'];
  /** Call sites: TypeScript/JavaScript (own reader) and Python (the kit's createCallsCollector, b592); default none. */
  calls?: LanguageHandler['calls'];
  /** Phase 26: how a test case looks (testCases.ts); the scan marks matches in role-test files as kind 'test'. */
  testCases?: TestCasePattern;
  /** Phase 26: test cases of a role-test file (default: none). */
  tests?: LanguageHandler['tests'];
  /** Phase 26 (T26-9): the test runners and how they name a case (default: none, so no run command without config). */
  testRunner?: TestRunnerSpec;
}

/** A language: the LanguageHandler the pipeline calls, plus the data the registry derives constants from. */
export interface LanguageDescriptor extends LanguageHandler {
  manifests?: Record<string, string>;
  suffixManifests?: Record<string, string>;
  ignoreDirs?: string[];
  testCases?: TestCasePattern;
  testRunner?: TestRunnerSpec;
  smoke: SmokeCheck[];
  outlineTypes: boolean;
}

const noImports: LanguageHandler['imports'] = () => [];
const noResolverFactory: LanguageHandler['createResolver'] = () => noResolver;

/** Every match of the global regex `re` turned into spaces, newlines kept: each line and column stays. */
function blankMatches(re: RegExp, code: string): string {
  return code.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * The default `grammar` parse: `blankMacros` blanked first; when that parse has errors and `retryMacros` matches,
 * a second parse with those blanked too, kept only when it has fewer errors (b573). A clean file is parsed once.
 */
function parseBlanked(id: string, grammar: () => unknown, code: string, blankMacros?: RegExp, retryMacros?: RegExp): Parser.Tree {
  const blanked = blankMacros ? blankMatches(blankMacros, code) : code;
  const tree = parseWithGrammar(id, grammar, blanked);
  if (!retryMacros || !tree.rootNode.hasError) return tree;
  const again = blankMatches(retryMacros, blanked);
  if (again === blanked) return tree;
  const retry = parseWithGrammar(id, grammar, again);
  return parseErrorCount(retry) < parseErrorCount(tree) ? retry : tree;
}

/** Turn a language module's spec into its descriptor, filling the defaults. */
export function defineLanguage(spec: LanguageSpec): LanguageDescriptor {
  const { id, grammar, blankMacros, retryMacros } = spec;
  if (!spec.parse && !grammar) throw new Error(`language ${id}: needs grammar or parse`);
  if (spec.parse && (blankMacros || retryMacros)) throw new Error(`language ${id}: blankMacros and retryMacros need the grammar parse`);
  const parse = spec.parse ?? ((code: string) => parseBlanked(id, grammar!, code, blankMacros, retryMacros));
  return {
    id,
    extensions: spec.extensions,
    parse,
    outline: spec.outline,
    outlineTypes: spec.outlineTypes,
    imports: spec.imports ?? noImports,
    ...(spec.calls && { calls: spec.calls }),
    ...(spec.tests && { tests: spec.tests }),
    createResolver: spec.resolver ?? noResolverFactory,
    ...(spec.manifests && { manifests: spec.manifests }),
    ...(spec.suffixManifests && { suffixManifests: spec.suffixManifests }),
    ...(spec.ignoreDirs && { ignoreDirs: spec.ignoreDirs }),
    ...(spec.testCases && { testCases: spec.testCases }),
    ...(spec.testRunner && { testRunner: spec.testRunner }),
    smoke: spec.smoke,
  };
}
