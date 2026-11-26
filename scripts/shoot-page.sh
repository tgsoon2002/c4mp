#!/bin/bash
# Screenshot a local HTML page with headless Chrome.
# Usage: scripts/shoot-page.sh <page.html> <width> <height> <out.png> [extra chrome flags...]
# Env:   CHROME  path to chrome-headless-shell (default: playwright cache path used by test/viewer-layout.test.ts)
# Safety: --virtual-time-budget=10000 and a hard 60 s kill (perl alarm; macOS has no `timeout`).
set -u
if [ "$#" -lt 4 ]; then
  echo "usage: $0 <page.html> <width> <height> <out.png> [extra chrome flags...]" >&2
  exit 2
fi
PAGE="$1"; W="$2"; H="$3"; OUT="$4"; shift 4
DEFAULT_CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell"
CHROME="${CHROME:-$DEFAULT_CHROME}"
if [ ! -x "$CHROME" ]; then
  echo "chrome not found: $CHROME (set CHROME=...)" >&2
  exit 3
fi
if [ ! -f "$PAGE" ]; then
  echo "page not found: $PAGE" >&2
  exit 4
fi
ABS_PAGE="$(cd "$(dirname "$PAGE")" && pwd)/$(basename "$PAGE")"
mkdir -p "$(dirname "$OUT")"
perl -e 'alarm 60; exec @ARGV' "$CHROME" --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size="${W},${H}" --virtual-time-budget=10000 \
  --screenshot="$OUT" "$@" "file://$ABS_PAGE" >/dev/null 2>&1
RC=$?
if [ "$RC" -ne 0 ] || [ ! -s "$OUT" ]; then
  echo "screenshot failed (rc=$RC): $OUT" >&2
  exit 1
fi
echo "$OUT"
