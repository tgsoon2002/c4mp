#!/usr/bin/env bash
# make-release.sh: build one release folder <Release>/<version>/ holding the zip and the binaries.
# Usage: make-release.sh   (no options)
# Env:   C4MP_RELEASE_DIR (default <repo>/Release). The folder must exist; it is never created.
#        C4MP_RELEASE_TARGETS (space-separated; default all four: bun-darwin-arm64 bun-darwin-x64 bun-linux-x64
#        bun-windows-x64). Each value must be one of those four, named once. Example, macOS + Linux only:
#        C4MP_RELEASE_TARGETS="bun-darwin-arm64 bun-darwin-x64 bun-linux-x64"
#        (every C4MP_* variable here is also read under its old C4PM_* name; the C4MP_ one wins. Names: scripts/names.sh)
# Layout: <Release>/<version>/c4mp_<version>_<YYYYMMDD-HHMM>.zip
#         <Release>/<version>/c4mp-<version>-darwin-arm64, -darwin-x64, -linux-x64, -windows-x64.exe (those in the list)
#         <Release>/<version>/THIRD-PARTY-NOTICES.txt (the zip's notices plus the Bun runtime section)
#         <Release>/<version>/install.sh, install.ps1 (one-line installers, copied from scripts/; install.ps1 only
#         when bun-windows-x64 is in the list)
#         <Release>/<version>/LICENSE (Apache-2.0, copied from Project/LICENSE)
#         <Release>/<version>/SHA256SUMS (scripts/sha256sums.sh: one sha256 line per file, written last)
#   <Release>/<version>/ is created (plain mkdir) when missing. Inside it only c4mp_<version>_*.zip,
#   c4mp-<version>-* binaries, THIRD-PARTY-NOTICES.txt, install.sh, install.ps1 (with bun-windows-x64), LICENSE,
#   SHA256SUMS and .DS_Store may exist, before and after the run; anything else stops the run.
# The darwin-x64 binary (when in the list) is self-tested under Rosetta when this Mac has it (`arch -x86_64`);
#   otherwise not run.
#   Other items at the <Release> root are never checked or touched. Nothing is ever overwritten or deleted.
# A failing binary build stops the run; the zip already moved into <Release>/<version>/ stays.
# Never runs npm publish, npm install -g or npm link.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=names.sh
. "$SCRIPT_DIR/names.sh"
REPO_DIR="$(c4mp_top "$PROJECT_DIR")"
# Binary targets a release can build (one build-binary.sh call each); C4MP_RELEASE_TARGETS picks some of them.
KNOWN_TARGETS="bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-windows-x64"
TARGETS="$(c4mp_env RELEASE_TARGETS)"
TARGETS="${TARGETS:-$KNOWN_TARGETS}"
log() { echo "[make-release] $*"; }
die() { echo "[make-release] ERROR: $*" >&2; exit 1; }
# has_target <target>: true when <target> is in TARGETS.
has_target() { case " $TARGETS " in *" $1 "*) return 0 ;; esac; return 1; }
# Every word of TARGETS is one of KNOWN_TARGETS, named once, and there is at least one; else die naming the known list.
check_targets() {
  local T SEEN=" "
  [ -n "${TARGETS// /}" ] || die "C4MP_RELEASE_TARGETS names no target (known: $KNOWN_TARGETS)"
  for T in $TARGETS; do
    case " $KNOWN_TARGETS " in *" $T "*) ;; *) die "unknown target $T in C4MP_RELEASE_TARGETS (known: $KNOWN_TARGETS)" ;; esac
    case "$SEEN" in *" $T "*) die "target $T named twice in C4MP_RELEASE_TARGETS (known: $KNOWN_TARGETS)" ;; esac
    SEEN="$SEEN$T "
  done
}
check_targets
log "targets: $TARGETS"
# install.ps1 ships (and is allowed in the version folder) only with the Windows binary.
WINDOWS=""
has_target bun-windows-x64 && WINDOWS=yes
for TOOL in zip unzip node npm tar; do
  command -v "$TOOL" >/dev/null 2>&1 || die "$TOOL not found on PATH (need zip, unzip, node, npm, tar)"
