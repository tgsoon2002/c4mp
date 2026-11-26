import { Component, Container } from '../types';
import { toId, toDisplayName } from '../names';
import { log } from '../log';

/**
 * Folder-mode components: one per first folder below each container's source root. Phase 26 (T26-14b, D9):
 * `testFiles` = the scan's role-test files; a folder whose files are all tests (a test folder) forms no component, so
 * its files are in no component (the snapshot gives them componentId 'unassigned'). A test file beside source files
 * stays in that folder's component, and test files still count for the source root.
 */
export function groupComponents(files: string[], containers: Container[], testFiles: readonly string[] = []): Component[] {
  // Step 1: For each file, find the container with the longest matching path prefix
  const fileToContainerMap = new Map<string, string>();

  for (const file of files) {
    let longestContainer: Container | null = null;
    let longestLength = -1;

    for (const container of containers) {
      const matchPath = container.path === '.' ? '' : container.path + '/';
      if (matchPath === '' || file.startsWith(matchPath)) {
        const matchLength = matchPath.length;
        if (matchLength > longestLength) {
          longestLength = matchLength;
          longestContainer = container;
        }
      }
    }

    if (longestContainer) {
      fileToContainerMap.set(file, longestContainer.id);
    }
  }

  // Step 2: Group files by container and determine sourceRoot
  const containerFiles = new Map<string, string[]>();
  const sourceRootByContainer = new Map<string, string>();

  for (const file of files) {
    const containerId = fileToContainerMap.get(file);
    if (!containerId) continue;

    if (!containerFiles.has(containerId)) {
      containerFiles.set(containerId, []);
    }
    containerFiles.get(containerId)!.push(file);
  }

  // For each container, determine sourceRoot
  for (const [containerId, containerFiles_] of containerFiles) {
    const container = containers.find(c => c.id === containerId);
    if (!container) continue;

    // Check if any file is under src/
    let hasSourceRoot = false;
    for (const file of containerFiles_) {
      const rel = container.path === '.' ? file : file.slice(container.path.length + 1);
      if (rel.startsWith('src/')) {
        hasSourceRoot = true;
        break;
      }
    }

    if (hasSourceRoot) {
      sourceRootByContainer.set(containerId, 'src');
      log('components', 'sourceRoot', { containerId, sourceRoot: 'src', reason: 'file under src/' });
    } else {
      // Check if all files in subfolders share the same first segment
      const firstSegments = new Set<string>();
      const subfolderFiles: string[] = [];

      for (const file of containerFiles_) {
        const rel = container.path === '.' ? file : file.slice(container.path.length + 1);

        // If file has a slash, it's in a subfolder - extract first segment
        if (rel.includes('/')) {
          const firstSegment = rel.split('/')[0];
          firstSegments.add(firstSegment);
          subfolderFiles.push(rel);
        }
      }

      // If all subfolder files share exactly one first segment AND stripping it preserves structure
      if (firstSegments.size === 1 && subfolderFiles.length > 0) {
        const potentialSourceRoot = Array.from(firstSegments)[0];

        // Check if stripping potentialSourceRoot would preserve meaningful structure
        // i.e., at least one file would still have nested folders
        let hasNestedStructure = false;
        for (const file of subfolderFiles) {
          const afterStrip = file.slice(potentialSourceRoot.length + 1);
          if (afterStrip.includes('/')) {
            hasNestedStructure = true;
            break;
          }
        }

        if (hasNestedStructure) {
          sourceRootByContainer.set(containerId, potentialSourceRoot);
          log('components', 'sourceRoot', { containerId, sourceRoot: potentialSourceRoot, reason: 'all subfolder files share same first segment with preserved structure' });
        } else {
          sourceRootByContainer.set(containerId, '');
          log('components', 'sourceRoot', { containerId, sourceRoot: '', reason: 'shared first segment would lose all structure' });
        }
      } else {
        // No files in subfolders, or multiple different first segments
        sourceRootByContainer.set(containerId, '');
        const reason = firstSegments.size === 0 ? 'no files in subfolders' : `${firstSegments.size} different first segments`;
        log('components', 'sourceRoot', { containerId, sourceRoot: '', reason });
      }
    }
  }

  // Step 3: For each file, calculate folder and create component id
  const componentMap = new Map<string, { component: Omit<Component, 'files'>, files: Set<string> }>();

  for (const file of files) {
    const containerId = fileToContainerMap.get(file);
    if (!containerId) continue;

    const container = containers.find(c => c.id === containerId);
    if (!container) continue;

    const sourceRoot = sourceRootByContainer.get(containerId) || '';

    // Calculate rel (relative to container path)
    const rel = container.path === '.' ? file : file.slice(container.path.length + 1);

    // Strip sourceRoot + '/'
    let remainder = rel;
    if (sourceRoot && remainder.startsWith(sourceRoot + '/')) {
      remainder = remainder.slice(sourceRoot.length + 1);
    }

    // Calculate folder
    const folder = remainder.includes('/') ? remainder.split('/')[0] : '_root';

    // Calculate id and name
    const folderId = folder === '_root' ? '_root' : toId(folder);
    const id = `${containerId}/${folderId}`;
    const name = folder === '_root' ? 'Root files' : toDisplayName(folder);

    // Calculate path
    let componentPath = container.path;

    // If sourceRoot is set and this file should be under it
    if (sourceRoot && (rel.startsWith(sourceRoot + '/') || folder === '_root')) {
      componentPath = componentPath === '.' ? sourceRoot : `${componentPath}/${sourceRoot}`;
    }

    // Add folder (subfolder under sourceRoot or container)
    if (folder !== '_root') {
      componentPath = componentPath === '.' ? folder : `${componentPath}/${folder}`;
    }

    // Normalize: remove leading './' and handle '.' → ''
    if (componentPath.startsWith('./')) {
      componentPath = componentPath.slice(2);
    } else if (componentPath === '.') {
      componentPath = '';
    }

    if (!componentMap.has(id)) {
      componentMap.set(id, {
        component: {
          id,
          name,
          containerId,
          path: componentPath,
        },
        files: new Set(),
      });
    }

    componentMap.get(id)!.files.add(file);
    log('components', 'file', { file, container: containerId, component: id });
  }

  // Step 4: Build final components array with sorted files, without test-only folders (Phase 26, D9)
  const tests = new Set(testFiles);
  const components: Component[] = [];
  for (const { component, files } of componentMap.values()) {
    if ([...files].every((f) => tests.has(f))) {
      log('components', 'skip test-only folder', { id: component.id, files: files.size });
      continue;
    }
    components.push({ ...component, files: Array.from(files).sort() });
  }

  // Step 5: Sort by id
  components.sort((a, b) => a.id.localeCompare(b.id));

  // Log results
  for (const component of components) {
    log('components', 'result', { id: component.id, files: component.files.length });
  }

  return components;
}
