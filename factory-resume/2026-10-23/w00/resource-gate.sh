#!/usr/bin/env bash
# Shared resource gate for every integrator build, coverage run, test pool and heavy leg (source it).
#   resource_gate <label> [log]
# Disk: below 100 GB free on / it refuses at once (exit status 90) - the coordinator's floor.
# Memory, COMBINED HEADROOM (the user's decision 2026-10-16, after the false block of 2026-10-15 ~23:5xZ: 16 GiB available but swap
# free below 2.5 GiB held the W4H-31 hold outside the lock): it passes iff MemAvailable >= the memory floor (RESOURCE_GATE_MEM_GIB,
# default 6 GiB) AND MemAvailable + SwapFree >= the memory floor + the swap component (RESOURCE_GATE_SWAP_KIB, default 2 GiB), compared
# in KiB. Defaults give 6 / 8 GiB; gated-flock's outside wait 6 / 8.5 GiB; GATED_FLOCK_START_MEM_GIB=12 gives 12 / 14.5 GiB. Swap free
# 0 with enough available memory passes. (Before: 6 GiB available AND 2 GiB swap free, the rule of 2026-09-25/26.)
# It WAITS while red, rechecking every RESOURCE_GATE_POLL_S (default 60 s; tests 0), and gives up (status 91) after
# RESOURCE_GATE_MAX_WAIT_S (default 3600 s) of wait, naming the ONE condition that failed at the last check. Every check is appended to
# <log> when given, so the receipt shows what the host looked like at the start.
resource_gate() {
  local label=$1 log=${2:-/dev/null} waited=0 max=${RESOURCE_GATE_MAX_WAIT_S:-3600}
  local disk mem memk swap_total swap_free um why
  # Floors may be RAISED by the caller (RESOURCE_GATE_DISK_GB, RESOURCE_GATE_SWAP_KIB, RESOURCE_GATE_MEM_GIB), never lowered: a start margin above the
  # floor (lead 2026-10-04 19:05Z, after holds started at 100 GB voided when their own writes took the host to 98 GB).
  local disk_floor=${RESOURCE_GATE_DISK_GB:-100} swap_floor=${RESOURCE_GATE_SWAP_KIB:-2097152} mem_floor=${RESOURCE_GATE_MEM_GIB:-6}
  [ "$disk_floor" -ge 100 ] || disk_floor=100; [ "$swap_floor" -ge 2097152 ] || swap_floor=2097152; [ "$mem_floor" -ge 6 ] || mem_floor=6
  local mem_floor_k=$(( mem_floor * 1048576 )); local comb_floor=$(( mem_floor * 1048576 + swap_floor ))
  while :; do
    disk=$(_rg_disk_avail_gb); memk=$(_rg_mem_available_kib); swap_total=$(_rg_swap_total_kib); swap_free=$(_rg_swap_free_kib); mem=$(( memk / 1048576 ))
    echo "resource-gate $(date -u +%FT%TZ) $label disk=${disk}G memAvailable=${mem}GiB swapFreeKiB=${swap_free}/${swap_total} floors disk>=${disk_floor}G mem>=${mem_floor}GiB mem+swap>=${comb_floor}KiB (swap component ${swap_floor}KiB)" >> "$log"
    if [ "$disk" -lt "$disk_floor" ]; then echo "resource-gate $label STOP: disk ${disk}G below the ${disk_floor} GB floor" >> "$log"; return 90; fi
    # Rule of 2026-10-14 (W4H-31 commit, host OOM 22:55-23:12Z): the host must be settled (host_unsettled): the user's systemd manager
    # active and up for the quiet window, and no global OOM kill in it. Rootless Podman lives in that unit; while it was down
    # (23:02-23:38Z) every container and port forward was gone and crun could not create scopes.
    if um=$(host_unsettled); then why="host not settled ($um)"; echo "resource-gate $label WAIT: $why" >> "$log"
    elif [ "$memk" -lt "$mem_floor_k" ]; then why="memory ${memk}KiB below the ${mem_floor} GiB floor"
    elif [ $(( memk + swap_free )) -lt "$comb_floor" ]; then why="combined headroom $(( memk + swap_free ))KiB below the ${comb_floor}KiB floor"
    else return 0; fi
    if [ "$waited" -ge "$max" ]; then echo "resource-gate $label GAVE UP after ${waited}s: $why" >> "$log"; return 91; fi
    sleep "${RESOURCE_GATE_POLL_S:-60}"; waited=$((waited + 60))
  done
}

# Host-fault probes (the coordinator 2026-10-14, W4H-31 commit). gated-flock.sh classifies a run with them (HOST-FAULT line + file; the
# exit stands); resource_gate waits on host_unsettled. Tests redefine the four _rg_ host-fault probes and the four resource probes below.
#   host_mark                 prints "<epoch> <user-manager InvocationID>" at the start of a command
#   host_fault_since <epoch> <invocation>  prints the fault and returns 0 if, since <epoch>, the kernel logged a global OOM kill or the
#                             user manager restarted / is not active; returns 1 (prints nothing) if the host stayed intact.
#   host_unsettled            prints why and returns 0 if, in the last RESOURCE_GATE_QUIET_S (default and floor 300 s), the kernel
#                             logged a global OOM kill or the user manager started, or it is not active; returns 1 if settled.
#   A memcg OOM inside a test's own limited container is NOT a host fault (CONSTRAINT_MEMCG lines carry no "global_oom").
_rg_disk_avail_gb() { df -BG --output=avail / | tail -1 | tr -dc 0-9; }
_rg_mem_available_kib() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo; }
_rg_swap_free_kib() { awk '/^SwapFree:/ {print $2}' /proc/meminfo; }
_rg_swap_total_kib() { awk '/^SwapTotal:/ {print $2}' /proc/meminfo; }
_rg_user_manager_state() { systemctl show "user@$(id -u).service" -p ActiveState --value 2>/dev/null || echo unknown; }
_rg_user_manager_invocation() { systemctl show "user@$(id -u).service" -p InvocationID --value 2>/dev/null; }
_rg_user_manager_start_epoch() { date -d "$(systemctl show "user@$(id -u).service" -p ActiveEnterTimestamp --value 2>/dev/null)" +%s 2>/dev/null || echo 0; }
_rg_global_oom_since() { journalctl -k -q --no-pager --since "@$1" 2>/dev/null | grep -c 'global_oom'; }
host_mark() { echo "$(date +%s) $(_rg_user_manager_invocation)"; }
host_fault_since() {
  local since=$1 inv0=${2:-} n inv1 st why=""
  n=$(_rg_global_oom_since "$since"); inv1=$(_rg_user_manager_invocation); st=$(_rg_user_manager_state)
  [ "${n:-0}" -gt 0 ] && why="global OOM kills $n"
  [ "$inv1" != "$inv0" ] && why="${why:+$why; }user manager restarted"
  [ "$st" != active ] && why="${why:+$why; }user manager $st"
  [ -n "$why" ] || return 1
  echo "$why"
}
host_unsettled() {
  local q=${RESOURCE_GATE_QUIET_S:-300} since why start
  [ "$q" -ge 300 ] || q=300; since=$(( $(date +%s) - q ))
  why=$(host_fault_since "$since" "$(_rg_user_manager_invocation)")
  start=$(_rg_user_manager_start_epoch)
  [ "${start:-0}" -gt "$since" ] && why="${why:+$why; }user manager started $(( $(date +%s) - start ))s ago"
  [ -n "$why" ] || return 1
  echo "$why"
}
