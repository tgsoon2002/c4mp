#!/usr/bin/env bash
# bench-scan.sh - wall time and peak memory of c4pm scan, history, hook and view runs on a temp clone of a git repo.
#
# How to run (from the C4PM checkout, after `npm run build` in Project/):
#   Project/scripts/bench-scan.sh --repo <git repo> --bin "node $PWD/Project/dist/bin/cli.js"
#   Project/scripts/bench-scan.sh --repo <git repo> --bin /usr/local/bin/c4pm --scenarios post-commit,post-merge-warm
#
# Options:
#   --repo <path>        git repository to measure (required). It is only read: `git clone` copies it into a temp dir.
#   --bin <cmd>          c4pm command to measure (required); repeat it to compare builds, e.g. --bin "node dist/bin/cli.js"
#   --scenarios <list>   comma list, default all: scan,history,view,post-commit,post-merge-warm,post-merge-cold
#   --max "<N ...>"      history sizes, default "1 5 10 20" (one history run per N, each with a fresh store)
#   --merge-depth <N>    commits on the merged branch, default 5 (clamped to the clone's first-parent history)
#   --out <dir>          keep every run's stdout, stderr and memory samples here (default: in the temp dir, deleted)
#   --work <dir>         where the temp dir is made (default: $TMPDIR or /tmp)
#   --limit-mb <N>       watchdog: kill a run when max(RSS, footprint) > N MB, default 3072
#   --min-free <pct>     memory gate: wait (30 s polls, 15 min at most) until free memory >= pct, default 30
#   --kill-free <pct>    watchdog: kill a run when free memory < pct, default 15
#   --timeout <s>        watchdog: kill a run after s seconds, default 2400
#   --growth <file.mem>  print the footprint growth of a saved history run's memory samples (from --out) and exit
#
# Scenarios (all on the temp clone, each with its own --store inside the temp dir; no hooks are installed, the hook
# commands are run by hand):
#   scan             `snapshot` of HEAD (one full scan)
#   history          `history --max N` for each N; prints per-commit time and per-commit footprint growth
#                    (growth = least-squares slope of max(RSS, footprint) over every sample taken while commits
#                    finish, each sample mapped to the commits done at its time; plus the highest sample and how
#                    many commits were done then: a late GC can drop the last sample far below the peak)
#   view             `view` (the page build)
#   post-commit      `hook post-commit` at the state before the merge, fresh store (it also stores that state)
#   post-merge-warm  a real `git merge --no-ff` of a side branch (--merge-depth commits), then `hook post-merge` with
#                    the store of post-commit: the state before the merge is already stored
#   post-merge-cold  `hook post-merge` after the same merge with a fresh store: it records the before-state too
# The merge set-up: the clone's tip becomes branch bench-feat, the checked-out branch goes back --merge-depth
# first-parent commits, and bench-feat is merged into it with --no-ff (git hooks off: core.hooksPath=/dev/null).
#
# Each run: memory gate, nice -n 10, /usr/bin/time, a watchdog every second (RSS and, on macOS, phys_footprint:
# compressed or swapped pages keep RSS low while the footprint grows). Runs go one at a time. Every child gets
# TMPDIR inside the temp dir, so the export dirs of a killed run go too. The temp dir (clone, stores, child TMPDIR)
# is deleted by a trap on every exit, also on failure or Ctrl-C. Env per run: C4PM_TIMING=1 (the step table goes to
# stderr, kept with --out). A hook run's result is the last line of its last-hook.txt.
# Exit code: 0 when every run was ok, 1 when a run failed or was killed, 2 for bad options, 3 when the gate stopped.
set -u

REPO=""; BINS=(); SCEN="scan,history,view,post-commit,post-merge-warm,post-merge-cold"; MAXES="1 5 10 20"
MERGE_DEPTH=5; OUT=""; WORK="${TMPDIR:-/tmp}"; LIMIT_MB=3072; MIN_FREE=30; KILL_FREE=15; TIMEOUT=2400

