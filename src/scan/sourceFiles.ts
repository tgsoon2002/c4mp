import { listSourceFiles } from '../importer/walk';
import { handlerExtensions } from '../languages';
import { LANGUAGE_IDS, languageIgnorePatterns } from '../languages/registry';
import type { C4pmConfig } from '../types';

/** Every extension a language handler reads, for all languages (whatever config `languages` says), in list order. */
export const ALL_LANGUAGE_EXTENSIONS: string[] = [...new Set(handlerExtensions(LANGUAGE_IDS))];

/**
 * The project's files with one of `extensions`, repo-relative, walked with the scan's rules: config `ignore`, the
 * default ignores of the config's languages, dot folders, node_modules, dist, build, ... (importer/walk.ts). Symlinks
 * are not followed. Throws when repoRoot is not a directory.
 */
export function sourceFiles(repoRoot: string, config: Pick<C4pmConfig, 'ignore' | 'languages'>, extensions: string[]): string[] {
  return listSourceFiles(repoRoot, { extensions, ignore: config.ignore, languageIgnores: languageIgnorePatterns(config.languages) });
}
