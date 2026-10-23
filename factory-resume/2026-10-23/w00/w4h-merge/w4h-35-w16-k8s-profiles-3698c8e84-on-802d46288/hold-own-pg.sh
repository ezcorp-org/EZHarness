#!/usr/bin/env bash
# W4H-35 hold (called by gated-flock): the standard w4f-merge/hold-w4f.sh with its PostgreSQL legs (pg() in heavy-lib.sh) on an OWN fresh
# pg15 (w00/own-pg.sh), never the shared proof server (the W4H-12 form). Exit 75 from the hold = re-queue; the trap removes the server.
# v2 (team-lead ruling 2026-10-21, W4H-35 expected sets EMPTY): after the hold, both gate-integrity legs of merge-commit-gates.sh must be the
# 0-findings form (w00/gate-leg.sh gate_leg_ok: the exact PASSED line, no FAILED/BYPASSED/ERROR line); a red names itself in hold-gate.log.
# The hold base B = HEAD^1 (802d46288); its tree is recorded beside 063b3d16e's (the ruled base) in hold-gate.log.
set -u
E=evidence/w00; D=${1:?dir}; I=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
. $E/lock-veto.sh; lock_veto integrator-2
. $E/gate-leg.sh || exit 3
. $E/own-pg.sh; own_pg_start w4h-35-hold-pg >> $D/hold-gate.log 2>&1 || exit 3
echo "hold base: HEAD^1 $(git -C $I rev-parse HEAD^1) tree $(git -C $I rev-parse HEAD^1^{tree}); 063b3d16e tree $(git -C $I rev-parse 063b3d16e^{tree})" >> $D/hold-gate.log
bash $E/w4f-merge/hold-w4f.sh $D; rc=$?
g=0; for l in origin-main base; do gate_leg_ok $D/cov/gate-integrity-$l.log gate-integrity-$l $D/hold-gate.log || g=1; done
echo "gate-leg 0-findings form: $([ $g = 0 ] && echo PASS || echo RED) (hold-w4f.sh exit $rc) $(date -u +%FT%TZ)" >> $D/hold-gate.log
[ $rc -ne 0 ] && exit $rc; exit $g
