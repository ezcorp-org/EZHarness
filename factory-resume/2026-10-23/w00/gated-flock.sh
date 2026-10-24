#!/usr/bin/env bash
# gated-flock.sh <label> <log> <cmd...>   (lead rule 2026-10-04, common.md "Gate before the lock")
# 1. Wait OUTSIDE the heavy lock until the resource gate passes (resource-gate.sh: disk >= 100 GB, MemAvailable >= 6 GiB AND
#    MemAvailable + SwapFree >= 8 GiB, the combined headroom of 2026-10-16). A disk STOP is re-checked every GATED_FLOCK_POLL_S (default 120 s).
# 2. Take the lock and run <cmd>. A command that finds the gate red after it holds the lock exits 75 at once (heavy-lib.sh does
#    this); the lock is then released and the wait starts again (re-queue).
# GATED_FLOCK_MAX_S (default 14400 s) bounds the total time; exit 91 when it runs out. Any other exit of <cmd> is returned.
# GATED_FLOCK_MAX_REQUEUE (default 3; team-lead's staging ruling 2026-10-17 17:09Z, item 2, after run 12 re-queued every ~14 min for hours
#   against a floor it could not pass): the number of in-lock 75 exits allowed. The last one logs "STOP: the re-queue bound is reached"
#   (never the re-queue line) and finishes 76 at once (no sleep, no further lock try); a re-launch needs a new word. A whole number >= 1,
#   or the launch is refused (exit 2). The value in force is logged once at the start (team-lead's ruling ee5ddb54a1460d79): "in-lock refusal bound
#   GATED_FLOCK_MAX_REQUEUE=<n> (the default | set by the launcher)".
# Start margin (lead 2026-10-04 19:05Z): the OUTSIDE-lock wait needs disk >= 100 + GATED_FLOCK_START_MARGIN_GB (default 4) GB, and the swap
#   margin GATED_FLOCK_START_MARGIN_SWAP_KIB (default 524288) now raises the COMBINED floor (6 / 8.5 GiB; 12 / 14.5 GiB with
#   GATED_FLOCK_START_MEM_GIB=12), so a run's own writes do not take the host under the floor at
#   once (W4H-6 G6 try 1 ran lists 0 and 2, then voided at 98 GB). Inside the lock the floors themselves apply (heavy-lib.sh).
# GATED_FLOCK_MEM_MARGIN_GIB (optional, default 0; team-lead 2026-10-16 after the W4H-28 follow-up commit try 1): a launch-time headroom ADDED
#   to the outside-lock memory floor only (floor + margin; e.g. START_MEM 12 + margin 3 = 15 GiB), so a job starts with room for the swings
#   measured during a typecheck or does not take the lock; the in-lock sub-step gates are unchanged, nothing is lowered. A whole number
#   of GiB or the launch is refused (exit 2). The gate line names both: "start gate mem>=12GiB+3GiB margin".
# GATED_FLOCK_START_MEM_GIB (optional, default 6): a higher MemAvailable floor for the OUTSIDE-lock wait, for legs whose own gate needs more
#   memory (the combined runner's coverage producers need 15 GiB; lead 2026-10-05). Clamped at the 6 GiB floor, never below.
# GATED_FLOCK_EXIT_FILE (optional): the final exit (the command's non-75 exit, or 91 on give-up) is also written to this file.
#   A detached caller then needs no `; echo $? > heavy.exit` of its own; publish.sh reads that file. (lead 2026-10-04 16:10Z: the
#   W4H-5 hold ran green under this wrapper but no heavy.exit was written, so publish.sh refused.)
# GATED_FLOCK_YIELD_FILE (optional; the coordinator 2026-10-14, so the user's single real run goes first): while that file exists, the job
#   polls lock-free every GATED_FLOCK_YIELD_POLL_S (default 60 s), logs "yield: <path> present" and does not take the lock. It never holds
#   the lock while yielding: a job that gets the lock and then finds the file releases it at once, before the command starts, and yields
#   again. The give-up clock (GATED_FLOCK_MAX_S) does not count yield time.
#   Live-pid rule (the coordinator 2026-10-14, validator-8's findings): the marker holds "<pid> <label>". The job yields only while the file
#   exists AND that pid is alive; a dead pid logs "yield: stale marker <path> pid <n> dead, ignored" and does not yield.
#   Ruling (a) (the coordinator 2026-10-14, validator-8's gap 2): an empty marker or one with a non-numeric first field (a leftover of the
#   old "<ISO time>" format), and "0" or a leading zero (`kill -0 0` hits the caller's own process group; validator-8), is STALE too: it logs "yield: malformed marker <path>, ignored" and does not yield, so it never blocks for ever.
# Host faults, classify only (the coordinator 2026-10-14, W4H-31 commit): the command's exit always stands. If, while it ran, the kernel
#   logged a global OOM kill or the user's systemd manager restarted or stopped (resource-gate.sh host_fault_since), the wrapper logs
#   "HOST-FAULT: <why>" and writes <why> to <GATED_FLOCK_EXIT_FILE>.host-fault. A re-launch happens by hand, on the coordinator's word.
#   An older .host-fault file is moved aside (.prev-<time>) at the start, so the file always belongs to this run.
# Bun pin (team-lead ruling 2026-10-16, after the third hand-set-Bun-PATH incident: a job's own PATH line bypassed bun_pin and its hook
#   failed with BunSqlPipeliningGuardError): every command runs after bun_pin (w00/bun-pin.sh, one helper) of a tree with .bun-version:
#   GATED_FLOCK_BUN_REPO, else the git top level of the caller's directory, else the integration worktree. The command inherits the pin's
#   PATH head and BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING (set for 1.4.0-1.4.2, unset otherwise), so a later hand-set PATH keeps the flag.
#   A tree without .bun-version, or a pin mismatch, exits 95 (bun_pin's named refusal) and the command never runs.
#   node_pin (team-lead ruling 2026-10-16) follows in the same child from the same tree: .node-version → /tmp/factory-tools/node-<v>/bin first
#   on PATH, `node --version` asserted; its refusal is the same REFUSED line and exit 95.
#   The pin result is never thrown away (2026-10-16, w4h-35's bare exit 95): every run logs "bun pin repo=<tree> <ok line | REFUSED line>",
#   and a refusal also goes to <GATED_FLOCK_EXIT_FILE>.bun-pin (an older one is moved aside at the start, like .host-fault).
set -u
L=${1:?label} LOG=${2:?log}; shift 2
GLIB=${GATED_FLOCK_GATE_LIB:-evidence/w00/resource-gate.sh}; . "$GLIB"   # tests only: a stub gate file
HF=${GATED_FLOCK_EXIT_FILE:+$GATED_FLOCK_EXIT_FILE.host-fault}
BREPO=${GATED_FLOCK_BUN_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || echo /home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration)}
if [ -n "$HF" ] && [ -e "$HF" ]; then mv "$HF" "$HF.prev-$(date -u +%Y%m%dT%H%M%SZ)"; fi
BP=${GATED_FLOCK_EXIT_FILE:+$GATED_FLOCK_EXIT_FILE.bun-pin}
if [ -n "$BP" ] && [ -e "$BP" ]; then mv "$BP" "$BP.prev-$(date -u +%Y%m%dT%H%M%SZ)"; fi
LOCK=${GATED_FLOCK_LOCK:-/tmp/ezcorp-validation-heavy.lock}; max=${GATED_FLOCK_MAX_S:-14400}; poll=${GATED_FLOCK_POLL_S:-120}; t0=$(date +%s); tries=0; yielded=0
Y=${GATED_FLOCK_YIELD_FILE:-}; ypoll=${GATED_FLOCK_YIELD_POLL_S:-60}
left() { echo $(( max - ($(date +%s) - t0 - yielded) )); }
# yield_active <file> <label> <log>: 0 = yield now. Exported: the in-lock check runs it in the flock child.
yield_active() {
  [ -n "$1" ] && [ -e "$1" ] || return 1
  local p; read -r p _ < "$1" 2>/dev/null
  [[ "$p" =~ ^[1-9][0-9]*$ ]] || { echo "gated-flock $2: yield: malformed marker $1, ignored $(date -u +%FT%TZ)" >> "$3"; return 1; }
  kill -0 "$p" 2>/dev/null && return 0
  echo "gated-flock $2: yield: stale marker $1 pid $p dead, ignored $(date -u +%FT%TZ)" >> "$3"; return 1
}
export -f yield_active
yield_wait() { local y0; y0=$(date +%s); while yield_active "$Y" "$L" "$LOG"; do echo "gated-flock $L: yield: $Y present $(date -u +%FT%TZ)" >> "$LOG"; sleep "$ypoll"; done; yielded=$((yielded + $(date +%s) - y0)); }
finish() { [ -z "${GATED_FLOCK_EXIT_FILE:-}" ] || echo "$1" > "$GATED_FLOCK_EXIT_FILE"; exit "$1"; }
MG=${GATED_FLOCK_MEM_MARGIN_GIB:-0}; [[ "$MG" =~ ^[0-9]+$ ]] || { echo "gated-flock $L: REFUSED: GATED_FLOCK_MEM_MARGIN_GIB=$MG is not a whole number of GiB $(date -u +%FT%TZ)" >> "$LOG"; finish 2; }
RQ=${GATED_FLOCK_MAX_REQUEUE:-3}; [[ "$RQ" =~ ^[1-9][0-9]*$ ]] || { echo "gated-flock $L: REFUSED: GATED_FLOCK_MAX_REQUEUE=$RQ is not a whole number >= 1 $(date -u +%FT%TZ)" >> "$LOG"; finish 2; }
rqsrc="the default"; [ -n "${GATED_FLOCK_MAX_REQUEUE:-}" ] && rqsrc="set by the launcher"
echo "gated-flock $L: in-lock refusal bound GATED_FLOCK_MAX_REQUEUE=$RQ ($rqsrc) $(date -u +%FT%TZ)" >> "$LOG"; requeues=0
while [ "$(left)" -gt 0 ]; do
  yield_wait
  [ "$MG" -gt 0 ] && echo "gated-flock $L: start gate mem>=${GATED_FLOCK_START_MEM_GIB:-6}GiB+${MG}GiB margin $(date -u +%FT%TZ)" >> "$LOG"
  RESOURCE_GATE_MAX_WAIT_S=$(left) RESOURCE_GATE_DISK_GB=$((100 + ${GATED_FLOCK_START_MARGIN_GB:-4})) RESOURCE_GATE_SWAP_KIB=$((2097152 + ${GATED_FLOCK_START_MARGIN_SWAP_KIB:-524288})) RESOURCE_GATE_MEM_GIB=$(( ${GATED_FLOCK_START_MEM_GIB:-6} + MG )) resource_gate "$L outside-lock" "$LOG"; g=$?
  if [ "$g" -ne 0 ]; then [ "$g" = 91 ] && break; sleep "$poll"; continue; fi
  tries=$((tries + 1)); echo "gated-flock $L: gate green outside the lock, queue for the lock (try $tries) $(date -u +%FT%TZ)" >> "$LOG"
  ymark=$(mktemp -u "${GATED_FLOCK_TMPDIR:-/tmp}"/gated-flock-yield.XXXXXX); hmark=$(mktemp -u "${GATED_FLOCK_TMPDIR:-/tmp}"/gated-flock-host.XXXXXX); pmark=$(mktemp -u "${GATED_FLOCK_TMPDIR:-/tmp}"/gated-flock-pin.XXXXXX)   # GATED_FLOCK_TMPDIR: tests only
  flock --close "$LOCK" bash -c 'if yield_active "$1" "$3" "$4"; then : > "$2"; exit 0; fi; . "$5"; host_mark > "$6"; . "${BUN_PIN_LIB:-evidence/w00/bun-pin.sh}"; bun_pin "$7" > "$8" 2>&1; node_pin "$7" >> "$8" 2>&1; echo "ok bun $(bun --version) $BUN_PIN_DIR node $(node --version) $NODE_PIN_DIR" >> "$8"; shift 8; exec "$@"' _ "$Y" "$ymark" "$L" "$LOG" "$GLIB" "$hmark" "$BREPO" "$pmark" "$@"; rc=$?
  if [ -s "$pmark" ]; then pl=$(grep -m1 -E '^(REFUSED|ok bun)' "$pmark" || head -1 "$pmark"); echo "gated-flock $L: bun pin repo=$BREPO $pl" >> "$LOG"
    case "$pl" in REFUSED*) [ -z "$BP" ] || echo "$pl" > "$BP" ;; esac; fi; rm -f "$pmark"
  hm=$(cat "$hmark" 2>/dev/null); rm -f "$hmark"
  if [ -e "$ymark" ]; then rm -f "$ymark"; echo "gated-flock $L: yield file appeared while queued; lock released before the command $(date -u +%FT%TZ)" >> "$LOG"; continue; fi
  if [ "$rc" != 75 ]; then
    if [ -n "$hm" ] && why=$(host_fault_since $hm); then
      echo "gated-flock $L: HOST-FAULT: $why (the exit stands; re-launch only by hand) $(date -u +%FT%TZ)" >> "$LOG"; [ -z "$HF" ] || echo "$why" > "$HF"; fi
    echo "gated-flock $L: command exit $rc $(date -u +%FT%TZ)" >> "$LOG"; finish "$rc"; fi
  requeues=$((requeues + 1))
  [ "$requeues" -lt "$RQ" ] || { echo "gated-flock $L: gate red inside the lock, lock released, STOP: the re-queue bound is reached ($requeues of GATED_FLOCK_MAX_REQUEUE=$RQ): exit 76 $(date -u +%FT%TZ)" >> "$LOG"; finish 76; }
  echo "gated-flock $L: gate red inside the lock, lock released, re-queue $(date -u +%FT%TZ)" >> "$LOG"; sleep "$poll"
done
echo "gated-flock $L: GAVE UP after ${max}s (gate never green long enough, $tries lock tries)" >> "$LOG"; finish 91
