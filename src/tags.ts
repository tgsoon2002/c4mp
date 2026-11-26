/** A tag is lower-case letters, digits and dashes, starting with a letter or digit ('billing', 'api-v2'). */
export const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

/**
 * The entries of a `tags` metadata value exactly as written: split on comma, trimmed, empties dropped,
 * de-duplicated, order kept. Use it to CHECK the format (the check must see 'Billing' as written).
 */
export function splitTagsRaw(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Normalised tags for matching and display: like `splitTagsRaw`, but lower-cased before de-duplication. */
export function splitTags(raw: string | undefined): string[] {
  return splitTagsRaw(raw?.toLowerCase());
}
