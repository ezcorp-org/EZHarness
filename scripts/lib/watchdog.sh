#!/usr/bin/env bash
# Per-worker CPU-progress watchdog for the backend test pool (scripts/test.sh).
#
# THE INCIDENT THIS CLOSES: a peer session had to hand-kill two of this repo's
# test processes to stop an active OOM — the box was at 100% of memory with
# ZERO swap free and memory-pressure stall at 48% over five minutes; the
# kernel had already OOM-killed a 14GB process on its own. The two processes
# were children of `bash scripts/test.sh`, each a `bun test --timeout 30000
# ./src/__tests__/<file>` worker, sitting in uninterruptible D state for 16+
# MINUTES — ~33x their own declared 30s timeout. Sampled 5s apart, each
# advanced only ~1s of CPU per 5s of wall clock while RSS shrank: they were
# thrashing on swap, not computing. `--timeout 30000` bounds a test's hooks
# and assertions INSIDE a healthy process; it bounds nothing once the process
# is stuck waiting on IO, and the pool kept fanning out fresh workers behind
# the stuck ones — one wedged test became a dead machine instead of one
# failed test.
#
# WHY NOT A WALL-CLOCK KILL: this repo's own measurements make that actively
# wrong. A DB suite's `beforeAll` restores a migrated PGlite datadir at
# 3.2-6.4s per process on a loaded box (vs. 0.7-0.9s warm) — see
# src/__tests__/helpers/pglite-snapshot-cache.ts and CLAUDE.md. 20 concurrent
# copies of one file go 20/20 red under bun's bare 5s hook budget and 20/20
# green at 30s, same code, purely load. A pool whose honest slow path is
# already ~8x its fast path will have healthy workers that LOOK stalled by
# elapsed time alone; a wall-clock watchdog fires most often exactly when the
# box is busiest — the worst possible time to lose a result and blame the
# code.
#
# THE SIGNAL THAT ACTUALLY WORKS: CPU time not advancing. Two D-state
# processes waiting on IO/swap do not execute instructions; every real
# forward step a HEALTHY process takes — computing, parsing a query,
# replaying a migration, even servicing its own page faults — burns at least
# one CPU clock tick (10ms at the standard 100Hz USER_HZ). A process that
# consumes literally ZERO additional ticks for a full, generous window is not
# "slow" by any definition this codebase's own numbers support; it has
# stopped executing. That is the one thing a wall-clock timer cannot tell
# apart from "busy machine, honest work" and a CPU-tick comparison can.
#
# PARAMETERS AND WHY:
#   EZ_TEST_WATCHDOG_INTERVAL_SECS (default 10) — how often we sample
#     /proc/<pid>/stat. Purely a polling-overhead/precision knob (a `sleep 10`
#     loop costs nothing); it does NOT gate the kill decision by itself (see
#     next).
#   EZ_TEST_WATCHDOG_STALL_SECS (default 60) — how long the CPU-tick counter
#     must sit COMPLETELY UNCHANGED, wall-clock, before we call a worker
#     wedged. 60s is ~9x the worst measured legitimate cold-start cost above
#     (6.4s) and 2x bun's own --timeout 30000, so a healthy worker's own
#     per-test ceiling fires first if anything does; this watchdog only ever
#     engages for stalls bun's per-test timer structurally cannot see — a
#     module-load hang or a synchronous OS-level block, exactly the incident's
#     shape. 60s is also >>15x FASTER than the incident's 16-minute (960s)
#     stall, so a wedge is now caught and reaped long before it can drag
#     sibling workers into an OOM cascade.
#   EZ_TEST_WATCHDOG (default 1; "0" disables) — escape hatch, same pattern as
#     EZ_PGLITE_SNAPSHOT_CACHE=0.
#
# WHY THIS NEVER KILLS PROGRESSING WORK (the property that matters most — a
# watchdog that fires on healthy work is worse than none): the ONLY thing
# that resets the stall clock is ANY nonzero change in utime+stime between
# samples, at ANY duty cycle. A process doing real work — however slowly,
# however IO-bound — accumulates at least one tick well within a 10s sample
# window, which immediately re-arms the full EZ_TEST_WATCHDOG_STALL_SECS
# budget from zero. The kill path requires an unbroken run of zero-tick
# samples spanning the ENTIRE threshold, not a low duty cycle, not one quiet
# sample. There is no threshold-tuning that trades this away: shrinking the
# interval only samples more often, it does not change what counts as
# "moved".
#
# WHY SIGKILL, not SIGTERM: a process parked in kernel TASK_UNINTERRUPTIBLE
# (D) cannot be woken by ANY signal, including SIGKILL, until it returns from
# the blocking syscall — SIGTERM would just queue uselessly behind the same
# wall, with the added risk of being caught/ignored on a subsequent grace
# period we don't have time for anyway (we're already 60s+ into a confirmed
# stall). SIGKILL is the only signal that (a) cannot be intercepted, and
# (b) is guaranteed to fire the instant the process becomes killable again
# (e.g. between two blocking syscalls, which is how the incident's processes
# were sampled making SOME tick progress at all).
#
# WHY THE WHOLE PROCESS GROUP, not just the one pid: a wedged test may itself
# have spawned a child that is what's actually stuck (this file's own
# verification fixture does exactly that, deliberately). Killing only the
# parent would orphan that child as a stray process on a SHARED box — the
# opposite of this feature's purpose. See ez_watchdog_run_file below for how
# group-leadership is established via `setsid`.
#
# Deliberately does NOT `set -u`/`set -e` here: this file is `source`d into
# scripts/test.sh, and shell options set while sourcing leak into the
# sourcing script for the rest of its run. test.sh already manages its own
# `set -e` and scopes `set +e` around the per-file subshells; this library
# just has to behave correctly under whatever the caller has active.

