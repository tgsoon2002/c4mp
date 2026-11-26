#!/usr/bin/env bash
# binary-selftest.sh: check a single-file c4mp executable built for THIS machine.
# Usage: binary-selftest.sh <binary>
# The binary is copied into an empty temp folder and run from there under `env -i` with a bare PATH and
# HOME, so nothing from the build machine (source viewer/guide folders, node_modules, node) can help it.
# Prints PASS/FAIL per check; exit code 1 if any check fails.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$(cd "$SCRIPT_DIR/../test/fixtures" && pwd)"
# shellcheck source=names.sh
. "$SCRIPT_DIR/names.sh"
die() { echo "[binary-selftest] ERROR: $*" >&2; exit 2; }

[ $# -eq 1 ] || die "usage: binary-selftest.sh <binary>"
[ -f "$1" ] || die "binary $1 not found"
SRC_BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

T="$(mktemp -d /tmp/${C4MP_NAME}-selftest.XXXXXX)"
trap 'rm -rf "$T"' EXIT
mkdir "$T/bin" "$T/run" "$T/fx"
BIN="$T/bin/$(basename "$SRC_BIN")"
cp "$SRC_BIN" "$BIN"
chmod +x "$BIN"
for FX in pyshop rustshop csharpshop phpshop cppshop swiftshop; do
  mkdir "$T/fx/$FX"
  (cd "$FIXTURES/$FX" && tar --exclude venv --exclude node_modules -cf - .) | (cd "$T/fx/$FX" && tar -xf -)
done
mkdir -p "$T/fx/tsshop/src"
cp "$SCRIPT_DIR/../src/guide.ts" "$T/fx/tsshop/src/guide.ts"

FAILS=0
# run <args...>: the binary under a clean environment, from the empty folder.
run() { (cd "$T/run" && env -i HOME="$T" PATH=/usr/bin:/bin "$BIN" "$@"); }
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+ -- $2}"; FAILS=$((FAILS + 1)); }
# check <name> <expected-substring> <args...>: exit 0 and output contains the substring
check() {
  local name="$1" want="$2"; shift 2
  local out rc
  out="$(run "$@" 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then fail "$name" "exit $rc: $(echo "$out" | head -3)"
  elif ! printf '%s' "$out" | grep -qF -- "$want"; then fail "$name" "output lacks '$want': $(echo "$out" | head -3)"
  else pass "$name"; fi
}

START="$(date +%s)"
check "--version" "." --version
echo "      startup (--version): $(( $(date +%s) - START )) s wall"
check "--help" "outline" --help
# `guide ai | head` (head closes the pipe early; only the content matters, not the exit status)
GUIDE="$(run guide ai 2>&1 | head -20)"
# The guide names the product: the new name, or the old one until the guide text is renamed.
if printf '%s' "$GUIDE" | grep -qiE "$C4MP_NAME|$C4MP_LEGACY_NAME"; then pass "guide ai | head"; else fail "guide ai | head" "$(echo "$GUIDE" | head -3)"; fi

check "outline typescript" "guideDir" outline src/guide.ts --repo "$T/fx/tsshop" --lang typescript
# One named fixture file per language that declares a class, so the check never depends on file order.
check "outline python" "class" outline shop/services/orders.py --repo "$T/fx/pyshop" --lang python
check "outline rust" "class" outline src/shop.rs --repo "$T/fx/rustshop" --lang rust
check "outline csharp" "class" outline Shop/Order.cs --repo "$T/fx/csharpshop" --lang csharp
check "outline php" "class" outline src/Models/Order.php --repo "$T/fx/phpshop" --lang php
check "outline cpp" "class" outline src/order.hpp --repo "$T/fx/cppshop" --lang cpp
check "outline swift" "class" outline Sources/Shop/Shop.swift --repo "$T/fx/swiftshop" --lang swift

PAGE="$T/page.html"
VOUT="$(run view --repo "$T/fx/cppshop" --lang cpp --out "$PAGE" 2>&1)"; VRC=$?
if [ $VRC -ne 0 ]; then fail "view" "exit $VRC: $(echo "$VOUT" | head -3)"
elif [ ! -f "$PAGE" ]; then fail "view" "page file $PAGE not written"
else
  SIZE="$(wc -c < "$PAGE" | tr -d ' ')"
  if [ "$SIZE" -gt 102400 ]; then pass "view (page $SIZE bytes)"; else fail "view" "page only $SIZE bytes (expected over 100 KB)"; fi
fi

# mcp: initialize request over stdio; the server exits when stdin closes.
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"selftest","version":"1"}}}'
MOUT="$(printf '%s\n' "$INIT" | run mcp --repo "$T/fx/cppshop" --lang cpp 2>/dev/null)"
if printf '%s' "$MOUT" | grep -q '"id":1' && printf '%s' "$MOUT" | grep -q '"result"'; then pass "mcp initialize"; else fail "mcp initialize" "$(echo "$MOUT" | head -c 300)"; fi

echo
if [ $FAILS -eq 0 ]; then echo "SELFTEST PASS"; else echo "SELFTEST FAIL ($FAILS failed)"; exit 1; fi