done
REL="$(c4mp_env RELEASE_DIR)"
REL="${REL:-$REPO_DIR/Release}"
[ -d "$REL" ] || die "release folder $REL does not exist (never created by this script)"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
OUT="$REL/$VERSION"
# Bun version of the binaries, single source: build-binary.sh.
BUN_VERSION="$(sed -n 's/^BUN_VERSION="\(.*\)"$/\1/p' "$SCRIPT_DIR/build-binary.sh")"
[ -n "$BUN_VERSION" ] || die "BUN_VERSION not found in build-binary.sh"
# The changelog must have a section for this version before anything is built.
grep -q "^## ${VERSION} (" "$PROJECT_DIR/CHANGELOG.md" 2>/dev/null || die "CHANGELOG.md has no '## ${VERSION} (date)' section (write the release notes first)"
# Items in OUT that are not this version's zip, binary, notices file, install script, LICENSE, SHA256SUMS (regular files)
# or .DS_Store.
stray() {
  [ -d "$OUT" ] || return 0
  find "$OUT" -mindepth 1 -maxdepth 1 \( ! -type f -o \( ! -name "${C4MP_NAME}_${VERSION}_*.zip" ! -name "${C4MP_NAME}-${VERSION}-*" ! -name 'THIRD-PARTY-NOTICES.txt' ! -name 'install.sh' ${WINDOWS:+! -name 'install.ps1'} ! -name 'LICENSE' ! -name 'SHA256SUMS' ! -name '.DS_Store' \) \)
}
[ ! -e "$OUT" ] || [ -d "$OUT" ] || die "$OUT exists and is not a folder (nothing deleted)"
LEFT="$(stray)"
[ -z "$LEFT" ] || die "version folder holds items that are not a zip, binary, notices file, install script, LICENSE or SHA256SUMS of $VERSION (nothing deleted): $LEFT"
# SHA256SUMS, the install scripts and LICENSE are written last and never overwritten: refuse before building rather than after.
[ ! -e "$OUT/SHA256SUMS" ] || die "$OUT/SHA256SUMS already exists (not overwritten)"
for F in install.sh ${WINDOWS:+install.ps1} LICENSE; do
  [ ! -e "$OUT/$F" ] || die "$OUT/$F already exists (not overwritten)"
done
STAMP="$(date +%Y%m%d-%H%M)"
NAME="$(c4mp_zip_name "$VERSION" "$STAMP")"
[ ! -e "$OUT/$NAME" ] || die "$OUT/$NAME already exists (not overwritten)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/${C4MP_NAME}-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. Zip.
log "building $NAME in $TMP"
C4MP_BUNDLE_README="$SCRIPT_DIR/release-README.md" C4MP_BUNDLE_EXTRA="$SCRIPT_DIR/release-install.sh" C4MP_BUNDLE_SCRIPT="$SCRIPT_DIR/grammar-smoke.js" "$SCRIPT_DIR/build-portable.sh" "$TMP/stage" "$TMP/$NAME"
[ -f "$TMP/$NAME" ] || die "build produced no zip at $TMP/$NAME"
unzip -Z1 "$TMP/$NAME" > "$TMP/list.txt"
for F in release-install.sh README.md CHANGELOG.md LICENSE package.json scripts/grammar-smoke.js THIRD-PARTY-NOTICES.txt; do
  grep -qx "$F" "$TMP/list.txt" || die "zip lacks $F"
done
ZVER="$(unzip -p "$TMP/$NAME" package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
[ "$ZVER" = "$VERSION" ] || die "zip package.json version $ZVER differs from $VERSION"
[ -d "$OUT" ] || mkdir "$OUT" || die "cannot create $OUT"
[ ! -e "$OUT/$NAME" ] || die "$OUT/$NAME already exists (not overwritten)"
mv "$TMP/$NAME" "$OUT/$NAME"
unzip -tq "$OUT/$NAME" >/dev/null || die "zip failed test (not deleted)"
log "release zip: $OUT/$NAME"

