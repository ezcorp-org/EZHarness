# Second Incus CREATE: recovery review packet

Status: **prepared, not approved or executed**. This packet applies only to the second isolated fixture below. The first recovery in [the earlier execution packet](2026-09-24-unknown-create-recovery-execution.md) used different IDs and cannot authorize this one. No server write, app stop, certificate revocation, or recovery request was made while preparing this packet.

| Field | Pinned value |
| --- | --- |
| Fixture | `incus-smoke-post-recovery-20260924` |
| CREATE | `016f7e51-60a6-4e19-aa32-77d44b745053` |
| Binding | `incus-qual-binding-3fd085a2188deff6d167d727d33176e6b78f0ebb6e2ecc50fecbfc68167c31ae` |
| Installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Release | `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472` (0.1.2; digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`) |
| Connection | `540e2032-532f-4d8f-9a4e-df50c8e9f43a`, revision 1 |
| Preset | `incus-compose-v1` |
| Project and instance | `ezharness` / `ezh-ec47ebd35d0d508dc3cd269e5b4666c8` |
| Generation | 1 |
| Old client certificate | DER SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622` |

## Evidence prepared

The stopped-app PGlite copy at `/root/ezh-qualification-stage/post-create-unknown-pglite-20260924` was queried through the staged root-private readback script. The fixture, CREATE, binding, reservation, and admission each have exactly one row. There is no project workspace binding or active `AWAITING_RESTART`/`CLAIMED` qualification run for the fixture. The CREATE is `OUTCOME_UNKNOWN`, has no provider operation ID, and is the binding's current operation. The binding requests `STOPPED` and observes `UNKNOWN`. The reservation is still reserved. The admission is `ADMITTED`. Its resource amounts agree with the reservation: 4 GiB memory, 2,000 millicores, 1,024 PIDs, and 20 GiB disk. The CREATE idempotency key is the fixture ID above. The connection, release, preset, image, and digest checks in the observer candidate builder passed against this copy.

Private readback: `/root/ezh-qualification-stage/second-create-durable-readback-20260924.json`, SHA-256 `9a55f8f7806fdbeb2054ea85dd873870e868089deda833c3a75e4c54075f026a`. The initial operation-only readback is `/root/ezh-qualification-stage/second-create-readback-20260924.json`; its fixture join is empty because it joins by the CREATE UUID rather than the separate fixture ID. The direct fixture query above is the authoritative one. This copy is a preparation snapshot; the supervisor must verify live durable state after it stops its managed app.

The current server inventory read returned no instances in project `ezharness`. Its trust list returned exactly one `engine` client certificate with the fingerprint above, restricted to project `ezharness`. The reviewed second setup plan expects that same certificate. **An empty instance list does not prove no effect.** The old client and the unrestricted `dev` administrator route can still create an instance after this read.

The isolated app and runner were active during packet preparation. The local TCP ingress hold was verified. The installed `/etc/ezharness/noeffect-observer.json` and local fence still pin the **first** CREATE and instance. The supervisor environment does include `EZCORP_INCUS_NOEFFECT_CONFIG=/etc/ezharness/noeffect-observer.json`; that path currently selects stale content. The installed app bundle reports Git SHA `1ad9d81742fd9a49027c1fa58a3c1b0ee28c1c55`.

## Root-private candidates for review

| Candidate | SHA-256 | Purpose |
| --- | --- | --- |
| `/root/ezh-qualification-stage/second-noeffect-local-fence-candidate-20260924.json` | `adeb522829273e4457b12744a72c978f6a43afb9c62707d4e20a3b2db881c73f` | Exact second target, derived instance, current certificate |
| `/root/ezh-qualification-stage/second-noeffect-observer-candidate-20260924.json` | `6a1cf1fbb59e3a60c6cee5efcb7f090fdbd5a59713ef4d3995b3ae139c449bcb` | Connection and release context from saved database; private PEM material, do not publish |
| `/root/ezh-qualification-stage/second-noeffect-composed-fence-candidate-20260924.json` | `dcaaf5cd3b871d28744ee6073792ebf734d0e76731a4057da9b1f53f430b4025` | Existing server audit pins with the second local fence command |

All three files are root-owned mode 0600. The observer builder is `/root/ezh-qualification-stage/build-second-noeffect-observer-candidate-20260924.ts`, SHA-256 `80defafff51dc3269c1c2dc53e6dd4bde87da850fc1d6f7c81d26e3ec546bbf4`. It verified release digest, preset digest `6129aa77e4fe900e01ac9bc5fdf994865dd2b795dbccca91d7837bee0ca3d7f0`, effective settings digest `e97318902558498056f4f23a351e0f477670e35327d1eb50c2b0cce06be6f2d5`, and server certificate DER SHA-256 `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`.

These are **staged** files. The local fence candidate deliberately names the installed observer path; its load check will fail until the installed observer is replaced with the reviewed second candidate. The composed candidate also names the installed observer path. No request with `allClientsFenced: true` or a deadline has been staged: those claims must be made only after the live fences pass.

## Required gates before a single recovery attempt

1. Recheck the fixture status through the running isolated app and compare it with the stopped-app copy. Check the installed bundle, all candidate hashes, private file modes, key and host pins, process identities, and exact local TCP hold. Update both installed observer and local/composed fence configurations to this second target, then prove their loaders and negative canaries use the new instance and fingerprint. The supervisor recovery backend must inherit the observer config environment. Its durable stage must verify live database state after the supervisor stops the app; do not open the app's live PGlite directory in a second process while it is running.
2. Stop and effectively fence only the dedicated runner. Require its service cannot restart, no runner UID process or socket remains, and the local fence sees the exact managed app process. A runtime mask on this NixOS host was previously ineffective; use the tested assertion gate and verify an actual start attempt fails. Keep the supervisor live so it can stop its own child at recovery time.
3. Activate and verify the separate temporary server administrator fence from the NixOS review packet. Require root audit of the frozen `dev` slice, no setup UID writer, denied new `dev`/setup SSH, reviewed root route, and rollback timer beyond the full request deadline. Check other root writers. The current successful `dev` SSH read proves this gate is **not met now**.
4. Under those live fences, save the exact old PEM certificate in a new private server backup and verify its DER fingerprint, name, project restriction, and type. Recheck trust and all fences, then revoke only that fingerprint. The restricted observer must now return the exact second instance, `absent:true`, no active operations, and `oldCertificateRevoked:true`. Take two independent reads at least 65 seconds apart, with fresh server audit and timer checks around each. Any mismatch leaves the CREATE unknown.
5. Only then construct a fresh private request for this exact scope, fixture, binding, CREATE, generation, and revision. Use a fresh nonce and review ID, concrete fence evidence, truthful `allClientsFenced:true`, and a deadline 145–180 seconds ahead. Submit it **once** through the root supervisor socket. The supervisor must stop its managed app, retain the hold, wait its own 65 seconds, repeat durable/backend reads, sign, and commit only while the fence is live. A failed step requires inspecting the held app and server before any retry.
6. After success, require the CREATE to be `FAILED` with `OPERATOR_PROVEN_NO_EFFECT`, a separate audited no-op DESTROY to be `SUCCEEDED`, binding `ABSENT`, and reservation released. Compare a fresh server inventory. Restore runner and administrator routes only after reviewing the resulting certificate and client authority, app health, and hold removal. Keep the original CREATE row for audit.

The previous packet's first fixture ID, release `02ce233e-ccbf-4b19-a93f-4e6ee63a926a`, connection `9be7969a-0319-4cd7-8b85-d6e034f0f226`, binding, instance, and request cannot be reused. Its example instruction to runtime-mask the runner is also stale for this NixOS unit. The current app, runner, trusted certificate, and open `dev` route mean recovery is **blocked**. No sandbox was created or certified by this packet.
