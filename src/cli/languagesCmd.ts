/**
 * `c4mp languages [--json]` (b451): checks that each language grammar loads and parses on this machine. Machine-level: no
 * --repo, reads nothing of a project, writes nothing. Exit 1 when any grammar fails.
 */
import type { Command } from 'commander';
import { addExamples } from '../cliHelp';
import { checkLanguages } from '../services/languageCheck';
import type { LanguageCheckResult } from '../services/languageCheck';

/** The text report: machine lines, then one PASS/FAIL line per grammar, then the verdict. */
export function formatLanguageCheck(r: LanguageCheckResult): string[] {
  const lines = [
    `platform: ${r.platform}`,
    `arch: ${r.arch}`,
    `node: ${r.node}`,
    `ABI (process.versions.modules): ${r.abi}`,
    `tree-sitter: ${r.treeSitter.error ? `FAILED to load: ${r.treeSitter.error}` : (r.treeSitter.version ?? 'unknown') === 'unknown' ? 'version unknown' : r.treeSitter.version}`,
  ];
  let failures = 0;
  for (const g of r.grammars) {
    if (g.ok) lines.push(`PASS ${g.label} (${g.pkg} ${g.version === 'unknown' ? 'version unknown' : g.version})`);
    else {
      failures += 1;
      lines.push(`FAIL ${g.label}: ${g.error}`);
    }
  }
  lines.push(failures === 0 && r.ok ? 'ALL PASS' : `${failures} language(s) FAILED. Send this output to K.`);
  return lines;
}

export function registerLanguagesCommand(program: Command): void {
  const cmd = program
    .command('languages')
    .description(
      'Check that each language grammar loads and parses. ' +
        'Parses a small snippet per language and prints PASS or FAIL for each; needs no repo, writes nothing; exit 1 when one fails',
    )
    .option('--json', 'print one JSON object instead of text')
    .action((opts: { json?: boolean }) => {
      const result = checkLanguages();
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else for (const line of formatLanguageCheck(result)) console.log(line);
      if (!result.ok) process.exitCode = 1;
    });
  addExamples(cmd, [
    'c4mp languages            PASS or FAIL per language',
    'c4mp languages --json     the same as one JSON object',
  ]);
}
