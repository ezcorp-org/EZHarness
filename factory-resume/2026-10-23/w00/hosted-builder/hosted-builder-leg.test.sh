#!/usr/bin/env bash
# hosted-builder-leg.test.sh (w00 copy of w4h-35 aefac31cbf0d5189; HB_LEG=<file> tests a staged copy or a mutant): each case names the leg's expected exit and a line its log must carry.
set -u; H=evidence/w00/hosted-builder; L=${HB_LEG:-$H/hosted-builder-leg.sh}; T=$H/leg-test; REV=3698c8e84; pass=0; fail=0
case_() { local name=$1 want=$2 line=$3; shift 3; local out rc; out=$("$@" 2>&1); rc=$?
  if [ "$rc" = "$want" ] && grep -qF -- "$line" <<< "$out"; then pass=$((pass+1)); echo "ok   $name (exit $rc)"
  else fail=$((fail+1)); echo "FAIL $name: exit $rc (want $want), line '$line' $(grep -qF -- "$line" <<< "$out" && echo found || echo missing)"; printf '%s\n' "$out" | tail -5; fi; }
case_ "red: ADD --checksum on the hosted builder"  125 "ADD only supports the --chmod=<permissions> and the --chown=<uid:gid> flag" bash "$L" "$REV" "$T/red"
case_ "green: ADD then sha256sum -c"                 0 "/tmp/podman-remote.tar.gz: OK"                                         bash "$L" "$REV" "$T/green"
case_ "mutant: a wrong sum fails the build"          1 "/tmp/podman-remote.tar.gz: FAILED"                                     bash "$L" "$REV" "$T/mutant-sha"
case_ "repo layout: the factory Dockerfile, never the root one" 0 "builds deploy/factory/Dockerfile of the context"          bash "$L" "$REV" "$T/repo-layout"
case_ "G1: builder version differs"                  3 "RED: G1 builder reports 'podman version 4.9.3', the hosted job uses Podman 5.8.7" env HB_PODMAN=5.8.7 bash "$L" "$REV" "$T/green"
case_ "G2: runs-on differs"                          3 "RED: G2 ci.yml at"                                                     env HB_RUNS_ON=ubuntu-24.04 bash "$L" "$REV" "$T/green"
case_ "G3: base not on the host"                     3 "RED: G3 base docker.io/oven/bun:1.4.2@sha256:0000"                    bash "$L" "$REV" "$T/absent-base"
case_ "G3: literal FROM"                             3 "RED: G3 a literal FROM cannot be mapped"                               bash "$L" "$REV" "$T/literal-from"
echo "hosted-builder-leg.test: $pass pass $fail fail"; [ "$fail" = 0 ]