# Read /proc/<pid>/stat and expose two globals: WD_STATE (single-char process
# state, e.g. R/S/D/Z) and WD_TICKS (utime+stime, in clock ticks). Returns 1
# if the pid is gone or /proc is unreadable (never partially updates the
# globals on failure).
#
# Field layout per `man 5 proc`: 1=pid 2=(comm) 3=state 4=ppid ... 14=utime
# 15=stime. `comm` is attacker/test-controlled and may itself contain spaces
# or parentheses, so the ONLY safe split point is the LAST ')' on the line —
# everything after it is positional and space-delimited. Relative to that
# split, state is token 0 and utime/stime are tokens 11/12 (0-indexed).
_ez_watchdog_read_stat() {
  local pid="$1" line rest
  line=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
  [ -n "$line" ] || return 1
  rest="${line##*) }"
  local -a f
  read -ra f <<<"$rest"
  [ "${#f[@]}" -ge 13 ] || return 1
  WD_STATE="${f[0]}"
  # 10#... forces base-10 (a leading-zero tick count would otherwise be
  # misread as octal by bash arithmetic).
  WD_TICKS=$((10#${f[11]:-0} + 10#${f[12]:-0}))
  return 0
}

# Poll one worker pid until it exits or has gone EZ_TEST_WATCHDOG_STALL_SECS
# with zero cpu-tick movement, in which case it writes a self-describing
# diagnostic to $3 and SIGKILLs the worker's whole process group. Meant to be
# run in its own background subshell (see ez_watchdog_run_file) — it exits
# quietly (no diagnostic, no kill) the moment the worker finishes on its own,
# which is the overwhelmingly common case.
_ez_watchdog_loop() {
  local pid="$1" label="$2" wdfile="$3"
  local interval="${EZ_TEST_WATCHDOG_INTERVAL_SECS:-10}"
  local threshold="${EZ_TEST_WATCHDOG_STALL_SECS:-60}"

  if [ "${EZ_TEST_WATCHDOG:-1}" = "0" ]; then
    return 0
  fi
  if [ ! -r "/proc/$pid/stat" ]; then
    # No /proc (non-Linux dev box) or the worker already exited before our
    # first look. Either way there is nothing safe to act on — stay out of
    # the way. This watchdog only ever ADDS a kill decision on top of the
    # normal `wait`; it never removes one.
    return 0
  fi

  local prev_ticks="" last_change_ts
  last_change_ts=$(date +%s)

  while :; do
    sleep "$interval"

    # Gone already — the common path (the file finished during our sleep).
    kill -0 "$pid" 2>/dev/null || return 0

    WD_STATE="" WD_TICKS=""
    _ez_watchdog_read_stat "$pid" || return 0 # exited between the two checks above

    local now
    now=$(date +%s)

    if [ "$WD_TICKS" != "$prev_ticks" ]; then
      # Forward progress since the last sample, at any duty cycle — this is
      # the entire false-positive guard. Re-arm the full budget from zero.
      prev_ticks="$WD_TICKS"
      last_change_ts="$now"
      continue
    fi

    local idle=$((now - last_change_ts))
    if [ "$idle" -ge "$threshold" ]; then
      local state_note
      case "$WD_STATE" in
      D) state_note=" (D = kernel TASK_UNINTERRUPTIBLE — blocked on IO/swap, can't even take a signal until it next surfaces from the blocking call; the incident's exact signature)" ;;
      S) state_note=" (S = interruptible sleep — blocked on a syscall, e.g. waiting on a child process or a socket, that is never returning)" ;;
      Z) state_note=" (Z = zombie — exited but not yet reaped; its cpu time is fixed and cannot move by definition)" ;;
      *) state_note="" ;;
      esac
      {
        echo "=========================================================="
        echo "WATCHDOG KILLED THIS WORKER — THIS IS NOT A TEST FAILURE"
        echo "=========================================================="
        echo "file:    $label"
        echo "pid:     $pid"
        echo "stalled: ${idle}s wall-clock with ZERO cpu-time progress (threshold: ${threshold}s)"
        echo "evidence: /proc/$pid/stat utime+stime held at exactly $WD_TICKS clock"
        echo "          ticks (100/sec) across the entire stall window — not a low"
        echo "          duty cycle, an UNBROKEN run of samples with no movement at"
        echo "          all. Last observed process state: '$WD_STATE'${state_note}."
        echo ""
        echo "This is NOT bun's --timeout 30000 firing: that mechanism bounds a"
        echo "healthy process's hooks/assertions from INSIDE a running event loop."
        echo "This process was not running a test slowly — it was not running at"
        echo "all. It was killed by the per-worker CPU-progress watchdog"
        echo "(scripts/lib/watchdog.sh) so one wedged file cannot swap-thrash the"
        echo "whole shared machine the way it did in the incident this guards"
        echo "against (a peer session hand-killing two 16-minute-stalled workers"
        echo "during an active OOM with zero swap free)."
        echo ""
        echo "Do NOT debug this as a logic bug in the test body. Investigate host"
        echo "memory/IO pressure at the time of the run, or — if it reproduces on"
        echo "an idle machine — an indefinite blocking call (a syscall or an"
        echo "unresolved promise) that bun's own timeout cannot preempt."
      } >"$wdfile"
      # Kill the whole process GROUP (see header) so a child the worker itself
      # spawned can't survive as an orphan. `-$pid` targets the group only
      # when $pid is its own group leader (see ez_watchdog_run_file's
      # `setsid`); fall back to a plain kill of the pid if that group doesn't
      # exist for any reason (e.g. setsid unavailable on this host).
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
      return 0
    fi
  done
}

