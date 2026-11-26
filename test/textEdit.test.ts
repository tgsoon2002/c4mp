import { textCursor, childIndentation, defaultIndentUnit } from '../src/c4/textEdit';

describe('textCursor', () => {
  const text = 'a = x\n  b = y\r\n\tc';
  const cur = textCursor(text);

  it('lineStart / indentOf / startsLine', () => {
    expect(cur.lineStart(0)).toBe(0);
    expect(cur.lineStart(9)).toBe(6);
    expect(cur.indentOf(9)).toBe('  ');
    expect(cur.indentOf(0)).toBe('');
    expect(cur.startsLine(8)).toBe(true);    // after the two spaces
    expect(cur.startsLine(10)).toBe(false);
    expect(cur.indentOf(text.length - 1)).toBe('\t');
  });

  it('eolAfter / eolAt', () => {
    expect(cur.eolAfter(0)).toBe('\n');
    expect(cur.eolAfter(7)).toBe('\r\n');
    expect(cur.eolAfter(text.length - 1)).toBeNull();
    expect(cur.eolAt(text.length - 1)).toBe('\n');             // falls back to the file's first break
    expect(textCursor('x').eolAt(0)).toBe('\n');                // no break at all: LF
    expect(textCursor('x\r\ny').eolAt(3)).toBe('\r\n');
  });

  it('splice inserts and replaces', () => {
    expect(cur.splice(0, 'Z').text).toBe('Za = x\n  b = y\r\n\tc');
    expect(cur.splice(0, 'Z', 1)).toEqual({ text: 'Z = x\n  b = y\r\n\tc', changed: true });
  });
});

describe('childIndentation', () => {
  it('uses the indent of the first body line when it starts its own line', () => {
    const t = 'a = x {\n    b = y\n}\n';
    const cur = textCursor(t);
    expect(childIndentation(cur, 0, { start: 12, line: 2 }, 1)).toEqual({ baseIndent: '', childIndent: '    ', unit: '    ', kid: '    ' });
  });
  it('falls back to base indent plus the default unit', () => {
    const cur = textCursor('\ta = x {}');
    expect(childIndentation(cur, 1, null, null)).toEqual({ baseIndent: '\t', childIndent: null, unit: '\t', kid: '\t\t' });
    expect(childIndentation(textCursor('a = x { b = y }'), 0, { start: 8, line: 1 }, 1).kid).toBe('  ');
  });
  it('defaultIndentUnit', () => {
    expect(defaultIndentUnit('\t')).toBe('\t');
    expect(defaultIndentUnit('    ')).toBe('  ');
  });
});
