#!/usr/bin/env bash
# build-binary.sh: build ONE single-file c4mp executable (Bun) into <Release>/binaries.
# Usage: build-binary.sh [--target bun-darwin-arm64|bun-darwin-x64|bun-linux-x64|bun-linux-arm64|bun-windows-x64]
#   Default target: the current platform.
# Env:   C4MP_RELEASE_DIR (default <repo>/Release; the old name C4PM_RELEASE_DIR is read too). The folder must exist; it is never created.
#        <Release>/binaries is created if missing. Existing files are never overwritten or deleted.
# Output: <Release>/binaries/c4mp-<version>-<target>[.exe], then the self-test runs (native target only).
# Never installs anything globally: Bun is installed with npm into the temporary build folder.
# Never signs or uploads. Build runs in a neutral copy in the fixed folder /tmp/c4mp-build-<target>,
# so the builder's home path never ends up inside the binary and every build embeds the same paths.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=names.sh
. "$SCRIPT_DIR/names.sh"
REPO_DIR="$(c4mp_top "$PROJECT_DIR")"
BUN_VERSION="1.4.4"
log() { echo "[build-binary] $*"; }
die() { echo "[build-binary] ERROR: $*" >&2; exit 1; }

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || die "--target needs a value"; TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (use --target <bun-darwin-arm64|bun-darwin-x64|bun-linux-x64|bun-linux-arm64|bun-windows-x64>)" ;;
  esac
done

for TOOL in node npm tar; do
  command -v "$TOOL" >/dev/null 2>&1 || die "$TOOL not found on PATH (need node, npm, tar)"
done

# Native target of this machine, in Bun's naming.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) NATIVE="bun-darwin-arm64" ;;
  Darwin-x86_64) NATIVE="bun-darwin-x64" ;;
  Linux-x86_64) NATIVE="bun-linux-x64" ;;
  Linux-aarch64|Linux-arm64) NATIVE="bun-linux-arm64" ;;
  MINGW*|MSYS*|CYGWIN*) NATIVE="bun-windows-x64" ;;
  *) NATIVE="" ;;
esac
TARGET="${TARGET:-$NATIVE}"
[ -n "$TARGET" ] || die "cannot detect the current platform; pass --target"
case "$TARGET" in
  bun-darwin-arm64|bun-darwin-x64|bun-linux-x64|bun-linux-arm64|bun-windows-x64) ;;
  *) die "target $TARGET not allowed (bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64, bun-windows-x64)" ;;
esac
EXT=""
[ "$TARGET" = "bun-windows-x64" ] && EXT=".exe"

REL="$(c4mp_env RELEASE_DIR)"
REL="${REL:-$REPO_DIR/Release}"
[ -d "$REL" ] || die "release folder $REL does not exist (never created by this script)"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
OUT_DIR="$REL/binaries"
OUT="$OUT_DIR/$(c4mp_binary_name "$VERSION" "${TARGET#bun-}")${EXT}"
[ ! -e "$OUT" ] || die "$OUT already exists (not overwritten)"

TMP="/tmp/${C4MP_NAME}-build-${TARGET#bun-}"
[ ! -e "$TMP" ] || die "build folder $TMP exists (another build is running, or one was killed). If none is running: rm -rf \"$TMP\""
mkdir "$TMP" || die "cannot create build folder $TMP"
# Trap set only after the mkdir: a refused run never deletes a folder it did not create.
trap 'rm -rf "$TMP"' EXIT
log "target $TARGET, version $VERSION, build folder $TMP"

# 1. Neutral copy of the project: sources, viewer, guide, lock file. No node_modules, dist, tests or try-* scripts.
mkdir "$TMP/p"
(cd "$PROJECT_DIR" && tar -cf - package.json package-lock.json tsconfig.json tsconfig.build.json bin src viewer guide) | (cd "$TMP/p" && tar -xf -)

# 2. Real node_modules (a symlink would break the embedded native files). Dev dependencies are needed
#    for tsc (@types/node); the bundle only contains what the entry imports. Install scripts run only for the
#    packages that need them (scripts/install-scripts.js): build-only tree-sitter-cli never downloads its executable.
log "npm ci --ignore-scripts"
(cd "$TMP/p" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) || die "npm ci failed"
REBUILD="$(node "$SCRIPT_DIR/install-scripts.js" "$TMP/p")" || die "install-scripts.js failed"
log "running install scripts of: ${REBUILD:-<none>}"
# shellcheck disable=SC2086 # word splitting intended: one package name per word (empty: plain `npm rebuild` would run them all)
if [ -n "$REBUILD" ]; then (cd "$TMP/p" && npm rebuild --loglevel=error $REBUILD) || die "npm rebuild failed"; fi
for PKG in $(node "$SCRIPT_DIR/install-scripts.js" "$TMP/p" --build-only); do
  [ -z "$(find "$TMP/p/node_modules/$PKG" -maxdepth 1 -type f -perm -u+x ! -name '*.js')" ] || die "build-only $PKG ran its install script (downloaded executable found)"
  log "build-only $PKG: install script skipped"
done

# 3. Build-time patch of tree-sitter in the COPIED node_modules (see patch-tree-sitter.js: strict-ESM fix and
#    static native requires, so the .node files are embedded and the binary does not look in the build folder).
case "$TARGET" in
  bun-windows-x64) PREBUILD_PLAT="win32-x64" ;;
  *) PREBUILD_PLAT="${TARGET#bun-}" ;;
