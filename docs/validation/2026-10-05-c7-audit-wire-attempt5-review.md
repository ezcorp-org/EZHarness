# One c7 cleanup with the production audit command verified

Status: final packet sealed; independent final review and fresh host checks
precede one execution. This is a fresh attempt under the user's continuing
E2E goal. It does not reuse a consumed request or its approval.

## Exact change

[Attempt 4](2026-10-05-c7-synchronous-review-attempt4-result.md) ended with a
committed no-admission abort and verified full restoration. Its 49 ledger files
are preserved. The app remains healthy on source
`5080f3792dbbedcdae17b81368ed9ee83ba41b80`, manifest
`f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.

The forced-command gate now accepts the production v3 verifier's exact pinned
audit command. It checks the audit path, hash and `frozen-until` verb, enforces
the 180-second audit horizon and sealed runtime limit, verifies the rollback
lease, then runs a fixed argument array. Transport commands retain their
five-second limit. No arbitrary shell command is permitted.

The original target remains START `c7b5f35d-aa75-421f-aa6b-0741840c8c39`, guest
`ezh-e527e87eb409d89f6e70d58c8ea4a49b`, connection
`fdede86e-6cef-4d66-913a-49c8c3bf36e8` revision 1, host generation 1 and backend
generation 2. The new recovery identity has nonce
`523e0afd2fc3dd15938a75679fc3eeba` and review ID
`incus-fenced-cleanup-c7b5-start-v2-oct05-attempt5`.

## Sealed packet

| Item | SHA-256 |
| --- | --- |
| Execution index | `0ecce6cbf6ca57675ed8ebf827a2b5d6ed2a436b2786ef993127e25c5c8243f2` |
| Dependency index | `780c3d5ac18aaa3e3008cc8e389f703321838cfd4e72fb02b59cd54a22597ebd` |
| Runner | `f362409cbb0e9c0b7eded8a52e2c5dfc05405e542345db09865a26a3b040d827` |
| Operational component | `839b18f2866e1607056215304083a80a3250949d80bf3acb864edb5adb57537c` |
| Dispatcher | `2dfcd0608f8d595b8d5cdb5f5d04b1ee808e2dc8f3d05a7399700009a0a402f8` |
| Consumer validator | `8f6fff59b52bfd40b0cb20ece3b804a7c6f167839cd3ab36e8a5172181878101` |
| Production composition check | `6d1989150f6c8583f5f028e3c5d050a3617dfa2c7da9b7e75635cbc2eb6205ee` |
| Post-abort disposition | `9ad4162a3bae704efdbe15afc8d9f69266e471de3b56496f0c510c86cbfa1196` |
| Post-abort runner pins | `59bb0946d168b39a8204fd90cbd1c85baa9ca572dc39bef3c8c538d310c0bd78` |
| Full sanitized metadata | `de8bdada8060f07fc9469934521415ea6d6fd306b358149c485db0d75b76827e` |

Entry: `/root/ezh-qualification-stage/oct05-c7-recovery-packet-attempt5/next_attempt.py`.
The execution index is in that directory. Access, runtime and ledger use the
same attempt5 namespaces as the sealed metadata. Server stage:
`/root/ezh-c7-recovery-20261005-attempt5`. Private directories are root-owned
0700; indexed files are root:root 0600 with one link.

Metadata: `/home/dev/work/EZCorp/EZHarness/.worktrees/incus-final-live-sol61-oct05/.cache/c7-attempt5-prep/final-sanitized-metadata.json`.

## Execution and restoration

1. Recheck packet hashes, preserved evidence, target, source, keys and host
   capacity. All owned heavy builds/tests must be idle. Wait for suitable host
   conditions; do not terminate another project's work.
2. Complete the existing guarded actor pause, five exact configuration backups
   and runner-marker handling before binding one 420-second runtime. Stage only
   sealed files. Arm and prove the actual 600-second thaw-first rollback before
   installing the source-restricted forced-command root key.
3. After the access batch freezes the operator slice, send one read-only audit
   command through the actual temporary root SSH gate. Use the production v3
   command bytes, exact audit hash/path and deadline
   `min(runtimeDeadline, now + 170000 ms)`. Require exactly `frozen`, `nowMs`
   and `timerDeadlineMs`, a true frozen state, at most five seconds of clock
   skew, and more than 125 seconds of timer margin beyond that audit deadline.
   Save the actual SSH result. Do not simulate local fence success.
4. Preserve the existing 300-second capture, 240-second continuation,
   200-second management, 180-second recovery and 30-second review-age guards.
   Start the bounded waiter. The independent reviewer checks the actual access
   and audit-wire results, then publishes once. The waiting process continues
   immediately. Do not refresh or replace a review receipt.
5. Fence only the original restricted provider certificate and submit one
   supported cleanup. Require a separate DESTROY SUCCEEDED, binding ABSENT,
   restored certificate/transport and healthy app. Preserve the original START
   as UNKNOWN. Record actual reservations separately; do not infer release.
6. Close temporary access, prove thaw/key absence and fallback completion,
   then independently check the saved operation, backend and app state.

The previous one-attempt authority limits remain: exact named server/project,
same isolated app and provider, no new guest, provider activation, account,
network/firewall/NixOS change, or database restore.

Failure before authority uses the existing verified expiry and exact guarded
local restoration. Failure after a possible admission retains the hold and
uses supported recovery. A committed signed no-admission abort may use the
pre-reviewed post-abort helper. That helper requires independently reviewed,
hash-pinned evidence of the actual committed abort before certificate,
configuration or startup effects. Future evidence files do not exist yet and
must never be synthesized. A result lost after an effect is not permission to
repeat it. No consumed clock, nonce, START or cleanup is replayed.

## Validation boundary

Passed: actual final 21-file consumer validation, actual installed supervisor
and v3 command composition with the final dispatcher, actual read-only source
bootstrap, current c7/inventory checks, 21 prior gate regressions, six production
composition tests, 13 runner tests, 18 component tests, 13 review-handoff tests,
nine post-abort tests and binder/key/index checks. Composition fixtures use
mocked process/timer/SSH boundaries; actual access, audit wire and cleanup remain
required in this attempt. No live success is claimed by this plan.
