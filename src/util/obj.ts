/**
 * A plain JSON object: not null, not an array (a function or a class instance never comes out of JSON.parse).
 * T2 (b696): the one copy for the readers of JSON files and requests (board, sim, MCP, snapshots).
 */
export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
