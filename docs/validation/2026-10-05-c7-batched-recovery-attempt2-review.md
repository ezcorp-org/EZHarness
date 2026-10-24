# One bounded recovery of the preserved c7 START

Status: preparation and independent review passed; awaiting new exact approval.
No runtime deadline, access lease, server key, or recovery effect has been
started by this packet. Approval covers one attempt only.

## Why another approval is needed

The previous approved attempt ended SAFE_ABORT before certificate revocation,
signing, or recovery admission. It did not have the required time remaining.
Receipts 151–153 confirm restoration, removal of its temporary root key, and
thaw of the server user. Its one-attempt approval is closed. The original
packet and ledger remain preserved.

The later c07 app update timed out while copying the candidate. It did not
replace the active app. Receipts 166–169 confirm restoration of the original
app and preservation of the target. There was no database restore or replay.

This new packet completes expensive preparation before the timer starts,
batches the fixed access checks, and handles the existing runner marker
explicitly. It retains the same 600-second maximum access window and all
recovery time checks. A new temporary root-access window needs new approval.

## Exact target and access

| Field | Pinned value |
| --- | --- |
| Server | `sandbox-server.taile1c5b0.ts.net` |
| Installed app source | `5080f3792dbbedcdae17b81368ed9ee83ba41b80` |
| Installed app manifest | `f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748` |
| Preserved START | `c7b5f35d-aa75-421f-aa6b-0741840c8c39` — UNKNOWN |
| Guest | `ezh-e527e87eb409d89f6e70d58c8ea4a49b` — STOPPED, backend generation 2 |
| Binding | `incus-qual-binding-4dc7f05ef5012b3da0359bd703db9c9a0a5dd983ebd2c82085bb8ea55ea4ea4a` — host generation 1 |
| Connection | `fdede86e-6cef-4d66-913a-49c8c3bf36e8` — revision 1 |
| Restricted Incus certificate | `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622` — project `ezharness` |
| Allowed SSH source | `100.77.117.56` only |
| Temporary root key file | `/etc/ssh/authorized_keys.d/root` |
| Public key fingerprint | `SHA256:9+VVbYWAy12Hgxm15QREVbvUysmBz84tsMqHK0g0rjU` |

Both root authorized-key paths must be absent before installation. Add only
the pinned source-restricted entry with its forced command. There is no
general shell or arbitrary argument dispatch. The only SSH commands are
`c7-lease probe`, `c7-lease freeze`, `c7-lease verify`, `c7-lease thaw`, and
the exact sealed transport wires for `verify`, `restore`, `observe`, `fence`,
and `fence-state`.

Approval includes staging the pinned files, pausing only the isolated app and
runner, rotating their five exact recovery configurations, handling their
runner marker, temporarily fencing the named certificate and server operator
slice, one signed supported cleanup request, and restoration and access
removal. It does not include an app update, new guest, provider activation,
NixOS activation, firewall/network change, account creation, or database restore.

## One-attempt procedure

1. Check all pinned files and installed identities again. Preserve the first
   attempt ledger and the unused c07 copy. Require fresh host headroom and no
   overlapping builds or tests. Do not stop unrelated project processes.
2. Before binding any clock, pause the isolated actors, back up and hash all
   five old configurations, install only the exact preview configurations,
   and preserve/remove only the verified original empty runner marker
   `/run/ezharness-qual-runner-allow-start` (root:62040, mode 0600).
3. Bind one same-boot fixed deadline through the pinned pure binder. Stage
   only the closed server files. Never extend, rebind, or replay this attempt.
4. Run the fixed batch: arm the independent expiry timer, check the actual
   loaded service and absolute monotonic deadline, install the exact key,
   prove the forced-root route, freeze `user-1000.slice`, and verify it.
   The root service must run in `system.slice`; its first command must
   unconditionally thaw the user before the pinned expiry helper runs.
   Validate the actual timer before key installation. Retain at least the
   required 120-second rollback margin.
5. Capture the completed access proof with at least 300 seconds of recovery
   time left. Obtain one independent review of that actual proof, then
   continue only with at least 240 seconds remaining.
   The existing 200-second management and 180-second recovery guards remain.
   This proof review is a guard inside the approved attempt, not another
   permission request.
6. Fence only the named certificate. Observe the exact stopped generation-2
   guest and absence of active operations. Start fenced management and submit
   one signed cleanup through the supported broker. Do not replay START or
   claim that START had no effect.
7. The supported supervisor restores the certificate and transport before
   recovery returns. Then require a separate cleanup DESTROY receipt with
   SUCCEEDED and binding ABSENT. Preserve the original START as UNKNOWN.
   Prove the recovery hold is absent and the app is healthy,
   and record the actual empty root:root mode-0600 marker retained by the
   recovery core. Do not misreport that as the original marker metadata.
