# Isolated app cutover: review readiness, 24 September 2026

Status: **preparation only**. No release was installed, host generation was
activated, app or runner was stopped, database was moved, Incus setup was
applied, or CREATE was repaired for this packet. This is an inventory for a
later exact action review, not approval to execute one.

Use the [dedicated UID runbook](../incus-dedicated-uid-cutover.md),
[bundle procedure](../incus-qualification-release-bundle.md), and
[CREATE recovery procedure](../incus-create-noeffect-recovery.md) for the
commands and fail-closed checks. This packet fixes the current evidence and
identifies what must be measured again immediately before each write.

## Reviewed source and live baseline

| Item | Evidence on 24 September | State |
| --- | --- | --- |
| EZHarness PR #303 | `0b81c087e7b2e5e896e0eea83e4bff16cfd91384` | Source for the next complete bundle; no bundle from this commit was observed. |
| AMD NixOS module PR #2 | `9bdf42ba2dad5fa285b08db9d97712bfa952bdc4` | Disabled by default; declares app UID/GID 62040, runner UID/GID 62041, socket GID 62042, and the `libstdc++` runtime library path. It is not active on AMD. |
| Isolated app | `127.0.0.1:4301`, Vite PIDs 3878477, 3878556, 3878559, 3878560, UID 1001 | Still the old manually launched app at the last read-only check. Refresh PID start ticks and boot ID before capture or stop. |
| Isolated runner | PID 1982010 and gateway PID 1983979, UID 1001; `/tmp/ezh-incus-isolated-app.QMhk6Qhv/runner.sock` | Still separate from the unrelated development runner. Refresh process identity and socket inventory. |
| Data | `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`; source parent dev:users mode 0700 | Live source. The parent cannot be sealed while old clients run. The `projects` tree also needs its own reviewed transfer and reference check. |
| New services | `ezharness-qual-runner.service` and `ezharness-qual-supervisor.service` were `LoadState=not-found`, `ActiveState=inactive`, `MainPID=0` | The dedicated UID preflight requires both units loaded and inactive. The proposed generation has not been activated. |
| Installed release | `/opt/ezharness` absent | The new UID cannot run the dev-owned build below `/home/dev`. |
| Provider | Installation `00bcc640-c430-4c9a-8d97-e35835b8bcf8`; approved active release 0.1.2 ID `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`, digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18` | The release is activated in the isolated app. Its earlier candidate fixtures do not prove live guest operation. Re-read active generation, connection revision, and qualification before a new setup plan. |
| Saved CREATE | `62633686-a1bc-4b93-b87a-54fdbc96c2fd`, `OUTCOME_UNKNOWN`; fixture `live-fixture-20260924` | No provider operation ID or proof of no effect. Preserve this record until independent fence, backend observations, and signed operator repair pass. |

The older disposable bundle at
`/tmp/ezh-qualification-release-5ed76c803` has manifest Git SHA
`5ed76c8033f88d567cce8dc4da2f1cb2292919d5`, 76,066 entries, and
Bun SHA-256 `80d5578a593f0c954739e7f14ec1e3c4dc00757cda1ff4bb8383e82b1e44871e`.
Its successful smoke with an explicit GCC library path proves a useful
build path, but its Git SHA differs from the reviewed PR head. It is **not**
the cutover artifact. The 0.1.2 provider release digest is an extension
release digest, not the full app bundle digest.

## Exact sequence and evidence still needed

1. **Freeze and stage the app release.** Build from one clean reviewed PR
   commit. Record its full Git SHA, Bun binary path and SHA-256, both lock
   digests, release manifest SHA-256, inventory count, and exact install
   destination. Run `verify`, then non-root `smoke` outside `/home/dev` with
   the GCC library directory from the same proposed AMD generation. Install
   the exact verified tree under root-owned `/opt/ezharness` only after a
   separate install review. Re-verify there. The module must supply
   `LD_LIBRARY_PATH` to the supervised app for `sharp` to load.
2. **Review the server SSH gate before giving the app a setup key.** Server
   gate module PR #3 is `04b0523ea64478fd2530b898e249d8e68ed4852c`.
   A candidate dedicated public key starts
   `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPEZhf5GkmoY4xmkcCM+XuTmO2TAMyuJzP38YF0zR+Il`;
   the local candidate gate script SHA-256 is
   `016cc5b8573875a12baae4ffeec1642e99d20e72346336c1eb521a420786a1c3`.
   These are candidate inputs, not server readback. The last read-only
   inventory matched the live server to firewall source commit
   `3aa2cd0e030a13f40370ef7b3f76f40b3cc0ef04`. Build the activation
   from that exact live `sandbox-server` firewall generation or source commit;
   a branch based on current `main` would drop live firewall changes. Review
   the server generation, root-owned gate script and policy hashes, forced
   command, key fingerprint, host key pin, negative command tests, and
   rollback before server activation. The app gets only the dedicated scoped
   key and pinned known-hosts file, never the developer's personal key.
3. **Build and review the AMD generation.** Pin the complete generation store
   path derived from PR #2 plus exact host options, including the dedicated
   SSH target and host key. Check UID/GID collisions and ownership again.
   Activate with `autoStart=false`; read back both loaded, inactive service
   units, account groups, library path, runner service settings, and access
   controls. A successful offline build does not prove rootless Podman under
   UID 62041 on this host.
4. **Create sealed candidates while the old app is still live.** Use the
   [settings tool](../../scripts/incus/prepare-qualification-settings.py)
   with an exact root-owned manifest and hold receipt. Record only hashes,
   modes, and paths for `old-isolated.env`, `qualification.env`,
   `qualification-runner.env`, token, supervisor config, signing key, Incus
   connection, SSH identity/known-hosts, recipe, and independent client-fence
   command. The old and new crypto identity values must match byte for byte;
   neither environment can set `DATABASE_URL`. Run `check-live-source`
   immediately before stopping the pinned old process. Keep credentials out
   of this packet, Git, logs, and command output.
5. **Hold traffic and stage the stopped database.** Stop only the isolated
   app and runner. Confirm their exact process identities are gone, port
   4301 and the isolated socket are closed, and no client still holds the
   source or parent directory. Seal the source parent. Keep new units off and
   seed the runtime token using the guarded runbook procedure. Pin the final
   manifest and its SHA-256, source tree digest, source owner/mode, same-filesystem
   quarantine, target, rollback, and project-tree plan. Run
   `prepare-dedicated-uid.py check` and review its result before
   `stage --execute`. Preserve the quarantined source and rollback copy.
6. **Start under the new identity with ingress held.** Start the dedicated
   runner, prove rootless Podman and the UID 62040 socket peer call, then
   start the supervisor. Read back one child under UID/GID 62040, one owner
   of port 4301, same saved PGlite fixture and CREATE receipt, expected
   provider release, app health, denied access to root-only operator key and
   socket, and proper project-path data. Keep ingress held on any mismatch.
7. **Review the saved CREATE separately.** Install and test a root-owned
   independent client-fence verifier. Refresh the exact installation,
   release, connection, binding, generation, revision, operation, nonce,
   deadline, and backend inventory in the repair request. The supervisor
   must observe no effect twice after its wait and issue a signed receipt.
   A zero-instance list alone cannot clear `OUTCOME_UNKNOWN`. Only after
   this repair and a new exact 0.1.2 setup Plan/Apply review can the app
   attempt an EZHarness-owned guest lifecycle.

## Values that cannot be approved from this packet

The final PR head and bundle manifest hash, final AMD and server generation
store paths, server-installed gate script/policy hashes, dedicated SSH host
key fingerprint and negative live test, installed release hash and ownership,
sealed file hashes and crypto equality receipt, current PID start ticks and
boot ID, current DB and projects tree digests, traffic-hold receipt, final
stage manifest hash, live service/runner behavior, independent fence result,
current provider connection revision, repair request fields, and a new setup
plan digest are **unknown or time-sensitive**. Measure them at their stated
gate. Approval of the provider release does not approve these later writes.

Review result: the source code and proposed host services provide a concrete
cutover path. The isolated app still runs with shared UID 1001 and no
dedicated services or installed release, so no live CREATE repair or
EZHarness-owned sandbox is verified by this packet.
