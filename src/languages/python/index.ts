import { defineLanguage } from '../define';
import { extractPythonOutline } from './outline';
import { extractPythonImports } from './imports';
import { createPythonResolver } from './resolve';
import { extractPythonCalls } from './calls';

export const pythonHandler = defineLanguage({
  id: 'python',
  extensions: ['.py'],
  grammar: () => require('tree-sitter-python'),
  smoke: [{ pkg: 'tree-sitter-python', want: ['function_definition', 'class_definition'],
    snippet: 'import os\n\ndef add(x, y):\n    return x + y\n\nclass Box:\n    def size(self):\n        return 1\n' }],
  // pytest and unittest: a `test*` function, or a `test*` method of a test class (`TestOrders.test_total`).
  testCases: { names: /^(?:[^.]+\.)?test[^.]*$/ },
  // pytest node id `file::Class::test_name`; pytest shows in its own ini files, conftest.py or a dependency.
  testRunner: {
    runners: [{ id: 'pytest', command: 'pytest "{file}::{name}"', detect: [
      { file: 'pytest.ini' }, { file: 'conftest.py' }, { file: 'pyproject.toml', contains: /\bpytest\b/ },
      { file: 'setup.cfg', contains: /^\[tool:pytest\]/m }, { file: 'tox.ini', contains: /^\[pytest\]/m },
      { file: /^requirements.*\.txt$/, contains: /^pytest\b/m },
    ] }],
    name: (n) => n.replace(/\./g, '::'),
  },
  outline: extractPythonOutline,
  outlineTypes: false,
  imports: extractPythonImports,
  resolver: createPythonResolver,
  calls: extractPythonCalls,
});

export default pythonHandler;
