# One c7 recovery with synchronous review delivery

Status: sealed packet and independent review passed. Execution is limited to
one attempt after fresh host capacity and target checks.

The user's continuing E2E goal authorizes this next scoped recovery. This is
not a claim that the user approved this previously unseen digest. The root
agent reviewed the concrete plan below. Earlier attempts are consumed and
remain immutable.

## Reason and scope

[Attempt 3](2026-10-05-c7-canonical-key-attempt3-result.md) proved temporary
access, but stopped before certificate fencing or cleanup admission because
the review receipt was stale. Its timer, key, freeze and local configuration
changes are closed. The original START remains UNKNOWN.

This attempt preserves the exact target, authority, sequence, failure handling,
420-second recovery deadline and 600-second maximum access lifetime in the
[previous scope](2026-10-05-c7-canonical-key-attempt3-review.md). It uses fresh
attempt4 paths and hashes. It adds a one-time review publisher and a bounded
waiting operator process. The independent reviewer checks actual access proof,
then publishes once. The waiting process consumes that receipt immediately and
calls the existing continuation. The 30-second review age limit and all
300/240/200/180-second margin checks remain unchanged.

Target: START `c7b5f35d-aa75-421f-aa6b-0741840c8c39`, guest
`ezh-e527e87eb409d89f6e70d58c8ea4a49b`, connection
`fdede86e-6cef-4d66-913a-49c8c3bf36e8` revision 1. Installed source remains
`5080f3792dbbedcdae17b81368ed9ee83ba41b80`, manifest
`f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.
The guest is stopped, host generation 1 and backend generation 2.

## Sealed files

| Item | SHA-256 |
| --- | --- |
| Execution index | `ebb5bbdad629587e4d1f28d4fcd1d978becceb79f671618615e3801197d3b4b4` |
| Dependency index | `d9e9524734fd14924ca927ea5caa323c468a28cfa2dcba61cbc774be62aab000` |
| Recovery runner | `cdac948088da4e466f9f698fa8d59adae462417f838d2af08cd4015fdbc4eeeb` |
| Operational component | `2abdf36858f913cf63009faa161415026ede94455b90b3f1724262119adf4545` |
| Final consumer validator | `21031de51cf2e46ff8584fb20aba9484485bc6d475bea72dc895e861524387e3` |
| Sanitized full metadata | `68991a2d32bcc2f8526a745ff478ceddee7d5f13685072993e38c450db7a152f` |

Entry: `/root/ezh-qualification-stage/oct05-c7-recovery-packet-attempt4/next_attempt.py`.
The execution index is in the same directory. The full metadata is at
`/home/dev/work/EZCorp/EZHarness/.worktrees/incus-final-live-sol61-oct05/.cache/c7-attempt4-prep/final-sanitized-metadata.json`.
It pins all 21 dependencies and private evidence receipts 210–215.

Access: `/root/ezh-qualification-stage/oct05-c7-recovery-access-attempt4`.
Runtime: `/root/ezh-qualification-stage/oct05-c7-recovery-runtime-attempt4`.
Ledger: `/root/ezh-qualification-stage/oct05-c7-operational-attempt4`.
Server: `/root/ezh-c7-recovery-20261005-attempt4`.
Directories are root-owned 0700; indexed files are root:root 0600 with one link.

## Execution and failure rules

1. Wait for enough host memory and idle local heavy checks. Do not stop another
   project's processes. Recheck hashes, exact installed app, target and absent
   root keys. Preserve all earlier evidence.
2. Prepare isolated actor pause, five backed-up configurations and the empty
   runner marker before binding the clock. Bind once and stage only sealed files.
3. Run the exact access batch. Prove the actual root timer and thaw-first
   rollback before key installation. Capture actual access proof with at least
   300 seconds left. No generated preview counts as timer or SSH proof.
4. The sole operator starts `await-review` with exact runtime and batch hashes.
   The reviewer verifies the actual proof, then invokes `publish-review` once
   with those hashes and `--independent-pass`. No manual timestamp, refreshed
   receipt, replacement or retry is allowed.
5. The waiting process continues through the unchanged guards. Fence the exact
   restricted certificate and submit one supported cleanup. Require a separate
   DESTROY SUCCEEDED, binding ABSENT, restored certificate/transport, no hold and
   a healthy app. Preserve the original START as UNKNOWN.
6. Remove the exact temporary access, prove thaw and prior key absence, record
   the actual marker owner/mode, and wait for the fallback timer's final state.

A publication error after receipt visibility does not prove no effect. Inspect
the waiting process and authority journal before recovery or restoration. Never
retry an uncertain mutation. Before admission, use only verified expiry and
supported exact configuration/marker restoration. After fence intent or possible
admission, retain holds and use supported recovery. No database restore, saved
START replay, new guest, account, provider release, network or NixOS change is
part of this attempt.

## Validation boundary

Independent review rehashed 32 files, verified fresh runtime/server/ledger
paths, and confirmed all 38 attempt3 ledger files unchanged. Actual final
consumer validation and read-only installed-app/target checks passed.
The handoff's 13 tests and original component's 18 tests passed independently.
Tests include stale and duplicate review rejection, partial publication, lost
publication acknowledgement, and immediate one-time continuation.

This document records readiness, not recovery success. Actual timer, SSH,
cleanup and restored-state evidence must be recorded after execution. The
complete normal sandbox E2E workflow and current-source full gate remain open.
