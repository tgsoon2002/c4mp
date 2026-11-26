import * as path from 'path';
import * as ts from 'typescript';
import { log } from '../../log';
import type { ResolveResult } from '../../types';
import { isSkippedFile, TARGET_IGNORED, unresolved } from '../resolveKit';

/** Import targets that are assets, not code (`import './app.css'`). */
export const ASSET_EXTENSIONS = ['.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.html', '.md', '.txt', '.json'];

export function createResolver(
  repoRoot: string,
  sourceFiles: string[]
): (fromFile: string, spec: string) => ResolveResult {
  const sourceFilesSet = new Set(sourceFiles);
  const configCache = new Map<string, ts.CompilerOptions>();

  function getCompilerOptions(fromFile: string): ts.CompilerOptions {
    const absFromFile = path.join(repoRoot, fromFile);
    let dir = path.dirname(absFromFile);

    // Walk up looking for tsconfig.json or jsconfig.json
    while (dir.startsWith(repoRoot) || dir === repoRoot) {
      const tsConfigPath = path.join(dir, 'tsconfig.json');
      const jsConfigPath = path.join(dir, 'jsconfig.json');

      // Check cache first
      if (configCache.has(tsConfigPath)) {
        return configCache.get(tsConfigPath)!;
      }
      if (configCache.has(jsConfigPath)) {
        return configCache.get(jsConfigPath)!;
      }

      // Try tsconfig.json first
      let configPath: string | null = null;
      let config: any = null;

      try {
        const tsContent = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
        if (!tsContent.error && tsContent.config) {
          configPath = tsConfigPath;
          config = tsContent.config;
        }
      } catch {
        // tsconfig.json doesn't exist or can't be read
      }

      // Try jsconfig.json if tsconfig.json not found
      if (!configPath) {
        try {
          const jsContent = ts.readConfigFile(jsConfigPath, ts.sys.readFile);
          if (!jsContent.error && jsContent.config) {
            configPath = jsConfigPath;
            config = jsContent.config;
          }
        } catch {
          // jsconfig.json doesn't exist or can't be read
        }
      }

      if (configPath && config) {
        const configDir = path.dirname(configPath);
        const parsed = ts.parseJsonConfigFileContent(
          config,
          ts.sys,
          configDir
        );
        // Always force allowJs: true
        parsed.options.allowJs = true;
        // Default moduleResolution to Node10 if undefined
        if (parsed.options.moduleResolution === undefined) {
          parsed.options.moduleResolution = ts.ModuleResolutionKind.Node10;
        }
        configCache.set(configPath, parsed.options);
        log('resolve', 'config', { fromFile, config: path.relative(repoRoot, configPath) });
        return parsed.options;
      }

      // Move up one directory
      const parentDir = path.dirname(dir);
      if (parentDir === dir) break; // reached filesystem root
      dir = parentDir;
    }

    // No config found, return defaults
    const defaultOptions: ts.CompilerOptions = {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    };
    configCache.set(repoRoot, defaultOptions);
    return defaultOptions;
  }

  return (fromFile: string, spec: string): ResolveResult => {
    // Step 1: Asset check
    const ext = path.extname(spec);
    if (ASSET_EXTENSIONS.includes(ext)) {
      log('resolve', 'asset', { from: fromFile, spec });
      return { status: 'asset' };
    }

    // Step 2 & 3: Use TypeScript's resolver
    const absFromFile = path.join(repoRoot, fromFile);
    const options = getCompilerOptions(fromFile);
    const resolved = ts.resolveModuleName(spec, absFromFile, options, ts.sys);
    const resolvedFileName = resolved.resolvedModule?.resolvedFileName;

    // Step 4: Check if it's internal
    if (resolvedFileName) {
      const rel = path.relative(repoRoot, resolvedFileName).split(path.sep).join('/');

      if (sourceFilesSet.has(rel) && !rel.includes('node_modules/')) {
        log('resolve', 'internal', { from: fromFile, spec, target: rel });
        return { status: 'internal', target: rel };
      }
    }

    // Step 5: Determine external, unresolved, or already handled asset
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      // Bare spec → external
      let pkg = spec;
      // Strip node: prefix
      if (pkg.startsWith('node:')) {
        pkg = pkg.slice(5);
      } else if (pkg.startsWith('@')) {
        // Scoped: @a/b/c → @a/b
        const parts = pkg.split('/');
        pkg = parts.slice(0, 2).join('/');
      } else {
        // First segment: lodash/fp → lodash
        const parts = pkg.split('/');
        pkg = parts[0];
      }
      log('resolve', 'external', { from: fromFile, spec, pkg });
      return { status: 'external', pkg };
    } else {
      // Relative or absolute spec that didn't resolve → unresolved (a repo file the scan skipped, such as
      // build/dts-plugins.ts, has its own reason)
      const target = resolvedFileName && path.relative(repoRoot, resolvedFileName).split(path.sep).join('/');
      const reason = target && isSkippedFile(repoRoot, sourceFilesSet, target) ? TARGET_IGNORED : 'path not found';
      log('resolve', 'unresolved', { from: fromFile, spec, reason });
      return unresolved(reason);
    }
  };
}
