import type { LanguageHandler } from '../types';
import { LANGUAGES } from './registry';
import { FILE_ONLY_ID } from '../constants';

const allHandlers: Record<string, LanguageHandler> = LANGUAGES.handlers;

/**
 * Get language handlers by their ids.
 * Throws if any id is unknown.
 */
export function getHandlers(ids: string[]): LanguageHandler[] {
  const handlers: LanguageHandler[] = [];
  for (const id of ids) {
    if (id === FILE_ONLY_ID) continue;
    const handler = allHandlers[id];
    if (!handler) {
      throw new Error(`Unknown language: ${id}`);
    }
    handlers.push(handler);
  }
  return handlers;
}

/**
 * Every extension the handlers of these language ids read, in id order then each handler's own order, repeats kept
 * (a caller that needs a set dedups). The file-only id adds nothing; throws on an unknown id, as getHandlers does.
 */
export function handlerExtensions(ids: string[]): string[] {
  return getHandlers(ids).flatMap((h) => h.extensions);
}

/** True when the language ids ask for file-only (unparsed) listing. */
export function wantsFileOnly(ids: string[]): boolean {
  return ids.includes(FILE_ONLY_ID);
}

/**
 * Get the handler for a file based on its extension.
 * Returns null if no handler is found.
 */
export function handlerFor(file: string, handlers: LanguageHandler[]): LanguageHandler | null {
  const ext = file.substring(file.lastIndexOf('.'));
  for (const handler of handlers) {
    if (handler.extensions.includes(ext)) {
      return handler;
    }
  }
  return null;
}