# 2. Binaries, one at a time; each build gets its own scratch release folder.
for T in $TARGETS; do
  S="$TMP/bin-$T"
  mkdir "$S"
  log "building binary $T"
  C4MP_RELEASE_DIR="$S" "$SCRIPT_DIR/build-binary.sh" --target "$T" || die "binary build $T failed (zip stays in $OUT)"
  FILES="$(find "$S/binaries" -mindepth 1 -maxdepth 1)"
  [ -n "$FILES" ] || die "binary build $T produced no file in $S/binaries"
  [ "$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')" = "1" ] || die "binary build $T produced more than one file: $FILES"
  B="$(basename "$FILES")"
  [ ! -e "$OUT/$B" ] || die "$OUT/$B already exists (not overwritten)"
  mv "$FILES" "$OUT/$B"
  log "binary: $OUT/$B"
done

# 2b. The Intel Mac binary is a cross build (build-binary.sh self-tests only the native one): run it under Rosetta.
X64="$OUT/$(c4mp_binary_name "$VERSION" darwin-x64)"
if ! has_target bun-darwin-x64; then
  log "bun-darwin-x64 is not in the target list: no Rosetta self-test"
elif arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
  log "self-test of $X64 under Rosetta"
  arch -x86_64 "$SCRIPT_DIR/binary-selftest.sh" "$X64" || die "darwin-x64 self-test failed under Rosetta (binary stays in $OUT)"
  log "darwin-x64 self-test under Rosetta: PASS"
else
  log "NOTE: arch -x86_64 does not work on this machine (no Rosetta); the darwin-x64 self-test was NOT run"
fi

# 3. Notices beside the binaries: the zip's notices plus the Bun runtime they embed.
N="$OUT/THIRD-PARTY-NOTICES.txt"
[ ! -e "$N" ] || die "$N already exists (not overwritten)"
{ unzip -p "$OUT/$NAME" THIRD-PARTY-NOTICES.txt; echo; node "$SCRIPT_DIR/third-party-notices.js" --bun-section "$BUN_VERSION"; } > "$N" || die "notices for the binaries failed"
log "notices: $N"

# 3b. The one-line installers, before the checksums so SHA256SUMS lists them too (install.ps1 with the Windows binary).
for F in install.sh ${WINDOWS:+install.ps1}; do
  [ ! -e "$OUT/$F" ] || die "$OUT/$F already exists (not overwritten)"
done
cp "$SCRIPT_DIR/install.sh" "$OUT/install.sh" || die "copying install.sh failed"
log "install script: $OUT/install.sh"
if [ -n "$WINDOWS" ]; then
  # Windows binary in the list: its installer ships beside it.
  cp "$SCRIPT_DIR/install.ps1" "$OUT/install.ps1" || die "copying install.ps1 failed"
  log "install script: $OUT/install.ps1"
fi

# 3c. The licence beside the binaries, before the checksums so SHA256SUMS lists it too.
[ ! -e "$OUT/LICENSE" ] || die "$OUT/LICENSE already exists (not overwritten)"
[ -f "$PROJECT_DIR/LICENSE" ] || die "no LICENSE at $PROJECT_DIR/LICENSE"
cp "$PROJECT_DIR/LICENSE" "$OUT/LICENSE" || die "copying LICENSE failed"
log "licence: $OUT/LICENSE"

# 4. Checksums of every file in OUT, last (sha256sums.sh refuses an existing SHA256SUMS).
"$SCRIPT_DIR/sha256sums.sh" "$OUT" || die "SHA256SUMS failed"
log "checksums: $OUT/SHA256SUMS"

LEFT="$(stray)"
[ -z "$LEFT" ] || die "version folder now holds items that are not a zip, binary, notices file, install script, LICENSE or SHA256SUMS of $VERSION: $LEFT"
log "release folder: $OUT"
ls -l "$OUT"
