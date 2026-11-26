import { defineLanguage } from '../define';
import { extractCSharpOutline } from './outline';
import { extractCSharpImports } from './imports';
import { createCSharpResolver } from './resolve';

// Outline and imports: `using` directives resolved through the namespaces the scanned files declare
// (one edge per declaring file), System/Microsoft and .csproj NuGet packages external.
export const csharpHandler = defineLanguage({
  id: 'csharp',
  extensions: ['.cs'],
  grammar: () => require('tree-sitter-c-sharp'),
  suffixManifests: { '.csproj': 'C# (.NET)' },
  ignoreDirs: ['bin', 'obj'],
  smoke: [{ label: 'c-sharp', pkg: 'tree-sitter-c-sharp', want: ['class_declaration', 'method_declaration'],
    snippet: 'using System;\nnamespace Demo {\n  public class Box {\n    public int Add(int x, int y) { return x + y; }\n  }\n}\n' }],
  // xUnit [Fact]/[Theory], NUnit [Test]/[TestCase]/[TestCaseSource], MSTest [TestMethod]/[DataTestMethod]
  // (also `[Xunit.Fact]`, `[FactAttribute]`, or one of several attributes in one list).
  testCases: { marks: /[[,]\s*(?:\w+\.)*(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)(?:Attribute)?\s*[\](,]/ },
  // A test project references Microsoft.NET.Test.Sdk in its .csproj (the manifest above); the filter takes `Class.Method`.
  testRunner: {
    runners: [{ id: 'dotnet', detect: [{ contains: /Microsoft\.NET\.Test\.Sdk/ }], command: 'dotnet test --filter "FullyQualifiedName~{name}"' }],
  },
  outline: extractCSharpOutline,
  outlineTypes: true,
  imports: extractCSharpImports,
  // the resolver reads the declared namespaces with this handler's own parser
  resolver: (repoRoot, sourceFiles) => createCSharpResolver(repoRoot, sourceFiles, csharpHandler.parse),
});

export default csharpHandler;
