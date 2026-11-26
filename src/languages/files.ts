import { FileOutline } from '../types';
import { log } from '../log';
import { countLines } from './treesitter';

// Outline of a file-only file: counted and listed, never parsed (no functions, no imports).
export function fileOnlyOutline(file: string, code: string): FileOutline {
  const lineCount = countLines(code);
  log('files', 'outline', { file, lineCount });
  return { file, lineCount, parseError: false, elements: [], fileOnly: true };
}