usage() { sed -n '2,/^set -u$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
# growth_of <file.mem>: "<slope> MB, peak <P> MB after <C> commits", or "-" with fewer than 2 commit points.
# .mem columns: elapsed_s rss_kb footprint_kb free_pct commits_done; the slope uses the samples with commits_done > 0.
growth_of() {
  awk '
    { m = ($3 > $2 ? $3 : $2) }
    m > pk { pk = m; pc = $5 }
    $5 > 0 { n++; x = $5; y = m / 1024; sx += x; sy += y; sxx += x * x; sxy += x * y }
    END {
      d = n * sxx - sx * sx
      if (n < 2 || d <= 0) { print "-"; exit }
      printf "%+.0f MB, peak %d MB after %d commits\n", (n * sxy - sx * sy) / d, pk / 1024, pc
    }' "$1"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --bin) BINS+=("$2"); shift 2 ;;
    --scenarios) SCEN="$2"; shift 2 ;;
    --max) MAXES="$2"; shift 2 ;;
    --merge-depth) MERGE_DEPTH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --limit-mb) LIMIT_MB="$2"; shift 2 ;;
    --min-free) MIN_FREE="$2"; shift 2 ;;
    --kill-free) KILL_FREE="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --growth) [ -r "$2" ] || { echo "cannot read: $2" >&2; exit 2; }; growth_of "$2"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ ${#BINS[@]} -gt 0 ] || { echo "need --repo and --bin (see --help)" >&2; exit 2; }
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository: $REPO" >&2; exit 2; }
for s in ${SCEN//,/ }; do
  case "$s" in scan|history|view|post-commit|post-merge-warm|post-merge-cold) ;; *) echo "unknown scenario: $s" >&2; exit 2 ;; esac
done
LIMIT_KB=$((LIMIT_MB * 1024))
mkdir -p "$WORK"

