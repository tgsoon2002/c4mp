import * as fs from 'fs';
import * as path from 'path';

// P22-7: the licence (Apache-2.0, Project/LICENSE) ships in the release zip and beside the binaries.

const project = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(project, rel), 'utf8');

describe('release licence', () => {
  const release = read('scripts/make-release.sh');
  const portable = read('scripts/build-portable.sh');

  it('make-release.sh checks the zip holds LICENSE', () => {
    const loop = /^for F in ([^;]*); do\n {2}grep -qx "\$F" "\$TMP\/list\.txt"/m.exec(release);
    expect(loop?.[1].split(' ')).toContain('LICENSE');
  });

  it('make-release.sh allows LICENSE in the version folder', () => {
    const stray = /^stray\(\) \{\n(?:.*\n)*?\}$/m.exec(release);
    expect(stray?.[0]).toContain("! -name 'LICENSE'");
  });

  it('make-release.sh copies LICENSE into OUT before SHA256SUMS, refusing an existing one up front', () => {
    const copy = release.indexOf('cp "$PROJECT_DIR/LICENSE" "$OUT/LICENSE"');
    const sums = release.indexOf('"$SCRIPT_DIR/sha256sums.sh" "$OUT"');
    const zip = release.indexOf('# 1. Zip.');
    // The up-front refusal: the loop over the files written last, before the zip is built.
    const upFront = /^for F in ([^;]*); do\n {2}\[ ! -e "\$OUT\/\$F" \] \|\| die/m.exec(release);
    expect(copy).toBeGreaterThan(-1);
    expect(sums).toBeGreaterThan(copy);
    expect(upFront?.[1].split(' ')).toContain('LICENSE');
    expect(upFront?.index).toBeLessThan(zip);
    expect(release.indexOf('[ ! -e "$OUT/LICENSE" ]')).toBeGreaterThan(upFront?.index ?? Infinity);
  });

  it('build-portable.sh copies LICENSE into the staging folder', () => {
    expect(portable).toContain('cp "$PROJECT_DIR/LICENSE" "$STAGING_DIR/LICENSE"');
  });

  it('package.json files lists LICENSE', () => {
    expect(JSON.parse(read('package.json')).files).toContain('LICENSE');
  });

  it('Project/LICENSE is the Apache-2.0 text and package.json says Apache-2.0', () => {
    expect(read('LICENSE')).toContain('Apache License\n                           Version 2.0, January 2004');
    expect(read('LICENSE')).not.toContain('Functional Source License');
    expect(JSON.parse(read('package.json')).license).toBe('Apache-2.0');
  });
});
