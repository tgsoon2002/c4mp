import { rollupEdges, dominantOwnerPerFile } from '../src/grouper/rollup';
import { FileEdge, Ownership, SnapshotFile, CodeElement } from '../src/types';

function makeFile(file: string, elementNames: string[]): SnapshotFile {
  const elements: CodeElement[] = elementNames.map((name, i) => ({
    name,
    kind: 'function',
    startLine: i + 1,
    endLine: i + 1,
    lineCount: 1,
  }));
  return { file, lineCount: elementNames.length, parseError: false, elements, componentId: 'unused' };
}

function makeOwnership(owner: Record<string, string>): Ownership {
  return { owner, conflicts: [], shared: [], unassigned: [] };
}

describe('rollupEdges', () => {
  it('should rollup file edges to component edges with correct weights', () => {
    const fileEdges: FileEdge[] = [
      { from: 'a1', to: 'b1' },
      { from: 'a2', to: 'b1' },
      { from: 'a1', to: 'a2' },
      { from: 'b1', to: 'a1' },
      { from: 'x', to: 'b1' },
    ];

    const fileToComponent = {
      a1: 'A',
      a2: 'A',
      b1: 'B',
    };

    const result = rollupEdges(fileEdges, fileToComponent);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ from: 'A', to: 'B', weight: 2 });
    expect(result[1]).toEqual({ from: 'B', to: 'A', weight: 1 });
  });

  it('should skip edges where either end is unmapped', () => {
    const fileEdges: FileEdge[] = [
      { from: 'a1', to: 'b1' },
      { from: 'unmapped', to: 'b1' },
    ];

    const fileToComponent = {
      a1: 'A',
      b1: 'B',
    };

    const result = rollupEdges(fileEdges, fileToComponent);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 'A', to: 'B', weight: 1 });
  });

  it('should skip edges where both ends are in the same component', () => {
    const fileEdges: FileEdge[] = [
      { from: 'a1', to: 'a2' },
      { from: 'a1', to: 'b1' },
    ];

    const fileToComponent = {
      a1: 'A',
      a2: 'A',
      b1: 'B',
    };

    const result = rollupEdges(fileEdges, fileToComponent);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 'A', to: 'B', weight: 1 });
  });
});

describe('dominantOwnerPerFile', () => {
  it('should pick the owner with the most elements in a file', () => {
    const files = [makeFile('a.ts', ['f1', 'f2', 'f3'])];
    const ownership = makeOwnership({
      'a.ts#f1': 'A',
      'a.ts#f2': 'A',
      'a.ts#f3': 'B',
    });

    const result = dominantOwnerPerFile(ownership, files);

    expect(result).toEqual({ 'a.ts': 'A' });
  });

  it('should break a tie by lower elementId string', () => {
    const files = [makeFile('b.ts', ['f1', 'f2'])];
    const ownership = makeOwnership({
      'b.ts#f1': 'B-component',
      'b.ts#f2': 'A-component',
    });

    const result = dominantOwnerPerFile(ownership, files);

    expect(result).toEqual({ 'b.ts': 'A-component' });
  });

  it('should map a file with all-unassigned elements to unassigned', () => {
    const files = [makeFile('c.ts', ['f1', 'f2'])];
    const ownership = makeOwnership({
      'c.ts#f1': 'unassigned',
      'c.ts#f2': 'unassigned',
    });

    const result = dominantOwnerPerFile(ownership, files);

    expect(result).toEqual({ 'c.ts': 'unassigned' });
  });

  it('should map a file with zero elements to unassigned', () => {
    const files = [makeFile('empty.ts', [])];
    const ownership = makeOwnership({});

    const result = dominantOwnerPerFile(ownership, files);

    expect(result).toEqual({ 'empty.ts': 'unassigned' });
  });

  it('should map a zero-element file to its fileOwner entry', () => {
    const files = [makeFile('a/X.java', [])];
    const ownership: Ownership = { ...makeOwnership({}), fileOwner: { 'a/X.java': 'c1' } };

    expect(dominantOwnerPerFile(ownership, files)).toEqual({ 'a/X.java': 'c1' });
  });

  it('should map a zero-element file without a fileOwner entry to unassigned', () => {
    const files = [makeFile('a/Y.java', [])];
    const ownership: Ownership = { ...makeOwnership({}), fileOwner: { 'a/X.java': 'c1' } };

    expect(dominantOwnerPerFile(ownership, files)).toEqual({ 'a/Y.java': 'unassigned' });
  });

  it('should ignore fileOwner for a file that has elements', () => {
    const files = [makeFile('e.ts', ['f1'])];
    const ownership: Ownership = { ...makeOwnership({ 'e.ts#f1': 'A' }), fileOwner: { 'e.ts': 'Z' } };

    expect(dominantOwnerPerFile(ownership, files)).toEqual({ 'e.ts': 'A' });
  });

  it('should map a file entirely owned by shared-auto to shared-auto', () => {
    const files = [makeFile('d.ts', ['f1', 'f2'])];
    const ownership = makeOwnership({
      'd.ts#f1': 'shared-auto',
      'd.ts#f2': 'shared-auto',
    });

    const result = dominantOwnerPerFile(ownership, files);

    expect(result).toEqual({ 'd.ts': 'shared-auto' });
  });
});