TMP="$(mktemp -d "$WORK/c4pm-bench.XXXXXX")" || exit 1
TMP="$(cd "$TMP" && pwd -P)"
CHILD=""
cleanup() {
  [ -n "$CHILD" ] && kill -9 "$CHILD" 2>/dev/null
  rm -rf "$TMP"
  echo "cleanup: removed $TMP (exists now: $([ -e "$TMP" ] && echo yes || echo no))"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
[ -n "$OUT" ] || OUT="$TMP/logs"
mkdir -p "$OUT" "$TMP/systmp"

# --- platform helpers: free memory in percent, phys_footprint in KB (macOS only; 0 elsewhere) ---
OS="$(uname -s)"
free_pct() {
  if command -v memory_pressure >/dev/null 2>&1; then
    memory_pressure | tail -1 | sed -E 's/.*: ([0-9]+)%.*/\1/'
  elif [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if (t>0) print int(a*100/t); else print 100}' /proc/meminfo
  else
    echo 100
  fi
}
footprint_kb() {
  [ -x /usr/bin/footprint ] || { echo 0; return; }
  /usr/bin/footprint "$1" 2>/dev/null | awk '/phys_footprint:/{v=$2; u=$3; if(u=="MB") v*=1024; if(u=="GB") v*=1048576; print int(v); exit}'
}
if [ "$OS" = Darwin ]; then TIME_FLAG=-l; else TIME_FLAG=-p; fi

GATE_POLLS=30    # 30 polls of 30 s = 15 min
gate() {   # wait until free >= MIN_FREE (poll 30 s, at most 15 min); 1 when it never gets there
  local i=0 f
  while :; do
    f=$(free_pct)
    [ "$f" -ge "$MIN_FREE" ] && { echo "gate: free ${f}%"; return 0; }
    [ $i -ge $GATE_POLLS ] && { echo "gate: free ${f}% after $((GATE_POLLS / 2)) min, stopping"; return 1; }
    echo "gate: free ${f}% < ${MIN_FREE}%, waiting 30 s"; sleep 30; i=$((i + 1))
  done
}

ROWS=()          # run|binary|commits|wall|peak RSS / footprint|per-commit time|per-commit growth|result
LAST_RESULT=""
FAILED=0
GATE_STOP=0

# The newest line of the clone's last-hook.txt (the project id is not known here, so look for it).
last_hook_line() {
  local f; f=$(find "$CLONE/.c4mp" "$CLONE/.c4pm" -name last-hook.txt 2>/dev/null | head -1)
  [ -n "$f" ] && tail -1 "$f"
}

# run_one <tag> <binary label> <commits wanted (0 = not a history run)> <hook: 0|1> <cmd...>
run_one() {
  local tag="$1" blabel="$2" ncommits="$3" is_hook="$4"; shift 4
  local log="$OUT/$tag"
  if [ $GATE_STOP = 1 ] || ! gate; then
    GATE_STOP=1; ROWS+=("$tag|$blabel|-|-|-|-|-|gate-stop"); LAST_RESULT="gate-stop"; return 2
  fi
  echo "run: $tag :: $*"
  local before_hook=""; [ "$is_hook" = 1 ] && before_hook="$(last_hook_line)"
  local t0; t0=$(date +%s)
  ( cd "$TMP" && TMPDIR="$TMP/systmp" C4PM_TIMING=1 exec nice -n 10 /usr/bin/time $TIME_FLAG "$@" ) \
      > "$log.stdout" 2> "$log.stderr" &
  local tpid=$! pid="" rss=0 fp=0 mem=0 peak=0 peakfp=0 f el n result="ok" lines=0 tlast=0 tdone=""
  : > "$log.mem"   # columns: elapsed_s rss_kb footprint_kb free_pct commit_lines
  while kill -0 "$tpid" 2>/dev/null; do
    [ -z "$pid" ] && pid=$(pgrep -P "$tpid" | head -1) && CHILD="$pid"
    if [ -n "$pid" ]; then
      rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' '); rss=${rss:-0}
      fp=$(footprint_kb "$pid"); fp=${fp:-0}
      [ "$rss" -gt "$peak" ] && peak=$rss
      [ "$fp" -gt "$peakfp" ] && peakfp=$fp
      mem=$(( rss > fp ? rss : fp ))
      f=$(free_pct); el=$(( $(date +%s) - t0 ))
      n=$(grep -c '^+ ' "$log.stdout" 2>/dev/null); n=${n:-0}
      [ "$n" -gt "$lines" ] && { lines=$n; tlast=$el; }
      [ -z "$tdone" ] && grep -q '^History: ' "$log.stdout" 2>/dev/null && tdone=$el
      echo "$el $rss $fp $f $lines" >> "$log.mem"
      if [ "$mem" -gt "$LIMIT_KB" ] || [ "$f" -lt "$KILL_FREE" ] || [ "$el" -gt "$TIMEOUT" ]; then
        if [ "$el" -gt "$TIMEOUT" ]; then result="timeout after ${el} s"
        else result="killed at rss $((rss / 1024)) MB / footprint $((fp / 1024)) MB after ${el} s (free ${f}%)"; fi
        kill -9 "$pid" 2>/dev/null
        break
      fi
    fi
    sleep 1
  done
  wait "$tpid"; local status=$?
  CHILD=""
  # /usr/bin/time: macOS -l prints "<s> real ...", bytes of max RSS and peak footprint; -p prints "real <s>"
  local wall maxrss foot rssmb fpmb
  wall=$(awk '$2=="real"{print $1; exit} $1=="real"{print $2; exit}' "$log.stderr")
  maxrss=$(awk '/maximum resident set size/{print $1; exit}' "$log.stderr")
  foot=$(awk '/peak memory footprint/{print $1; exit}' "$log.stderr")
  [ -n "$wall" ] || wall=$(( $(date +%s) - t0 ))
  if [ -n "$maxrss" ]; then rssmb=$(( maxrss / 1048576 )); else rssmb=$(( peak / 1024 )); fi
  if [ -n "$foot" ]; then fpmb=$(( foot / 1048576 )); else fpmb=$(( peakfp / 1024 )); fi
  [ $(( peakfp / 1024 )) -gt "$fpmb" ] && fpmb=$(( peakfp / 1024 ))
  [ "$result" = ok ] && [ "$status" -ne 0 ] && result="exit $status"
  # a run shorter than one sample: count its commit lines now (time to the last one = the wall time)
  n=$(grep -c '^+ ' "$log.stdout" 2>/dev/null); n=${n:-0}
  [ "$n" -gt "$lines" ] && { lines=$n; tlast=$(awk -v w="$wall" 'BEGIN{printf "%.2f", w}'); }
  if [ "$result" = ok ] && [ "$is_hook" = 1 ]; then
    local hl; hl="$(last_hook_line)"
    if [ -z "$hl" ] || [ "$hl" = "$before_hook" ]; then result="no last-hook.txt line"
    else
      echo "  last-hook.txt: $hl"
      local hr="${hl##* | }"; [ "$hr" = ok ] || result="hook: $hr"
    fi
  fi
  # history: per-commit time = time to the last commit line / commits; growth = growth_of the samples
  local pct="-" pcg="-" tail=""
  if [ "$lines" -gt 0 ]; then
    pct=$(awk -v t="$tlast" -v n="$lines" 'BEGIN{printf "%.1f s", t/n}')
    pcg=$(growth_of "$log.mem")
    [ -n "$tdone" ] && tail=" (exit $(awk -v w="$wall" -v d="$tdone" 'BEGIN{printf "%.0f", w-d}') s after the last commit)"
  fi
  local done="-"; [ "$ncommits" -gt 0 ] && { done="$lines"; [ "$result" != ok ] && done="$lines/$ncommits"; }
  local memtext="${rssmb} MB"; [ "$fpmb" -gt 0 ] && memtext="${rssmb} / ${fpmb} MB"
  echo "  -> wall ${wall} s  peak RSS / footprint ${memtext}  $result$tail"
  if [ "$result" != ok ]; then FAILED=1; echo "  stderr (last 5 lines):"; tail -5 "$log.stderr" | sed 's/^/    /'; fi
  ROWS+=("$tag|$blabel|$done|${wall} s$tail|$memtext|$pct|$pcg|$result")
  LAST_RESULT="$result"
  [ "$result" = ok ]
}

