import type { LiveModel } from '../page/liveModel';
import type { PageExport } from '../page/viewExport';
import type { LayoutFile } from '../c4/applyLayout';
import { applyLayoutService, checkLayout } from '../services/planFileEdits';
import { runBoardOps, BOARD_PAGE_FIELDS } from '../services/boardEdit';
import type { BoardPageOp } from '../services/boardEdit';
import { cleanSettings, readUserSettings, writeUserJson } from '../util/userFiles';
import type { C4pmConfig } from '../types';
import { RequestRefused } from './security';

/**
 * Phase 30 SV6 (b793): the API routes of `c4pm serve`. The server has checked the request (checkRequest) and read the
 * body (readJsonBody) before a handler runs. SV18: the write routes (api/layout, api/board, api/settings) each call one
 * guarded service; the page never passes a path, `force` or a field outside the page's list.
 */

export interface ApiContext {
  live: LiveModel;
  /** The longest an api/wait is held, in ms (plan 4.5: at most 25 s, under the 30 s request timeout). */
  waitMs: number;
  /** b914: write the repo's page file from this page data and give back the copy to download (exportPageData, bound to
   *  the repo and the cli config by startServe). Absent: api/export answers 501 and writes nothing. */
  exportPage?: (dataJson: string, opts: { noSource: boolean }) => PageExport;
  /** SV18: the repo the write routes edit and its cli config (startServe binds them). Absent: api/layout, api/board 501. */
  repo?: { root: string; cli: Partial<C4pmConfig> };
  /** SV18 (b646): the settings file (userFile(SETTINGS_FILE)); null = turned off (C4PM_USER_DIR=off); absent: api/settings 501, api/boot sends {}. */
  settingsFile?: string | null;
}

/** What a handler gets: the query of the URL and the parsed JSON body (undefined for a route without a body). */
export interface ApiRequest {
  query: URLSearchParams;
  body: unknown;
}

/** A handler's answer: the status and the JSON text, sent as it is. */
export interface ApiAnswer {
  status: number;
  json: string;
}

export type ApiHandler = (req: ApiRequest) => Promise<ApiAnswer>;

const ok = (json: string): ApiAnswer => ({ status: 200, json });

const refusal = (status: number, message: string): ApiAnswer => ({ status, json: JSON.stringify({ message }) });

/** A write route whose task waits for K: the checks ran, the body was read, nothing is written. */
const notBuilt = (route: string, task: string): ApiHandler => async () => ({
  status: 501,
  json: JSON.stringify({ message: `${route} is not built yet (Phase 30 ${task}); nothing was written` }),
});

/** `since` of api/wait: a whole number 0..2^31; anything else is refused. */
function sinceOf(query: URLSearchParams): number {
  const raw = query.get('since') ?? '';
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > 2 ** 31) throw new RequestRefused(400, 'api/wait needs since=<generation>');
  return Number(raw);
}

/** `noSource` of api/export: the body is exactly `{"noSource": true|false}`; any other key or type is refused (no path is ever taken). */
function exportBody(body: unknown): boolean {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).join() !== 'noSource' || typeof b.noSource !== 'boolean') {
    throw new RequestRefused(400, 'api/export takes {"noSource": true|false} only');
  }
  return b.noSource;
}

/** The body as a plain object with exactly `keys` (in any order), or null. */
function exactObject(body: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const have = Object.keys(b);
  return have.length === keys.length && keys.every((k) => have.includes(k)) ? b : null;
}

