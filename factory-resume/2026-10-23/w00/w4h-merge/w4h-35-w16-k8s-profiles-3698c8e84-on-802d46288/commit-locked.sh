#!/usr/bin/env bash
# W4H-35 merge commit at 3698c8e84 under the heavy lock (integrator-5; called by gated-flock). The full-run hook form (the coordinator's standing
# ruling): EZ_PRECOMMIT_TEST_MAX = the commit-time count of the hook list; commit.sh checks the mapping at commit time against config.sh's LIST.
# PG_HOOK is DERIVED by reprep.sh from the mapped list (w00/detached-merge/pg-hook-lib.sh) and commit.sh refuses a mismatch; with tests/postgres
# suites mapped, the hook runs on an OWN fresh pg15 (the W4H-27/W4H-31 form). A package merge: no IDENTITY_EXCLUDE.
set -u
E=evidence/w00; D=$E/w4h-merge/w4h-35-w16-k8s-profiles-3698c8e84-on-802d46288
. $E/lock-veto.sh; lock_veto integrator-2
. $E/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0 RESOURCE_GATE_MEM_GIB=12 resource_gate commit-start $D/commit-gate.log || { echo "gate red inside the lock: exit 75" >> $D/commit-gate.log; exit 75; }
. $E/own-pg.sh; own_pg_start w4h-35-commit-pg >> $D/commit-gate.log 2>&1 || exit 3   # the hook's tests/postgres suites on an OWN fresh pg15
LIST=$(sed -n 's/^LIST=\([^ ]*\).*/\1/p' $D/config.sh); [ -n "$LIST" ] && [ -f "$LIST" ] || { echo "no LIST in config.sh (or the file is missing)" >> $D/commit-gate.log; exit 3; }   # an EMPTY list is valid
export TC_IN_LOCK=1 EZ_PRECOMMIT_TEST_MAX=$(grep -c . "$LIST")
echo "hook full-run form: EZ_PRECOMMIT_TEST_MAX=$EZ_PRECOMMIT_TEST_MAX (the list $LIST); $(grep -o 'PG_HOOK=[01]' $D/config.sh)" >> $D/commit-gate.log
bash $E/detached-merge/commit.sh $D/config.sh; rc=$?
echo "commit.sh exit=$rc $(date -u +%FT%TZ)" >> $D/commit-gate.log; exit $rc
