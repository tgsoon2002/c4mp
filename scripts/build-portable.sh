#!/usr/bin/env bash
# build-portable.sh
#
# Builds a self-contained, portable c4mp bundle: compiled dist/, viewer assets,
# and a production-only node_modules, zipped up so it can be copied anywhere
# and run with `node dist/bin/cli.js ...` without cloning the repo or running
# `npm install` there.
#
# Usage:
#   scripts/build-portable.sh [staging_dir] [output_zip]
#
#   staging_dir   Where to stage the bundle before zipping. Default: a fresh
#                 temp dir under $TMPDIR (mktemp).
#   output_zip    Path to write the final zip to. Default:
#                 <project_dir>/out/portable/c4mp-portable-<version>.zip
#
# Env (optional): C4MP_BUNDLE_README = README file to use instead of portable-README.md;
#                 C4MP_BUNDLE_EXTRA = one extra file copied to the bundle root (made executable);
#                 C4MP_BUNDLE_SCRIPT = one extra file copied to the bundle's scripts/ folder.
#                 (the old C4PM_BUNDLE_* names are read too; the C4MP_ one wins)
#
# Steps:
#   1. rm -rf dist, then npm run build (in the project dir): tsc never deletes old output, so stale
#      dist/ files of moved or deleted sources would ship in the bundle
#   2. stage dist/, package.json, package-lock.json, viewer/, guide/, CHANGELOG.md, LICENSE into staging_dir;
#      the staged dist/ loses its *.map files and their sourceMappingURL comments (they show the src/ layout;
#      the repo's dist/ keeps them for dev and tests)
#   3. npm install --omit=dev --ignore-scripts inside staging_dir, then `npm rebuild`
#      the packages whose install scripts are needed (scripts/install-scripts.js), and
#      prune the build-only ones (tree-sitter-cli: no GitHub download, smaller zip)
#   4. prune empty @scope directories left behind in node_modules (run twice —
#      removing the one empty child of an @scope dir can leave the now-empty
#      @scope dir itself behind, which needs a second pass to catch)
#      then write THIRD-PARTY-NOTICES.txt (licences of the staged packages, scripts/third-party-notices.js)
#   5. copy in the portable-bundle README
#   6. zip it up
#
# Every step logs what it's doing and what it found, so a human or another
# agent can verify the run by reading the output, not just trusting the exit
# code.

set -euo pipefail

log() {
  echo "[build-portable] $*"
}

die() {
  echo "[build-portable] ERROR: $*" >&2
  exit 1
}

