import type { PlanElement, SourcePos } from '../types';

/** Copies the blocks of the existing plan as the user wrote them (b397). Pure: the plan text comes from the caller. */
export interface BlockCopier {
  /**
   * The block of `el` as the user wrote it (raw lines source.line..endLine, '\n' at the end), with `inject()` placed before its
   * closing-brace line. Null when it cannot be copied: no text for the file, no endLine, fewer than 2 lines, or the last line
   * does not start with `}` -> the caller rebuilds. On success the range is registered BEFORE `inject` runs, so `covers`
   * is already true for everything inside this block when the caller builds the injected text.
   */
  copy(el: PlanElement, inject?: () => string): string | null;
  /** True when `pos` lies inside a block `copy` returned earlier. */
  covers(pos: SourcePos): boolean;
}

/** `planText` gives the text of a plan file (by Plan.files path); without it nothing is copied and nothing is covered. */
export function blockCopier(planText?: (file: string) => string | undefined): BlockCopier {
  const ranges: { file: string; line: number; end: number }[] = [];
  const cache = new Map<string, string | undefined>();
  const textOf = (file: string): string | undefined => {
    if (!cache.has(file)) cache.set(file, planText?.(file));
    return cache.get(file);
  };
  return {
    covers: (pos) => ranges.some(r => r.file === pos.file && pos.line >= r.line && pos.line <= r.end),
    copy(el, inject) {
      const end = el.source.endLine;
      const text = textOf(el.source.file);
      if (text === undefined || end === undefined) return null;
      const lines = text.split('\n').slice(el.source.line - 1, end);
      if (lines.length < 2 || !lines[lines.length - 1].trim().startsWith('}')) return null;
      ranges.push({ file: el.source.file, line: el.source.line, end });
      const extra = inject?.() ?? '';
      return lines.slice(0, -1).join('\n') + '\n' + extra + lines[lines.length - 1] + '\n';
    },
  };
}
