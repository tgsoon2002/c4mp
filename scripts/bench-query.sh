#!/usr/bin/env bash
# bench-query.sh - wall time of the c4pm query commands (outline, show, find, callers, search), cold and warm.
#
# How to run (from the C4PM checkout, after `npm run build` in Project/):
#   Project/scripts/bench-query.sh --repo Project
#   Project/scripts/bench-query.sh --repo Project --write Document/Roadmap/Phase32/PHASE_32_PLAN.md
#   Project/scripts/bench-query.sh --repo ../other --outline src/a.ts --show src/a.ts#f --find f --callers src/a.ts#f --search "text"
#
# Options:
#   --repo <path>        repository to query (required). Queries are read-only, so it is used in place (no clone).
#   --bin <cmd>          c4pm command to measure, default "node <this script's dir>/../dist/bin/cli.js"
#   --runs <N>           runs per command and state, default 3; the table shows the median (and min-max)
#   --commands <list>    comma list, default all: outline,show,find,callers,search
#   --outline <file>     outline target, default src/languages/testCases.ts
#   --show <target>      show target, default src/parseCache.ts#getCachedParse
#   --find <query>       find query, default getCachedParse
#   --callers <name>     callers target, default src/parseCache.ts#getCachedParse
#   --search <text>      search text, default "parse cache"
#   --work <dir>         where the temp dir (the fresh cache dirs) is made, default $TMPDIR or /tmp
#   --write <file.md>    also write the result table into <file.md>, between the lines
#                        "<!-- bench-query:start -->" and "<!-- bench-query:end -->" (added at the end when missing)
#
# One round per command and run: a fresh empty cache dir (C4PM_CACHE_DIR=<it>), the command once (cold: every file
# is parsed and the cache is written), then once more with the same dir (warm: every file comes from the cache).
# Every run gets C4PM_TIMING=1; the "parse files ... N files (M cached)" line of its stderr gives the cached column,
# so a warm run that still parses shows up. The load average is printed before and after: cold runs are CPU-bound,
# so another busy process makes them noisy. The temp dir is deleted by a trap on every exit.
# Exit code: 0 when every run exited 0, 1 when a run failed, 2 for bad options.
set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO=""; BIN="node $HERE/../dist/bin/cli.js"; RUNS=3; CMDS="outline,show,find,callers,search"
OUTLINE="src/languages/testCases.ts"; SHOW="src/parseCache.ts#getCachedParse"; FIND="getCachedParse"
CALLERS="src/parseCache.ts#getCachedParse"; SEARCH="parse cache"; WORK="${TMPDIR:-/tmp}"; WRITE=""

usage() { sed -n '2,/^set -u$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --commands) CMDS="$2"; shift 2 ;;
    --outline) OUTLINE="$2"; shift 2 ;;
    --show) SHOW="$2"; shift 2 ;;
    --find) FIND="$2"; shift 2 ;;
    --callers) CALLERS="$2"; shift 2 ;;
    --search) SEARCH="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --write) WRITE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "need --repo (see --help)" >&2; exit 2; }
[ -d "$REPO" ] || { echo "not a folder: $REPO" >&2; exit 2; }
case "$RUNS" in ''|*[!0-9]*|0) echo "--runs must be a positive number" >&2; exit 2 ;; esac
for c in ${CMDS//,/ }; do
  case "$c" in outline|show|find|callers|search) ;; *) echo "unknown command: $c" >&2; exit 2 ;; esac
done
[ -z "$WRITE" ] || [ -w "$WRITE" ] || { echo "cannot write: $WRITE" >&2; exit 2; }
REPO="$(cd "$REPO" && pwd -P)"
mkdir -p "$WORK"
TMP="$(mktemp -d "$WORK/c4pm-bench-query.XXXXXX")" || exit 1
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

read -r -a CMD <<< "$BIN"
args_of() {   # args_of <command>: the query arguments of one command
  case "$1" in
    outline) ARGS=(outline "$OUTLINE") ;;
    show) ARGS=(show "$SHOW") ;;
    find) ARGS=(find "$FIND") ;;
    callers) ARGS=(callers "$CALLERS") ;;
    search) ARGS=(search "$SEARCH") ;;
  esac
}
loadavg() { if command -v sysctl >/dev/null 2>&1 && sysctl -n vm.loadavg >/dev/null 2>&1; then sysctl -n vm.loadavg | tr -d '{}' | xargs
            elif [ -r /proc/loadavg ]; then cut -d' ' -f1-3 /proc/loadavg; else echo "?"; fi; }