8. Run `c7-lease thaw` through the pinned expiry path: thaw first, remove only
   the exact installed key, and prove prior key-file absence is restored.
   Keep the one-shot timer as the independent fallback. Save final key,
   slice, certificate, guest inventory, cleanup, and app readbacks.

## Failure and restoration rules

Before admission, restore only recognized configuration bytes: exact original,
exact preview, or all three independently validated pure-binder runtime outputs.
Check actual installed bytes first. Unused partial runtime files must not
prevent restoration of unchanged original or preview configurations. Unknown
installed bytes stop restoration before overwrite.

Restore all five old configuration hashes, then the original marker's owner,
mode, and empty content before normal app resume. Record its new inode; do not
claim the original inode survived removal. Before any key-install intent, the
abort path may use only pinned expiry through existing dev sudo after proving
both root keys absent and the dev user unfrozen. After uncertain installation
or freeze, use only forced-root thaw. A failed route leaves actors paused and
must not be reported as a successful restoration.

Certificate-fence, recovery, or held-resume intent forbids the pre-admission
abort path. After an uncertain admitted effect, preserve the hold and evidence
and use supported recovery; do not overwrite state or retry the operation.
The expiry path still thaws the operator and removes only the exact key.
On reboot, the dispatcher rejects the changed boot; any remaining exact key
requires verified operator removal.

## Sealed execution packet

Entry: `/root/ezh-qualification-stage/oct05-c7-recovery-packet-attempt2/next_attempt.py`.
The root-owned directories are mode 0700; indexed files are root:root, mode
0600, with one link. The execution index pins all 24 reviewed files. Its
dependency index excludes the runner/component to avoid a circular digest;
the execution index pins those files directly.

| Item | SHA-256 |
| --- | --- |
| Execution index | `36d0365097aabb2b7c912c160a51dce8317d39c3939eb4c5bb78afdbcfbd9726` |
| Dependency index | `369922987b7194214be3fa2c0b44263fed2150a77138d194221aec6d48285a62` |
| Recovery runner | `099a0de473e2b63252e0ab3a187baccc0c05f97d4cc91adc5f331383c965d226` |
| Operational component | `6a1998a74ae2b073455c2db7172c914f53321cc8b281155c8fdcc2c1e8633706` |
| Pure runtime binder | `81c3e09dc124233a6ee38155b3c9cea12f5519199b51af1221033d5bd8e004be` |
| Forced dispatcher | `3c5f7d2f40d535055475bee7edb6e5468fbe3cff5d06a2d761fe4dd5bc37680c` |
| Expiry helper | `099e645aa5c8472326544efc1d45fd5b14eb4aabec34e8d4f830f45782831ef0` |
| Key installer | `e18ace9c4a8f81e1c4d3462ed5160e3db7807964c26744f271daab794f398148` |
| Recovery core | `bb1a887c14b5a9f6e444e881182d5c396d3c16d793c81f49c4845aa4a98e88b4` |
| Server transport | `5bc8a2607a7fe6b814ae8400be24a2c466086d6cd534247bc0b588c63369424e` |
| Read-only preparation receipt | `3fcd7651f5bc8c5a64d5cdf49f938b95b3ecc777ad25b5c6a5d81a2641dea153` |

Supporting access files are under
`/root/ezh-qualification-stage/oct05-c7-recovery-access-attempt2`.
The new runtime output directory is
`/root/ezh-qualification-stage/oct05-c7-recovery-runtime-attempt2`;
the ledger is `/root/ezh-qualification-stage/oct05-c7-next-operational-plan`.
Server staging is `/root/ezh-c7-recovery-20261005-attempt2`.
The local public helper directory is `/opt/ezharness-c7-recovery-attempt2`.
These paths must not reuse the closed attempt's authority or ledger.

## Evidence and limits

Independent review verified all 24 indexed files and their metadata. Actual
read-only preparation passed against installed 508/f935 and provider generation
5, connection revision 1. Thirteen runner tests, 18 operational component tests,
21 dispatcher/expiry tests, four binder tests, and three renderer tests passed.
The actual three templates passed an in-memory binder check. Root independently
reran the 13 runner and 18 component tests. Superseded preparation is retained
and has no execution authority.

Source `2bb18f611256be317aa5ece803ae26c899f724b2` separately passed the supported
fast gate: 27,585 backend tests, 7,727 web tests, and production build. Its two
recovery browser cases passed with verified screenshots. That source is not
installed. The full gate and current live feature qualification remain open.
This packet proves readiness for one recovery attempt, not completion of the
sandbox feature or readiness to release PR #303.
