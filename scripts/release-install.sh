#!/usr/bin/env bash
# Runs inside the unzipped c4mp folder. npm link + version check. No sudo.
# Env: C4MP_SKIP_LINK=1 (only check bundle version), C4MP_ASSUME_YES=1 (replace a different version without asking).
#      The old names C4PM_SKIP_LINK and C4PM_ASSUME_YES are still read (the C4MP_ name wins).
# The command name is inline (this file ships alone in the zip root, so it cannot source scripts/names.sh): keep
# C4MP_NAME equal to names.sh, and equal to a `bin` key of package.json (npm link creates that command).
set -euo pipefail
C4MP_NAME=c4mp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[release-install] $*"; }
fail() { echo "[release-install] FAIL: $*" >&2; exit 1; }
real_path() { node -p "require('fs').realpathSync(process.argv[1])" "$1"; }
# envv <SUFFIX>: C4MP_<SUFFIX> when set and not empty, else the old C4PM_<SUFFIX>, else empty.
envv() {
  local v=""
  eval "v=\"\${C4MP_$1:-}\""
  if [ -z "$v" ]; then eval "v=\"\${C4PM_$1:-}\""; fi
  printf '%s' "$v"
}
command -v node >/dev/null 2>&1 || fail "node not found on PATH (need Node 20+)"
command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"
cd "$HERE"
[ -f package.json ] && [ -f dist/bin/cli.js ] || fail "run this from the unzipped $C4MP_NAME folder"
BUNDLE="$(node -p "require('./package.json').version")" || fail "cannot read bundle version"
log "bundle version: $BUNDLE"
if [ "$(envv SKIP_LINK)" = "1" ]; then
  log "C4MP_SKIP_LINK=1: npm link skipped (test mode)"
  GOT="$(node dist/bin/cli.js --version)" || fail "$C4MP_NAME --version crashed"
else
  OLD_BIN="$(command -v "$C4MP_NAME" 2>/dev/null || true)"
  if [ -z "$OLD_BIN" ]; then
    FALLBACK_PREFIX="$(npm prefix -g)" || fail "npm prefix -g failed"
    FALLBACK="$FALLBACK_PREFIX/bin/$C4MP_NAME"
    if [ -x "$FALLBACK" ]; then OLD_BIN="$FALLBACK"; fi
  fi
  if [ -z "$OLD_BIN" ]; then
    log "no existing global $C4MP_NAME found; installing"
  else
    OLD_VER="$("$OLD_BIN" --version 2>/dev/null)" || OLD_VER="unknown"
    OLD_REAL="$(real_path "$OLD_BIN")" || OLD_REAL="$OLD_BIN"
    if [ "$OLD_VER" = "$BUNDLE" ]; then
      echo "Already installed: $C4MP_NAME $OLD_VER is the same as this bundle."
      echo "Location: $OLD_REAL"
      log "SAME: nothing changed"
      exit 0
    fi
    echo "Existing $C4MP_NAME version: $OLD_VER"
    echo "Existing $C4MP_NAME location: $OLD_REAL"
    echo "This bundle version: $BUNDLE"
    if [ ! -t 0 ] && [ "$(envv ASSUME_YES)" != "1" ]; then
      echo "Different version found; run again in a terminal or set C4MP_ASSUME_YES=1" >&2
      exit 1
    fi
    if [ "$(envv ASSUME_YES)" = "1" ]; then
      log "C4MP_ASSUME_YES=1: replacing without asking"
    else
      printf 'Replace existing %s %s with %s? [y/N] ' "$C4MP_NAME" "$OLD_VER" "$BUNDLE"
      read -r ANSWER || ANSWER=""
      case "$ANSWER" in
        y|Y) ;;
        *) echo "Not replaced."; exit 0 ;;
      esac
    fi
  fi
  npm link || fail "npm link failed"
  GLOBAL_PREFIX="$(npm prefix -g)" || fail "npm prefix -g failed"
  BIN="$GLOBAL_PREFIX/bin/$C4MP_NAME"
  [ -x "$BIN" ] || fail "$C4MP_NAME not found at $BIN after npm link"
  NOW_BIN="$(command -v "$C4MP_NAME" 2>/dev/null || true)"
  log "command -v $C4MP_NAME after link: ${NOW_BIN:-<not on PATH>}"
  if [ -z "$NOW_BIN" ]; then
    log "note: add $(npm prefix -g)/bin to your PATH to type $C4MP_NAME"
  elif [ "$(real_path "$NOW_BIN")" != "$(real_path "$BIN")" ]; then
    log "WARN: $C4MP_NAME on PATH ($NOW_BIN) differs from the linked binary ($BIN)"
  fi
  GOT="$("$BIN" --version)" || fail "$C4MP_NAME --version crashed"
  echo "Installed to: $(real_path "$BIN") (bundle folder: $HERE)"
fi
if [ "$GOT" = "$BUNDLE" ]; then log "PASS: $C4MP_NAME --version = $GOT"; else fail "$C4MP_NAME --version = $GOT, bundle = $BUNDLE"; fi