# median_of <values...>: "median (min-max)", or "median" with one value
median_of() { printf '%s\n' "$@" | sort -n | awk '{v[NR]=$1} END {m=v[int((NR+1)/2)]; if (NR>1) printf "%.2f s (%.2f-%.2f)", m, v[1], v[NR]; else printf "%.2f s", m}'; }

FAILED=0
RESULT=""   # set by run_one: wall seconds
CACHED=""   # set by run_one: "M/N" from the parse files line, "-" when missing
# run_one <log> <cache dir>: one timed run of "${CMD[@]}" "${ARGS[@]}" --repo "$REPO"
run_one() {
  local log="$1" cache="$2" status
  ( cd "$TMP" && C4PM_CACHE_DIR="$cache" C4PM_TIMING=1 exec /usr/bin/time -p "${CMD[@]}" "${ARGS[@]}" --repo "$REPO" ) \
    > "$log.stdout" 2> "$log.stderr"
  status=$?
  RESULT=$(awk '$1=="real"{print $2; exit}' "$log.stderr")
  CACHED=$(sed -nE 's/^parse files .* ([0-9]+) files \(([0-9]+) cached\).*/\2\/\1/p' "$log.stderr" | head -1)
  [ -n "$CACHED" ] || CACHED="-"
  if [ "$status" -ne 0 ] || [ -z "$RESULT" ]; then
    FAILED=1; echo "  failed (exit $status): ${CMD[*]} ${ARGS[*]}" >&2; tail -5 "$log.stderr" | sed 's/^/    /' >&2
    [ -n "$RESULT" ] || RESULT=0
  fi
}

LOAD0="$(loadavg)"
echo "repo: $REPO"
VERSION="$("${CMD[@]}" --version 2>&1 | head -1)"
echo "bin: $BIN (version $VERSION)"
echo "runs: $RUNS per command and state; load average before: $LOAD0"
ROWS=()
for c in ${CMDS//,/ }; do
  args_of "$c"
  COLD=(); WARM=(); CC=""; WC=""
  for i in $(seq 1 "$RUNS"); do
    cache="$TMP/cache-$c-$i"
    mkdir -p "$cache"
    run_one "$TMP/$c-$i-cold" "$cache"; COLD+=("$RESULT"); CC="$CACHED"
    run_one "$TMP/$c-$i-warm" "$cache"; WARM+=("$RESULT"); WC="$CACHED"
    echo "  $c run $i: cold ${COLD[$((i - 1))]} s ($CC cached), warm ${WARM[$((i - 1))]} s ($WC cached)"
  done
  ROWS+=("\`$c ${ARGS[1]}\`|$(median_of "${COLD[@]}")|$CC|$(median_of "${WARM[@]}")|$WC")
done
LOAD1="$(loadavg)"

TABLE="$(
  echo "| command | cold (median of $RUNS, min-max) | cold cached | warm (median of $RUNS, min-max) | warm cached |"
  echo "|---|---|---|---|---|"
  for r in "${ROWS[@]}"; do echo "| ${r//|/ | } |"; done
  echo
  echo "Measured $(date '+%Y-%m-%d %H:%M') with \`scripts/bench-query.sh\` on \`$(basename "$REPO")\`, c4pm $VERSION," \
       "node $(node --version 2>/dev/null), load average before: $LOAD0, after: $LOAD1."
)"
echo
echo "$TABLE"

if [ -n "$WRITE" ]; then
  START="<!-- bench-query:start -->"; END="<!-- bench-query:end -->"
  BLOCK="$TMP/block.md"; { echo "$START"; echo "$TABLE"; echo "$END"; } > "$BLOCK"
  if grep -qF "$START" "$WRITE" && grep -qF "$END" "$WRITE"; then
    awk -v s="$START" -v e="$END" -v f="$BLOCK" '
      $0 == s { while ((getline l < f) > 0) print l; skip = 1; next }
      $0 == e { skip = 0; next }
      !skip' "$WRITE" > "$TMP/write.md"
  else
    { cat "$WRITE"; echo; cat "$BLOCK"; } > "$TMP/write.md"
  fi
  cat "$TMP/write.md" > "$WRITE" && echo "written: $WRITE"
fi
[ $FAILED = 1 ] && exit 1
exit 0