# Run one bun test file to completion under the watchdog above. This is the
# EXACT function scripts/test.sh's pool loop calls per file — the
# verification fixtures call it directly too, so what gets demonstrated is
# the shipped code path, not a re-implementation of it.
#
# Writes combined stdout+stderr to $2, bun's exit code to $3, and — ONLY if
# the watchdog had to intervene — a self-describing kill diagnostic to $4
# (the file is otherwise left absent, never created empty, so callers can use
# `[ -f "$4" ]` as the single "was this one watchdog-killed" test).
ez_watchdog_run_file() {
  local test_file="$1" outfile="$2" codefile="$3" wdfile="$4"
  shift 4
  local extra_args=("$@")

  rm -f "$wdfile" 2>/dev/null

  local -a runner
  if command -v setsid >/dev/null 2>&1; then
    # `setsid CMD` (no -f) calls setsid(2) and then execs CMD IN PLACE — the
    # pid bash hands back via $! below is bun's own pid, now also its own
    # session/process-group leader. That is what makes the group-kill above
    # possible; without it we can only ever kill the single pid.
    runner=(setsid bun)
  else
    runner=(bun)
  fi

  "${runner[@]}" test --timeout 30000 "${extra_args[@]}" "./$test_file" >"$outfile" 2>&1 &
  local bun_pid=$!

  ( _ez_watchdog_loop "$bun_pid" "$test_file" "$wdfile" ) &
  local wd_pid=$!

  wait "$bun_pid"
  local code=$?

  # The worker is done, one way or another — stop policing it. The loop also
  # self-terminates within one poll interval on its own (its `kill -0`
  # check), but reaping it here means no leftover sleep loop outlives the
  # file it was watching, which matters when the box is shared.
  kill "$wd_pid" 2>/dev/null
  wait "$wd_pid" 2>/dev/null

  echo "$code" >"$codefile"
  return "$code"
}