esac
log "patching tree-sitter for $PREBUILD_PLAT"
node "$SCRIPT_DIR/patch-tree-sitter.js" "$TMP/p/node_modules" "$PREBUILD_PLAT" || die "tree-sitter patch failed"

# 4. Compile TypeScript to dist/ (dist/bin/cli.js is the entry).
log "tsc build"
(cd "$TMP/p" && npx tsc -p tsconfig.build.json) || die "tsc build failed"
[ -f "$TMP/p/dist/bin/cli.js" ] || die "tsc produced no dist/bin/cli.js"

# 5. Bun, installed locally in the build folder.
log "installing bun@$BUN_VERSION locally"
mkdir "$TMP/bun"
(cd "$TMP/bun" && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error "bun@$BUN_VERSION") || die "bun install failed"
BUN="$TMP/bun/node_modules/.bin/bun"
[ -x "$BUN" ] || die "bun binary not found at $BUN"

# 6. Compile. Assets viewer/ and guide/ are embedded beside the entry (found by assets.ts via process.argv[1]).
mkdir -p "$TMP/out"
log "bun build --compile --target $TARGET (downloads the Bun runtime for a non-native target)"
(cd "$TMP/p" && "$BUN" build --compile --minify --sourcemap=none --target="$TARGET" \
  --asset viewer --asset guide \
  --outfile "$TMP/out/${C4MP_NAME}${EXT}" dist/bin/cli.js) || die "bun build failed"
[ -f "$TMP/out/${C4MP_NAME}${EXT}" ] || die "bun build produced no executable"

# 7. Hygiene checks. The Bun runtime inside the executable has its own "sourceMappingURL" strings, so the
#    source map check looks at the JavaScript bundle (same entry and flags, no --compile) instead.
log "checking the bundle for source map comments"
(cd "$TMP/p" && "$BUN" build --minify --sourcemap=none --target=bun --outdir "$TMP/bundle" dist/bin/cli.js >/dev/null) || die "bundle check build failed"
if grep -aqE '^//[#@] sourceMappingURL=' "$TMP/bundle/cli.js"; then die "bundle ends with a sourceMappingURL comment"; fi
if [ -n "$(find "$TMP/bundle" -name '*.map' -o -name '*.d.ts')" ]; then die "a source map or .d.ts file was written"; fi
if [ -n "${HOME:-}" ] && grep -aqF "$HOME" "$TMP/out/${C4MP_NAME}${EXT}"; then die "binary contains the builder's home path $HOME"; fi
if grep -aqE "(${C4MP_NAME}|${C4MP_LEGACY_NAME})-build\.[A-Za-z0-9]{6}" "$TMP/out/${C4MP_NAME}${EXT}"; then die "binary contains a random build path (${C4MP_NAME}-build.XXXXXX)"; fi

mkdir -p "$OUT_DIR"
mv "$TMP/out/${C4MP_NAME}${EXT}" "$OUT"
chmod +x "$OUT"
log "binary: $OUT"
ls -l "$OUT"

# 8. Self-test, native target only.
if [ "$TARGET" = "$NATIVE" ]; then
  log "running self-test"
  "$SCRIPT_DIR/binary-selftest.sh" "$OUT"
else
  log "NOTE: $TARGET is not the native target ($NATIVE); this cross build was NOT run or self-tested here. Run scripts/binary-selftest.sh on a matching machine."
fi
