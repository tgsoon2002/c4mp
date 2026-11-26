import type { LanguageDescriptor, SmokeCheck } from './define';
import typescript from './typescript';
import python from './python';
import rust from './rust';
import csharp from './csharp';
import php from './php';
import cpp from './cpp';
import swift from './swift';
import { FILE_ONLY_ID } from '../constants';

// The one list of languages. LANGUAGE_IDS, the per-language extension lists, LANGUAGE_MANIFESTS,
// LANGUAGE_IGNORE_DIRS (all below), the handler map (languages/index.ts) and the
// grammar list of scripts/grammar-smoke.js are all derived from it. A new language = one descriptor here.

export interface LanguageRegistry {
  descriptors: LanguageDescriptor[];
  /** Language ids in list order (without the file-only id). */
  ids: string[];
  handlers: Record<string, LanguageDescriptor>;
  extensions: Record<string, string[]>;
  manifests: Record<string, { files?: Record<string, string>; suffixes?: Record<string, string> }>;
  ignoreDirs: Record<string, string[]>;
  /** Every grammar check, label filled in, in list order. */
  smoke: (SmokeCheck & { label: string })[];
}

/** Derive the registry from a descriptor list (pure: no other input). Throws on a repeated id. */
export function buildRegistry(descriptors: LanguageDescriptor[]): LanguageRegistry {
  const registry: LanguageRegistry = { descriptors, ids: [], handlers: {}, extensions: {}, manifests: {}, ignoreDirs: {}, smoke: [] };
  for (const d of descriptors) {
    if (registry.handlers[d.id]) throw new Error(`language ${d.id} listed twice`);
    registry.ids.push(d.id);
    registry.handlers[d.id] = d;
    registry.extensions[d.id] = d.extensions;
    if (d.manifests || d.suffixManifests) {
      registry.manifests[d.id] = { ...(d.manifests && { files: d.manifests }), ...(d.suffixManifests && { suffixes: d.suffixManifests }) };
    }
    if (d.ignoreDirs) registry.ignoreDirs[d.id] = d.ignoreDirs;
    for (const check of d.smoke) registry.smoke.push({ ...check, label: check.label ?? d.id });
  }
  return registry;
}

export const LANGUAGES = buildRegistry([typescript, python, rust, csharp, php, cpp, swift]);

// Per-language data derived from LANGUAGES, imported from here by its users.
/** Every language id the commands accept: the handler languages plus the file-only id. */
export const LANGUAGE_IDS = [...LANGUAGES.ids, FILE_ONLY_ID];
export const SOURCE_EXTENSIONS = LANGUAGES.extensions.typescript;
/** Extensions of the languages whose outline lists types (descriptor `outlineTypes`). */
export const TYPE_OUTLINE_EXTENSIONS = LANGUAGES.descriptors.filter((d) => d.outlineTypes).flatMap((d) => d.extensions);
export const PYTHON_EXTENSIONS = LANGUAGES.extensions.python;
export const PHP_EXTENSIONS = LANGUAGES.extensions.php;
export const CPP_EXTENSIONS = LANGUAGES.extensions.cpp;

// Manifests that count as containers ONLY when that language is selected (language id -> manifest
// file name or suffix -> tech label), from each language's `manifests` / `suffixManifests`.
export const LANGUAGE_MANIFESTS: Record<string, { files?: Record<string, string>; suffixes?: Record<string, string> }> = LANGUAGES.manifests;

// Build output / third-party folders skipped (at any depth) ONLY when that language is selected
// (language id -> folder names; a name may hold `*`), from each language's `ignoreDirs`.
// Added to the user's ignore, never replacing it.
export const LANGUAGE_IGNORE_DIRS: Record<string, string[]> = LANGUAGES.ignoreDirs;

/** The per-language default ignores for the selected language ids: [{language, dirs}] (dirs = folder names). */
export function languageDefaultIgnores(languages: string[] | undefined): { language: string; dirs: string[] }[] {
  return (languages ?? [])
    .filter((l) => LANGUAGE_IGNORE_DIRS[l])
    .map((l) => ({ language: l, dirs: LANGUAGE_IGNORE_DIRS[l] }));
}

/** Patterns of those defaults (`**\/<dir>`, any depth), for createIgnoreMatcher. */
export function languageIgnorePatterns(languages: string[] | undefined): string[] {
  return languageDefaultIgnores(languages).flatMap((d) => d.dirs.map((n) => `**/${n}`));
}

/** The user's ignore combined with the language defaults (user patterns first, none removed). */
export function withLanguageIgnores(ignore: string[] | undefined, languages: string[] | undefined): string[] {
  return [...(ignore ?? []), ...languageIgnorePatterns(languages)];
}
