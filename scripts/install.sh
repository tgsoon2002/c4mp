#!/bin/sh
# install.sh: download the c4mp binary for this Mac or Linux machine, check it, and run its own `c4mp install`.
# Usage:  curl -fsSL https://github.com/tgsoon2002/c4mp-releases/releases/latest/download/install.sh | sh
#         curl -fsSL .../install.sh | sh -s -- --yes      (arguments go to `c4mp install`: --yes, --no-path, --dir <folder>)
#         sh install.sh [--yes] [--no-path] [--dir <folder>]
# Env:    C4MP_RELEASE_BASE  folder URL holding the release files (default: the latest GitHub release; file:// works)
#         C4MP_VERSION       a version such as 0.9.0: use .../releases/download/v<version> (ignored with C4MP_RELEASE_BASE)
#         C4MP_PLATFORM      darwin-arm64, darwin-x64 or linux-x64 instead of `uname` (tests)
#         C4MP_DRY_URL=1     print the base URL line `[install] from <url>` and exit 0 before any download (tests)
#         The old names C4PM_RELEASE_BASE, C4PM_VERSION, C4PM_PLATFORM, C4PM_DRY_URL are still read (the C4MP_ name wins).
# What it does: prints `[install] from <url>`; picks the platform (Darwin arm64, Darwin x86_64, Linux x86_64; anything
#   else stops with exit 1); downloads SHA256SUMS with curl (else wget) into a temp folder (removed at exit); takes the
#   one `c4mp-<version>-<platform>` line from it; downloads that binary and checks its sha256 (`shasum -a 256` or
#   `sha256sum`; a mismatch stops with "checksum mismatch", nothing run); prints `<binary> --version`; then runs
#   `<binary> install <args>`, which copies it to ~/.local/bin (or --dir) and offers to add that folder to PATH.
#   Under `curl | sh` the install step reads its answers from /dev/tty when it can be opened; else pass --yes.
# Never uses sudo and writes nothing outside its temp folder; `c4mp install` writes only its folder and, when you
# agree, a marked PATH block in your shell profile.
# The whole script is one function called on the last line, so a cut-off download runs nothing.
set -eu

# The names, inline because this file is downloaded alone: the same values as Project/scripts/names.sh
# (test/install-script.test.ts checks that the two copies are equal).
C4MP_NAME=c4mp
C4MP_PRODUCT=C4MP
C4MP_LEGACY_NAME=c4pm
C4MP_RELEASES_REPO=tgsoon2002/c4mp-releases
C4MP_TAP=tgsoon2002/c4mp

c4mp_install_main() {
  SUPPORTED="darwin-arm64 darwin-x64 linux-x64"
  log() { echo "[install] $*"; }
  die() { echo "[install] ERROR: $*" >&2; exit 1; }
  # envv <SUFFIX>: C4MP_<SUFFIX> when set and not empty, else the old C4PM_<SUFFIX>, else empty.
  envv() {
    envv_value=""
    eval "envv_value=\"\${C4MP_$1:-}\""
    if [ -z "$envv_value" ]; then eval "envv_value=\"\${C4PM_$1:-}\""; fi
    printf '%s' "$envv_value"
  }

  RELEASE_BASE="$(envv RELEASE_BASE)"; VERSION="$(envv VERSION)"; PLATFORM="$(envv PLATFORM)"
  if [ -n "$RELEASE_BASE" ]; then BASE="${RELEASE_BASE%/}"
  elif [ -n "$VERSION" ]; then BASE="https://github.com/$C4MP_RELEASES_REPO/releases/download/v${VERSION#v}"
  else BASE="https://github.com/$C4MP_RELEASES_REPO/releases/latest/download"
  fi
  log "from $BASE"
  [ "$(envv DRY_URL)" != "1" ] || exit 0

  if [ -n "$PLATFORM" ]; then :
  else
    OS="$(uname -s)"; ARCH="$(uname -m)"
    case "$OS $ARCH" in
      "Darwin arm64") PLATFORM=darwin-arm64 ;;
      "Darwin x86_64") PLATFORM=darwin-x64 ;;
      "Linux x86_64") PLATFORM=linux-x64 ;;
      *) PLATFORM="$OS $ARCH" ;;
    esac
  fi
  case " $SUPPORTED " in
    *" $PLATFORM "*) ;;
    *) die "no $C4MP_NAME binary for platform '$PLATFORM' (binaries exist for: $SUPPORTED; Windows: use install.ps1)" ;;
  esac
  log "platform $PLATFORM"

  if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }
  elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO "$2" "$1"; }
  else die "neither curl nor wget found on PATH"
  fi
  if command -v shasum >/dev/null 2>&1; then hash256() { shasum -a 256 "$1" | awk '{print $1}'; }
  elif command -v sha256sum >/dev/null 2>&1; then hash256() { sha256sum "$1" | awk '{print $1}'; }
  else die "neither shasum nor sha256sum found on PATH"
  fi

  TMPROOT="${TMPDIR:-/tmp}"
  TMP="$(mktemp -d "${TMPROOT%/}/$C4MP_NAME-install.XXXXXX")" || die "cannot create a temp folder"
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 1' HUP INT TERM

  fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"
  FOUND=""; COUNT=0
  while read -r SUM NAME; do
    case "$NAME" in
      */*) ;;
      "$C4MP_NAME"-*-"$PLATFORM") FOUND="$SUM $NAME"; COUNT=$((COUNT + 1)) ;;
    esac
  done < "$TMP/SHA256SUMS"
  [ "$COUNT" -gt 0 ] || die "SHA256SUMS at $BASE lists no $C4MP_NAME-*-$PLATFORM binary"
  [ "$COUNT" -eq 1 ] || die "SHA256SUMS at $BASE lists $COUNT $C4MP_NAME-*-$PLATFORM binaries (expected one)"
  WANT="$(echo "${FOUND%% *}" | tr 'A-F' 'a-f')"
  NAME="${FOUND#* }"
  case "$WANT" in
    *[!0-9a-f]*) die "SHA256SUMS line for $NAME has no valid sha256" ;;
  esac
  [ "${#WANT}" -eq 64 ] || die "SHA256SUMS line for $NAME has no valid sha256"

  BIN="$TMP/$NAME"
  log "downloading $NAME"
  fetch "$BASE/$NAME" "$BIN" || die "download failed: $BASE/$NAME"
  GOT="$(hash256 "$BIN")" || die "hashing $NAME failed"
  [ "$GOT" = "$WANT" ] || die "checksum mismatch for $NAME (expected $WANT, got $GOT); nothing was run"
  log "checksum OK"
  chmod +x "$BIN"
  "$BIN" --version </dev/null || die "$NAME --version failed"

  # Under `curl | sh` stdin is the script itself: never hand it to the binary. Use the terminal when there is one.
  if [ -t 0 ]; then "$BIN" install "$@"
  elif (: </dev/tty) 2>/dev/null; then "$BIN" install "$@" </dev/tty
  else
    case " $* " in
      *" --yes "*) ;;
      *) log "no terminal to ask: run it again with --yes, e.g. curl -fsSL $BASE/install.sh | sh -s -- --yes" ;;
    esac
    "$BIN" install "$@" </dev/null
  fi
}

c4mp_install_main "$@"
