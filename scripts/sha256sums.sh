#!/usr/bin/env bash
# sha256sums.sh: write <folder>/SHA256SUMS for the files of one release folder.
# Usage:  sha256sums.sh <folder>
# Format: one line per regular file directly in <folder> (not SHA256SUMS itself, not .DS_Store), sorted by name
#         (C locale): `<64 hex>  <file name>` (two spaces, base name only), the sha256sum / `shasum -a 256` format,
#         so `shasum -a 256 -c SHA256SUMS` or `sha256sum -c SHA256SUMS` run in <folder> checks every file.
# Uses `shasum -a 256` when present, else `sha256sum`; stops when neither exists.
# Never overwrites: an existing <folder>/SHA256SUMS stops the run (exit 1) and nothing is written.
set -euo pipefail
log() { echo "[sha256sums] $*"; }
die() { echo "[sha256sums] ERROR: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: sha256sums.sh <folder>"
DIR="$1"
[ -d "$DIR" ] || die "$DIR is not a folder"
SUMS="$DIR/SHA256SUMS"
[ ! -e "$SUMS" ] || die "$SUMS already exists (not overwritten)"
if command -v shasum >/dev/null 2>&1; then HASH=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then HASH=(sha256sum)
else die "neither shasum nor sha256sum found on PATH"
fi

# Names first, then all hashes, so a failing hash writes nothing.
NAMES="$(cd "$DIR" && find . -mindepth 1 -maxdepth 1 -type f ! -name 'SHA256SUMS' ! -name '.DS_Store' | sed 's|^\./||' | LC_ALL=C sort)"
[ -n "$NAMES" ] || die "$DIR holds no files to hash"
LINES=""
while IFS= read -r NAME; do
  LINE="$(cd "$DIR" && "${HASH[@]}" "$NAME")" || die "hashing $NAME failed"
  LINES="$LINES$LINE"$'\n'
done <<< "$NAMES"

# noclobber: a SHA256SUMS that appeared meanwhile is still never overwritten.
( set -C; printf '%s' "$LINES" > "$SUMS" ) || die "$SUMS already exists or cannot be written (not overwritten)"
log "wrote $SUMS ($(printf '%s' "$LINES" | wc -l | tr -d ' ') files)"