has() { case ",$SCEN," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

NAME="$(basename "$(cd "$REPO" && pwd -P)")"
CLONE="$TMP/$NAME"   # same folder name: c4pm may take the project id from it
git clone -q "$REPO" "$CLONE" || exit 1
TIP=$(git -C "$CLONE" rev-parse HEAD)
echo "repo: $REPO -> $CLONE"
echo "tracked files: $(git -C "$CLONE" ls-files | wc -l | tr -d ' ')   commits: $(git -C "$CLONE" rev-list --count HEAD)   HEAD: $(git -C "$CLONE" log -1 --format='%h %ci')"
CONFIG_FILE="$CLONE/.c4mp/config.json"; [ -f "$CONFIG_FILE" ] || CONFIG_FILE="$CLONE/.c4pm/config.json"
[ -f "$CONFIG_FILE" ] && echo "config: $(tr -d '\n ' < "$CONFIG_FILE")" || echo "config: none"

# merge set-up needs at least 2 first-parent commits; the depth is clamped to what the clone has
FP_COUNT=$(git -C "$CLONE" rev-list --count --first-parent HEAD)
[ "$MERGE_DEPTH" -ge "$FP_COUNT" ] && MERGE_DEPTH=$((FP_COUNT - 1))

bi=0
for BIN in "${BINS[@]}"; do
  bi=$((bi + 1))
  read -r -a CMD <<< "$BIN"
  BL="$bi-$(basename "${CMD[0]}")"
  echo "== binary $bi: $BIN (label $BL, version $("${CMD[@]}" --version 2>&1 | head -1))"
  git -C "$CLONE" reset -q --hard "$TIP"

  has scan && run_one "$BL-scan" "$BL" 0 0 "${CMD[@]}" snapshot --repo "$CLONE" --out "$TMP/out-$BL-scan"
  if has history; then
    for N in $MAXES; do
      run_one "$BL-history-$N" "$BL" "$N" 0 "${CMD[@]}" history --repo "$CLONE" --max "$N" --store "$TMP/store-$BL-history-$N"
      [ "$LAST_RESULT" = ok ] || break   # a bigger N would only be killed later
    done
  fi
  has view && run_one "$BL-view" "$BL" 0 0 "${CMD[@]}" view --repo "$CLONE" --out "$TMP/view-$BL.html" --store "$TMP/store-$BL-view"

  if has post-commit || has post-merge-warm || has post-merge-cold; then
    if [ "$MERGE_DEPTH" -lt 1 ]; then
      echo "merge set-up: the clone has $FP_COUNT first-parent commit(s); hook scenarios need 2 or more, skipped"
      ROWS+=("$BL-hooks|$BL|-|-|-|-|-|skipped: fewer than 2 commits")
    else
      git -C "$CLONE" branch -f -q bench-feat "$TIP"
      git -C "$CLONE" reset -q --hard "$TIP~$MERGE_DEPTH"
      echo "merge set-up: before state $(git -C "$CLONE" log -1 --format='%h %s'), bench-feat $(git -C "$CLONE" log -1 --format=%h bench-feat) ($MERGE_DEPTH commits ahead)"
      WARM="$TMP/store-$BL-warm"
      # post-commit at the before state also stores it, so the warm post-merge finds it
      if has post-commit || has post-merge-warm; then
        run_one "$BL-post-commit" "$BL" 0 1 "${CMD[@]}" hook post-commit --repo "$CLONE" --store "$WARM"
      fi
      git -C "$CLONE" -c core.hooksPath=/dev/null -c user.email=bench@example.com -c user.name=bench \
        merge -q --no-ff -m "bench merge" bench-feat || { echo "merge failed" >&2; exit 1; }
      echo "merge: HEAD $(git -C "$CLONE" rev-parse --short HEAD), ORIG_HEAD $(git -C "$CLONE" rev-parse --short ORIG_HEAD)"
      has post-merge-warm && run_one "$BL-post-merge-warm" "$BL" 0 1 "${CMD[@]}" hook post-merge --repo "$CLONE" --store "$WARM"
      has post-merge-cold && run_one "$BL-post-merge-cold" "$BL" 0 1 "${CMD[@]}" hook post-merge --repo "$CLONE" --store "$TMP/store-$BL-cold"
      git -C "$CLONE" reset -q --hard "$TIP"
    fi
  fi
  du -sh "$TMP"/store-"$BL"-* 2>/dev/null | sed 's/^/  store: /'
done

echo
echo "| run | binary | commits | wall time | peak RSS / footprint | per-commit time | per-commit footprint growth (slope; peak sample) | result |"
echo "|---|---|---|---|---|---|---|---|"
for r in "${ROWS[@]}"; do echo "| ${r//|/ | } |"; done
[ $GATE_STOP = 1 ] && exit 3
[ $FAILED = 1 ] && exit 1
exit 0