/** `{expect, layout}` of api/layout: exactly these two keys (no path, no force); the layout must pass checkLayout. */
function layoutBody(body: unknown): { expect: string; layout: LayoutFile } {
  const b = exactObject(body, ['expect', 'layout']);
  if (!b || typeof b.expect !== 'string' || b.expect.length > 64) {
    throw new RequestRefused(400, 'api/layout takes {"expect": "<stamp>", "layout": {...}} only');
  }
  try {
    return { expect: b.expect, layout: checkLayout(b.layout) };
  } catch (err) {
    throw new RequestRefused(400, `api/layout: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const MAX_BOARD_OPS = 200;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** One op of api/board with exactly the keys of its kind; throws the reason (the caller adds `op <i>: `). */
function boardOp(raw: unknown): BoardPageOp {
  const kind = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).op : undefined;
  const keysOf: Record<string, string[]> = {
    set: ['op', 'id', 'fields'], 'group-add': ['op', 'board', 'name'], 'group-remove': ['op', 'board', 'name'], 'group-order': ['op', 'board', 'names'],
  };
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(keysOf, kind)) throw new Error(`unknown op '${String(kind)}'`);
  const o = exactObject(raw, keysOf[kind]);
  if (!o) throw new Error(`an op '${kind}' takes exactly the keys ${keysOf[kind].join(', ')}`);
  for (const k of keysOf[kind].slice(1)) {
    if (k === 'fields' || k === 'names') continue;
    if (!nonEmpty(o[k])) throw new Error(`${k} must be a non-empty string`);
  }
  if (kind === 'group-order') {
    if (!Array.isArray(o.names) || !o.names.every(nonEmpty)) throw new Error('names must be an array of non-empty strings');
  }
  if (kind === 'set') {
    const f = o.fields;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new Error('fields must hold at least one field');
    const entries = Object.entries(f as Record<string, unknown>);
    if (entries.length === 0) throw new Error('fields must hold at least one field');
    for (const [k, v] of entries) {
      if (!(BOARD_PAGE_FIELDS as readonly string[]).includes(k)) throw new Error(`field '${k}' cannot be set from the page`);
      if (typeof v !== 'string') throw new Error(`field '${k}' must be a string`);
    }
  }
  return o as unknown as BoardPageOp;
}

/** `{expect, ops}` of api/board: 1..200 ops, each checked by boardOp; the field names are the page's list only. */
function boardBody(body: unknown): { expect: string; ops: BoardPageOp[] } {
  const usage = 'api/board takes {"expect": "<stamp>", "ops": [...]}';
  const b = exactObject(body, ['expect', 'ops']);
  if (!b || typeof b.expect !== 'string' || b.expect.length > 64 || !Array.isArray(b.ops)) throw new RequestRefused(400, usage);
  if (b.ops.length === 0) throw new RequestRefused(400, `${usage}; no ops`);
  if (b.ops.length > MAX_BOARD_OPS) throw new RequestRefused(400, `${usage}; too many ops (${b.ops.length}, at most ${MAX_BOARD_OPS})`);
  const ops = b.ops.map((raw, i) => {
    try {
      return boardOp(raw);
    } catch (err) {
      throw new RequestRefused(400, `${usage}; op ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { expect: b.expect, ops };
}

/** The `settings` value of api/settings: exactly the key `settings`; cleanSettings checks the rest. */
function settingsBody(body: unknown): unknown {
  const b = exactObject(body, ['settings']);
  if (!b) throw new RequestRefused(400, 'api/settings takes {"settings": {...}} only');
  return b.settings;
}

/**
 * The API handlers by route ('api/boot', ...):
 * - api/boot: `{ data, generation, stamps, settings, error }` of the current state; `data` is the live model's dataJson as
 *   it is (never parsed again). `settings` is the cleaned settings file ({} without one).
 * - api/wait?since=<n>: held until the state changes (a rebuild starts or ends, a new generation, an error) or waitMs
 *   passes, then `{ generation, building, error }`. A `since` that is not the current generation answers at once.
 * - api/export {noSource} (b914): 409 while a rebuild runs or after a failed one; else exportPage writes the view file and
 *   the answer is `{ file, name, noSource, html }`; 400 for any other body; 500 `export failed: <reason>`; 501 without exportPage.
 * - api/layout {expect, layout}: applyLayoutService (never force): 200 written, 409 changed since `expect`, 422 refused, 400 bad body.
 * - api/board {expect, ops}: runBoardOps in order, stopping at the first refusal: 200, 409 changed, 422 stopped (stoppedAt), 400.
 * - api/settings {settings}: cleanSettings, then the personal file (0600): 200, 400, 409 file turned off, 500 write error.
 * - api/layout and api/board answer 501 without ctx.repo, api/settings without ctx.settingsFile.
 */
export function createApiHandlers(ctx: ApiContext): Record<string, ApiHandler> {
  return {
    'api/boot': async () => {
      const s = ctx.live.current();
      const settings = ctx.settingsFile ? readUserSettings(ctx.settingsFile) : {};
      const rest = JSON.stringify({ generation: s.generation, stamps: s.stamps, settings, error: s.error });
      return ok(`{"data":${s.dataJson},${rest.slice(1)}`);
    },
    'api/wait': async (req) => {
      const since = sinceOf(req.query);
      const s = await ctx.live.waitFor(since, ctx.waitMs);
      return ok(JSON.stringify({ generation: s.generation, building: s.building, error: s.error }));
    },
    'api/export': async (req) => {
      if (!ctx.exportPage) return notBuilt('api/export', 'b914')(req);
      const noSource = exportBody(req.body);
      const s = ctx.live.current();
      if (s.building) return refusal(409, 'the map is being rebuilt; export again in a moment. Nothing was written');
      if (s.error) return refusal(409, `the last rebuild failed (${s.error}), so the page data is old. Fix it, then export. Nothing was written`);
      try {
        const r = ctx.exportPage(s.dataJson, { noSource });
        return ok(JSON.stringify({ file: r.file, name: r.name, noSource, html: r.html }));
      } catch (err) {
        return refusal(500, `export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    'api/layout': async (req) => {
      if (!ctx.repo) return notBuilt('api/layout', 'SV18')(req);
      const { expect, layout } = layoutBody(req.body);
      try {
        const r = applyLayoutService(ctx.repo.root, layout, { yes: true, expectStamp: expect, cli: ctx.repo.cli });   // never force
        const status = r.write.ok ? 200 : r.write.error?.code === 'changed' ? 409 : 422;
        return { status, json: JSON.stringify({ ok: r.write.ok, report: r.report, write: r.write, stamp: r.stamp }) };
      } catch (err) {
        return refusal(500, `layout save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    'api/board': async (req) => {
      if (!ctx.repo) return notBuilt('api/board', 'SV18')(req);
      const { expect, ops } = boardBody(req.body);
      try {
        const r = runBoardOps(ctx.repo.root, ops, { yes: true, expectStamp: expect });
        return { status: r.ok ? 200 : r.error?.code === 'changed' ? 409 : 422, json: JSON.stringify(r) };
      } catch (err) {
        return refusal(500, `board save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    'api/settings': async (req) => {
      if (ctx.settingsFile === undefined) return notBuilt('api/settings', 'SV18')(req);
      if (ctx.settingsFile === null) {
        return refusal(409, 'the settings file is turned off (C4PM_USER_DIR=off); the settings stay in this browser. Nothing was written');
      }
      const c = cleanSettings(settingsBody(req.body));
      if ('error' in c) throw new RequestRefused(400, `api/settings: ${c.error}`);
      try {
        writeUserJson(ctx.settingsFile, c.settings);
      } catch (err) {
        return refusal(500, `cannot save the settings: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok(JSON.stringify({ ok: true, settings: c.settings }));
    },
  };
}
