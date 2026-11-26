import { blockCopier } from '../src/c4/blockText';
import { PlanElement } from '../src/types';

const el = (line: number, endLine?: number, file = 'a.c4'): PlanElement => ({ source: { file, line, endLine } } as unknown as PlanElement);
const TEXT = "model {\n  x = component 'X' {\n    // note\n    link ../x/\n  }\n  y = component 'Y' { link ../y/ }\n}\n";

describe('blockCopier (b397)', () => {
  it.each([
    ['no text for the file', blockCopier(() => undefined), el(2, 5)],
    ['no planText at all', blockCopier(), el(2, 5)],
    ['no endLine', blockCopier(() => TEXT), el(2)],
    ['one line', blockCopier(() => TEXT), el(6, 6)],
    ['last line is not a closing brace', blockCopier(() => TEXT), el(2, 4)],
  ])('copy gives null: %s', (_name, copier, e) => {
    expect(copier.copy(e)).toBeNull();
    expect(copier.covers({ file: 'a.c4', line: 3 })).toBe(false);   // nothing registered
  });

  it('copies the raw lines and puts the injected text before the closing line, range registered first', () => {
    const copier = blockCopier(() => TEXT);
    let coveredDuringInject = false;
    const out = copier.copy(el(2, 5), () => { coveredDuringInject = copier.covers({ file: 'a.c4', line: 4 }); return '    added\n'; });
    expect(out).toBe("  x = component 'X' {\n    // note\n    link ../x/\n    added\n  }\n");
    expect(coveredDuringInject).toBe(true);
  });

  it('covers: false before, true inside, false after or in another file', () => {
    const copier = blockCopier(() => TEXT);
    copier.copy(el(2, 5));
    expect(copier.covers({ file: 'a.c4', line: 1 })).toBe(false);
    expect(copier.covers({ file: 'a.c4', line: 2 })).toBe(true);
    expect(copier.covers({ file: 'a.c4', line: 5 })).toBe(true);
    expect(copier.covers({ file: 'a.c4', line: 6 })).toBe(false);
    expect(copier.covers({ file: 'b.c4', line: 3 })).toBe(false);
  });

  it('keeps CRLF text raw and accepts a closing line with a trailing comment', () => {
    const crlf = "x = component 'X' {\r\n  // n\r\n} // end\r\n";
    expect(blockCopier(() => crlf).copy(el(1, 3))).toBe("x = component 'X' {\r\n  // n\r\n} // end\r\n");
  });
});
