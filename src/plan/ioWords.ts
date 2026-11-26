/**
 * b266: the words of the IO view that depend on the plan, in one place (text only, no drawing): the word of an app
 * by its technology (CLI / API / MCP / App), the HTTP method of a route, the word of a part by its parent kind, and
 * the metadata keys a card row carries. Kind words themselves live in view/kindWords.ts.
 */

/** Technology word -> container word. A technology text is matched word by word (like schema/storageTech normalizeTech); first hit wins. */
const CONTAINER_WORDS: Record<string, string> = {
  commander: 'CLI', yargs: 'CLI', click: 'CLI', cli: 'CLI',
  express: 'API', fastify: 'API', hono: 'API', rest: 'API', http: 'API', api: 'API', openapi: 'API',
  mcp: 'MCP',
};
export const DEFAULT_CONTAINER_WORD = 'App';

/** The word of an app in the IO view from its technology text: 'CLI', 'API', 'MCP', else 'App'. */
export function ioContainerWord(technology: string | null | undefined): string {
  for (const w of (technology ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (Object.prototype.hasOwnProperty.call(CONTAINER_WORDS, w)) return CONTAINER_WORDS[w];
  }
  return DEFAULT_CONTAINER_WORD;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** HTTP method of a route: metadata.method (upper-cased) when set, else the first word of the title when it is a method, else null. */
export function routeMethod(title: string, metadata: Record<string, string> | undefined): string | null {
  const explicit = metadata?.method?.trim().toUpperCase();
  if (explicit) return explicit;
  const first = title.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  return HTTP_METHODS.has(first) ? first : null;
}

/** Word shown for a part kind when its parent kind changes it: part kind -> parent kind -> word (a param under a body is a 'Field'). */
export const PART_WORD_BY_PARENT: Record<string, Record<string, string>> = {
  param: { body: 'Field' },
};

/** Metadata keys of a part that a card row carries, in this order (only the keys that are set). */
export const IO_META_KEYS: readonly string[] = ['in', 'type', 'required'];

/** Default of metadata `in` for a param by its parent kind (route: query, body: body); a tool param has none. */
export const PARAM_IN_BY_PARENT: Record<string, string> = { route: 'query', body: 'body' };

/** C3: the layout size of a screen's wireframe by device (H9). A new device is one row. */
export const DEVICE_VIEWPORT: Record<string, { w: number; h: number }> = {
  web: { w: 1280, h: 800 },
  phone: { w: 390, h: 844 },
};

/** Smallest and largest side of a viewport, in whole pixels. */
export const VIEWPORT_MIN = 10;
export const VIEWPORT_MAX = 99999;

/** Parse metadata `viewport 'WxH'` (whole numbers, each VIEWPORT_MIN to VIEWPORT_MAX, checked as numbers). Null when bad. */
export function parseViewport(v: string | null | undefined): { w: number; h: number } | null {
  const m = /^(\d+)x(\d+)$/.exec((v ?? '').trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  const ok = (n: number) => n >= VIEWPORT_MIN && n <= VIEWPORT_MAX;
  return ok(w) && ok(h) ? { w, h } : null;
}