# strip_source_maps <dir>: delete every *.map under <dir> and the trailing `//# sourceMappingURL=` line of every .js
# there (tmp file + cat back: works with BSD and GNU sed, keeps the file mode). Logs the counts.
strip_source_maps() {
  local DIR="$1" MAPS COMMENTS=0 F
  MAPS="$(find "$DIR" -type f -name '*.map' | wc -l | tr -d ' ')"
  find "$DIR" -type f -name '*.map' -delete
  while IFS= read -r F; do
    if tail -n 1 "$F" | grep -q '^//# sourceMappingURL='; then
      sed '$ { /^\/\/# sourceMappingURL=/d; }' "$F" > "$F.tmp" || die "sed failed on $F"
      cat "$F.tmp" > "$F" || die "rewriting $F failed"
      rm -f "$F.tmp"
      COMMENTS=$((COMMENTS + 1))
    fi
  done < <(find "$DIR" -type f -name '*.js')
  [ -z "$(find "$DIR" -name '*.map')" ] || die "source maps remain under $DIR"
  log "removed $MAPS source map files and $COMMENTS sourceMappingURL comments from $DIR"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=names.sh
. "$SCRIPT_DIR/names.sh"

log "project dir: $PROJECT_DIR"

if [ ! -f "$PROJECT_DIR/package.json" ]; then
  die "no package.json found at $PROJECT_DIR — is this script still inside Project/scripts/?"
fi

VERSION="$(node -p "require('$PROJECT_DIR/package.json').version" 2>/dev/null || echo "0.0.0")"
log "$C4MP_NAME version: $VERSION"

STAGING_DIR="${1:-}"
if [ -z "$STAGING_DIR" ]; then
  STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${C4MP_NAME}-portable.XXXXXX")"
  log "no staging_dir given — using fresh temp dir: $STAGING_DIR"
else
  STAGING_DIR="$(mkdir -p "$STAGING_DIR" && cd "$STAGING_DIR" && pwd)"
  log "staging dir: $STAGING_DIR"
  if [ -n "$(ls -A "$STAGING_DIR" 2>/dev/null)" ]; then
    die "staging dir $STAGING_DIR is not empty — pass a clean/empty directory"
  fi
fi

OUTPUT_ZIP="${2:-}"
if [ -z "$OUTPUT_ZIP" ]; then
  mkdir -p "$PROJECT_DIR/out/portable"
  OUTPUT_ZIP="$PROJECT_DIR/out/portable/${C4MP_NAME}-portable-$VERSION.zip"
fi
log "output zip: $OUTPUT_ZIP"

# ---------------------------------------------------------------------------
log "== step 1/6: rm -rf dist, npm run build =="
rm -rf "$PROJECT_DIR/dist"
(cd "$PROJECT_DIR" && npm run build)
[ -d "$PROJECT_DIR/dist" ] || die "npm run build did not produce $PROJECT_DIR/dist"
log "build OK — dist/ present"

# ---------------------------------------------------------------------------
log "== step 2/6: stage files into $STAGING_DIR =="
cp -R "$PROJECT_DIR/dist" "$STAGING_DIR/dist"
log "copied dist/"
strip_source_maps "$STAGING_DIR/dist"
cp "$PROJECT_DIR/package.json" "$STAGING_DIR/package.json"
log "copied package.json"
cp "$PROJECT_DIR/package-lock.json" "$STAGING_DIR/package-lock.json"
log "copied package-lock.json"
cp -R "$PROJECT_DIR/viewer" "$STAGING_DIR/viewer"
log "copied viewer/"
cp -R "$PROJECT_DIR/guide" "$STAGING_DIR/guide"
log "copied guide/"
cp "$PROJECT_DIR/CHANGELOG.md" "$STAGING_DIR/CHANGELOG.md"
log "copied CHANGELOG.md"
[ -f "$PROJECT_DIR/LICENSE" ] || die "no LICENSE at $PROJECT_DIR/LICENSE (the bundle must carry the licence)"
cp "$PROJECT_DIR/LICENSE" "$STAGING_DIR/LICENSE"
log "copied LICENSE"

# ---------------------------------------------------------------------------
log "== step 3/6: npm install --omit=dev in staging dir (install scripts of build-only packages skipped) =="
(cd "$STAGING_DIR" && npm install --omit=dev --ignore-scripts)
[ -d "$STAGING_DIR/node_modules" ] || die "npm install did not produce node_modules in $STAGING_DIR"
REBUILD="$(node "$SCRIPT_DIR/install-scripts.js" "$STAGING_DIR" --omit-dev)"
log "running install scripts of: ${REBUILD:-<none>}"
# shellcheck disable=SC2086 # word splitting intended: one package name per word (empty: plain `npm rebuild` would run them all)
if [ -n "$REBUILD" ]; then (cd "$STAGING_DIR" && npm rebuild $REBUILD); fi
BUILD_ONLY="$(node "$SCRIPT_DIR/install-scripts.js" "$STAGING_DIR" --omit-dev --build-only)"
for PKG in $BUILD_ONLY; do
  rm -rf "${STAGING_DIR:?}/node_modules/$PKG"
  log "pruned build-only package $PKG (grammar build tool, not needed to run)"
done
# bin links of the pruned packages
find "$STAGING_DIR/node_modules/.bin" -type l ! -exec test -e {} \; -print -delete 2>/dev/null || true
MODULE_COUNT="$(find "$STAGING_DIR/node_modules" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')"
log "node_modules populated — $MODULE_COUNT top-level entries"

# ---------------------------------------------------------------------------
log "== step 4/6: prune empty @scope directories (two passes) =="
log "pass 1:"
find "$STAGING_DIR/node_modules" -mindepth 1 -maxdepth 2 -type d -empty -print -delete
log "pass 2 (catches @scope dirs left empty after pass 1 removed their only child):"
find "$STAGING_DIR/node_modules" -mindepth 1 -maxdepth 2 -type d -empty -print -delete

REMAINING_EMPTY="$(find "$STAGING_DIR/node_modules" -mindepth 1 -maxdepth 2 -type d -empty | wc -l | tr -d ' ')"
if [ "$REMAINING_EMPTY" -ne 0 ]; then
  die "$REMAINING_EMPTY empty directories remain under node_modules after two prune passes"
fi
log "confirmed: zero empty directories remain under node_modules"

log "== notices: THIRD-PARTY-NOTICES.txt from the staged node_modules =="
node "$SCRIPT_DIR/third-party-notices.js" "$STAGING_DIR/node_modules" > "$STAGING_DIR/THIRD-PARTY-NOTICES.txt" || die "third-party-notices.js failed"

# ---------------------------------------------------------------------------
log "== step 5/6: copy in portable README =="
BUNDLE_README="$(c4mp_env BUNDLE_README)"
BUNDLE_EXTRA="$(c4mp_env BUNDLE_EXTRA)"
BUNDLE_SCRIPT="$(c4mp_env BUNDLE_SCRIPT)"
README_SRC="${BUNDLE_README:-$SCRIPT_DIR/portable-README.md}"
cp "$README_SRC" "$STAGING_DIR/README.md"
log "copied $README_SRC -> README.md"
if [ -n "$BUNDLE_EXTRA" ]; then
  cp "$BUNDLE_EXTRA" "$STAGING_DIR/"
  chmod +x "$STAGING_DIR/$(basename "$BUNDLE_EXTRA")"
  log "copied extra file $BUNDLE_EXTRA"
fi
if [ -n "$BUNDLE_SCRIPT" ]; then
  mkdir -p "$STAGING_DIR/scripts"
  cp "$BUNDLE_SCRIPT" "$STAGING_DIR/scripts/"
  log "copied script $BUNDLE_SCRIPT -> scripts/$(basename "$BUNDLE_SCRIPT")"
fi

# ---------------------------------------------------------------------------
log "== step 6/6: zip the bundle =="
rm -f "$OUTPUT_ZIP"
mkdir -p "$(dirname "$OUTPUT_ZIP")"
(cd "$STAGING_DIR" && zip -rq "$OUTPUT_ZIP" .)
ZIP_SIZE="$(du -h "$OUTPUT_ZIP" | cut -f1)"
log "wrote $OUTPUT_ZIP ($ZIP_SIZE)"

log "done. staging dir left at: $STAGING_DIR (delete it yourself when done inspecting)"
log "bundle zip: $OUTPUT_ZIP"
