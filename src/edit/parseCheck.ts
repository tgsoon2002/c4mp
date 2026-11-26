/**
 * Phase 32 (ED-1, D6): the number of parse errors in a tree (ERROR plus MISSING nodes). An edit is refused when
 * this count goes up. One implementation, in the language kit: `defineLanguage`'s `retryMacros` uses it too (b573).
 */
export { parseErrorCount } from '../languages/treesitter';
