# One c7 recovery with verified key serialization

Status: sealed preparation and independent review passed; awaiting new exact approval.
No live clock, new server staging, active configuration change, or temporary
access has started under this packet. Approval covers one attempt only.

## Change and reason

Attempt 2 stopped before timer or key installation because the generated key
checksum included an extra newline. Independent checks confirmed no access or
admission effect and restored the original app. See the
[attempt 2 result](2026-10-05-c7-batched-recovery-attempt2-result.md).

The generator now uses one canonical byte representation for both the saved key
line and its hash. The binder rejects a mismatch before producing runtime files.
The dispatcher, expiry and installer validation rules remain unchanged.
The original failure reproduces through all three actual consumers; the
corrected final serialized artifacts pass them. All 21 indexed dependencies
passed actual file/hash/metadata and renderer-to-consumer validation.

This packet uses new paths and pins. It preserves both earlier attempts and
does not reuse their consumed approvals, deadlines or ledgers. The recovery
guards and authority scope remain the same.

## Exact scope

- Server: `sandbox-server.taile1c5b0.ts.net`.
- Installed source: `5080f3792dbbedcdae17b81368ed9ee83ba41b80`; manifest
  `f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.
- Preserved START: `c7b5f35d-aa75-421f-aa6b-0741840c8c39`, UNKNOWN.
- Guest: `ezh-e527e87eb409d89f6e70d58c8ea4a49b`, STOPPED, backend generation 2.
  Host binding generation remains 1.
- Connection: `fdede86e-6cef-4d66-913a-49c8c3bf36e8`, revision 1;
  provider 0.1.4 at generation 5.
- Fence only restricted certificate
  `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`
  for project `ezharness`.
- Add one temporary root SSH entry at `/etc/ssh/authorized_keys.d/root`,
  restricted to source `100.77.117.56` and the pinned forced command.
  Require both root key paths absent first. Key fingerprint:
  `SHA256:9+VVbYWAy12Hgxm15QREVbvUysmBz84tsMqHK0g0rjU`.
- Permit only `c7-lease probe`, `freeze`, `verify`, `thaw`, and exact sealed
  transport wires for `verify`, `restore`, `observe`, `fence`, `fence-state`.
  No arbitrary shell or arguments.
- Maximum access lifetime: 600 seconds on the same boot. Submit one supported
  fenced cleanup, restore access, and remove only the exact temporary entry.

The approved effects include exact server-file staging, isolated actor pause,
five local recovery configuration changes and their restoration, runner-marker
handling, the temporary key and timer, operator-slice freeze/thaw, certificate
fencing/restoration, and one signed cleanup admission. No app update, new guest,
provider activation, NixOS activation, firewall/network change, account creation,
or database restore is included.

## Fixed sequence and checks

1. Recheck all hashes, current target, prior key absence, and host headroom.
   Wait for all local source tests/builds to finish before starting timed work.
   Preserve previous attempt evidence. Do not stop unrelated project processes.
2. Before binding any clock, pause isolated actors, preserve the exact five old
   configurations, rotate only the pinned previews, and preserve/remove the
   verified empty root:62040 mode-0600 runner marker.
3. Bind one fixed same-boot 420-second recovery deadline. Stage only the pinned
   server files. Run the batch: arm timer, prove actual timer configuration,
   install exact key, prove forced-root route, freeze the operator slice, verify.
   The timer must run as root in `system.slice`, unconditionally thaw
   `user-1000.slice` first, then run exact expiry. Check the actual timer before
   key installation and require at least 120 seconds of rollback margin beyond
   the recovery deadline. Never extend, rebind, or replay.
4. Capture completed access proof with at least 300 seconds of recovery time
   remaining. Obtain one independent review; continue only with at least 240
   seconds left. Existing 200-second management and 180-second recovery guards
   remain. This review is part of the approved attempt, not another permission.
5. Fence only the named certificate, observe the exact stopped generation-2
   guest with no active operations, start fenced management, and submit one
   signed supported cleanup request. Do not replay the saved START.
6. The supervisor restores the certificate/transport before recovery returns.
   Require a separate cleanup DESTROY with SUCCEEDED and binding ABSENT,
   verified restored transport, no hold, and a healthy app. Preserve the original
   START as UNKNOWN. Record the actual empty root:root mode-0600 runner marker
   retained by the core; do not claim restoration of the original marker inode.
7. Run exact expiry/thaw, remove only the matching temporary key, and prove
   previous key-file absence. Retain the independent expiry fallback and save
   final key, slice, certificate, inventory, cleanup and app checks.

## Failure handling

Never repeat an uncertain mutation. If independent actual checks prove no
timer, key, freeze or certificate effect and no admission, the supported
standalone `abort-preview`, `restore-marker` and guarded original-app resume
may restore local preparation. They retain all paused-actor, exact-backup,
known-config, no-hold and no-admission guards. Do not fabricate expiry success.

Recognized original/preview configuration bytes do not depend on unused partial
runtime files. Applied runtime bytes require all three exact binder outputs.
Unknown installed bytes stop restoration before overwrite. Restore the five
original hashes and original marker owner/mode/content; record its new inode.
Partial restoration stays stopped.

After key or freeze effects, use only the approved exact expiry/thaw route.
After certificate-fence intent or possible admission, preserve uncertainty and
holds and use supported recovery. No database restore or operation replay. On reboot, the dispatcher
rejects the changed boot; any remaining exact key requires verified removal.

## Sealed packet

Entry: `/root/ezh-qualification-stage/oct05-c7-recovery-packet-attempt3/next_attempt.py`.
Directories are root-owned mode 0700; indexed files are root:root mode 0600
with one link. The top index pins the runner, component, final validator and
dependency index; the dependency index pins the 21 consumed files without a
circular digest.

| Item | SHA-256 |
| --- | --- |
| Execution index | `7871965a544a75e14579bbc8a2a3f653094fa627cb2f3950389640a640b2a208` |
| Dependency index | `e6d86a27128ac0cbc613547f6fc3a682dcdde7742f7b62867f20084c63eea33e` |
| Recovery runner | `7b212967c201489ce0ec766a69184ac64ceab6e305f8d16875bd24c6248e05e9` |
| Operational component | `41b135fd3df7d075f2bac7e29bf9d7b39a797a5f89b2b3aa67a959397cbe03c4` |
| Binder | `bb5e8f391a9d3d13f7d277ab3c2076be4c6f7c93b1d99f30f0411e54ea15ab3e` |
| Canonical key renderer | `bac757406f57928a992a009462d03eec5bd7e2efb890d8b366a582c28cb89b51` |
| Dispatcher | `80f6f41e755455b91d493cbc45ce15097045d921d5399d31dfb7bef61497aec8` |
| Expiry | `3dbfe670d2fc9370d8cd2da0f9aca4cf8363ee3229b49ccdd64ce61b66f1b172` |
| Installer | `175c9587417a3424387921e03756f03b58ea1be89619655aaa3b0b4671bae995` |
| Exact key-entry bytes | `6320f2c01c2821d3d6694a69971cb0a9c935c2a4061f40317c8b9d7cae0b8488` |
| Final consumer validator | `d9e40010bba77cebbacb07468bb7b9c00d65daf7cc30076a64b6e3785a99df19` |
| Final consumer receipt 188 | `4d55b30ee1c0beab005af575619ab0be8f5f2b9960136084fe22a1c4dd305401` |
| Read-only preparation receipt 189 | `f5173e4947b46d4f765c8c89e07c7a93dd646e09249afc2336ac26c1afb7bf38` |

Access files: `/root/ezh-qualification-stage/oct05-c7-recovery-access-attempt3`.
Runtime outputs: `/root/ezh-qualification-stage/oct05-c7-recovery-runtime-attempt3`.
Ledger: `/root/ezh-qualification-stage/oct05-c7-operational-attempt3`.
Local public helpers: `/opt/ezharness-c7-recovery-attempt3`.
Server stage: `/root/ezh-c7-recovery-20261005-attempt3`.

## Validation boundary

Passed: 13 runner, 18 operational component, 21 helper-wire, four binder,
three canonical-key and four index-validator tests; the original real-loader
failure regression; final indexed-artifact consumer validation; actual read-only
bootstrap against installed 508/f935; and current target/inventory readback.
Root reviewed the component's exact namespace/pin-only changes.

Consumer tests model clock, boot and filesystem effects and forbid subprocess
and mutation paths. They establish serialization and loader compatibility.
They do not establish real systemd timer, SSH, freeze/thaw, cleanup, or expiry
behavior. Those remain guarded live checks. No cleanup or release readiness is
claimed by this preparation.
