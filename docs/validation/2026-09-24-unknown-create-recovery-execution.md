# Saved Incus CREATE: recovery execution packet

Status on 24 September 2026: **blocked before any server configuration change or recovery request**. The v3 composed fence passed local process tests but is not installed; the temporary server administrator fence is not activated. The exact NixOS source archive was staged on the server and built locally; its output path and NAR hash match the reviewed candidate. This packet applies only to fixture `live-fixture-20260924`, CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd`, and instance `ezh-6b3b9dde8ce9a4cc358f04db0d5cbde1` in project `ezharness`. The installed dedicated app and runner were active at readback; the exact local TCP hold was installed. The old `engine` client certificate remains trusted. No activation, Incus trust change, or recovery step below has occurred.

The [recovery contract](../incus-create-noeffect-recovery.md) defines the checks. The server observer review is in the separate NixOS worktree at `/home/dev/work/nixos/.worktrees/ezh-noeffect-observer-activation-packet/docs/ezh-incus-noeffect-observer-activation-review.md`.

## Hard stop: unrestricted server administrator route

A read-only SSH test with `dev@sandbox-server.taile1c5b0.ts.net` succeeded. `dev` is in `incus-admin`, and `sudo -n true` succeeds. Thus this account can still create an Incus resource after the old `engine` certificate is removed. The server review also records two unrestricted `dev` SSH keys and password login. The scoped observer sees current resources; it cannot prevent a new write between its two reads or before the database transaction. `allClientsFenced: true` would be false with this route open.

Before step 2 and any server write, activate the **separately reviewed temporary server administrator fence** from `/home/dev/work/nixos/.worktrees/ezh-incus-admin-route-fence/docs/ezh-incus-admin-route-fence-review.md`. The candidate blocks new `dev` and setup SSH sessions, freezes the existing `dev` user slice, and keeps a separate root SSH route from the AMD host. Its root audit must prove `cgroup.freeze=1`, `cgroup.events` reports `frozen 1`, every `dev` UID process is in that slice, no setup UID process runs, and no unreviewed root writer acts. Keep its rollback timer active. Negative SSH tests and the root inventory are required; the existing frozen `dev` processes are expected and must not be described as absent. Until this fence is live and passes, leave CREATE `OUTCOME_UNKNOWN`; do not revoke the certificate or submit a recovery request.

## 1. Fresh local preflight (read only)

Verify `/opt/ezharness` release manifest and the exact saved fixture against the current PGlite snapshot. The last installed candidate was `13dbc66b1`; refresh its full SHA and manifest before use. Check the supervisor and runner units, app UID 62040 and runner UID 62041, PID/start ticks, control sockets, and DB handles. Check the local hold with `sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py verify-rule`; check that non-root access to port 4301 is denied and that no other listener or Tailscale Serve route bypasses it. Check that the pinned observer identity, known-hosts file, config, and local fence candidate are root-owned private regular files with reviewed hashes. Confirm the server observer policy version 2 pins project `ezharness`, the exact instance, and old certificate DER SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`. The live supervisor still uses the local-only `/root/ezh-qualification-stage/recovery-fence-wrapper-v2.sh`; replace that command with v3 only after the new bundle, private config, final server audit source, and root SSH identity pass review. No v3 config is installed now.

The proposed v3 wrapper is `scripts/incus/incus-qualification-recovery-fence-v3.py`. Install a root-owned mode 0600 `/etc/ezharness/noeffect-fence-v3.json` with these exact keys and reviewed values; do not install this example as-is:

```json
{
  "localFenceCommand": ["/run/current-system/sw/bin/python3", "/root/ezh-qualification-stage/recovery-fence-candidate-v2.py", "--config", "/root/ezh-qualification-stage/noeffect-fence-candidate-v2.json"],
  "sshExecutable": "/run/current-system/sw/bin/ssh",
  "serverHost": "sandbox-server.taile1c5b0.ts.net",
  "serverUser": "root",
  "identityFile": "/root/ezh-qualification-admin-fence/id_ed25519",
  "knownHostsFile": "/etc/ezharness/noeffect-known-hosts",
  "serverAuditPath": "/root/ezh-admin-fence-44ae3dc/source/scripts/ezh-incus-admin-route-audit.py",
  "serverAuditSha256": "612e01761586d4f76fa573f1e9875e1f9e4767e3f28342b88e48ce5f5343942e",
  "observerConfig": "/etc/ezharness/noeffect-observer.json"
}
```

The server audit pin is from NixOS source commit `44ae3dc068c7d43deab30ae92c1de7c88f4174d7`; verify the final transferred archive and file before use. Set supervisor `recoveryFenceCommand` to `[/run/current-system/sw/bin/python3, /opt/ezharness/scripts/incus/incus-qualification-recovery-fence-v3.py, --config, /etc/ezharness/noeffect-fence-v3.json]` in its private JSON, then restart the supervisor under the held ingress and verify its managed app health. The wrapper first requires the existing exact local fence response. It then uses pinned root SSH to verify the server audit source hash and run `frozen-until <request deadline>`. It requires an active freeze and rollback timer beyond the request deadline plus 120 seconds; the client enforces an extra five seconds for accepted clock skew. It runs on both supervisor fence calls, including immediately before database apply. A failed or malformed read gives no fence receipt. This is an offline design and test result, not a live installation claim.

From the server's root context, read `incus list --project=ezharness --format=json`, `incus operation list --project=ezharness --format=json`, and the complete trust list. Require no instance or active operation, and exactly one old certificate entry with name `engine`, type `client`, `restricted=true`, project list `["ezharness"]`, and the DER fingerprint above. A point-in-time empty list is necessary but not sufficient. Before revocation, the pinned observer command must reject the still-trusted certificate (exit 125, `Incus observation failed`). Stop on any drift.

## 2. Fence clients and preserve rollback

Keep the local TCP hold active. Stop and **runtime-mask** only `ezharness-qual-runner.service`, then verify inactive, MainPID 0, and empty cgroup. After checking UID 62041 has no unrelated work, disable its linger and terminate that user manager so its Podman pause process is gone. Verify no UID 62041 process and no runner socket. Keep the supervisor running: it must stop its own exact managed app child during the recovery request and verify UID 62040 and the old process group are empty. Do not stop the supervisor first. Refresh process start ticks and the ingress rule. Apply and verify the separate server administrator fence from the hard stop above; inventory other holders of the old TLS identity and local Incus socket. Maintain every fence until the transaction finishes. The v3 wrapper checks the local app/runner state and the server's frozen administrator slice and timer at each supervisor call. Independently inventory other root writers.

On the server, save **only** the matching old PEM certificate in a root-owned 0600 file using `O_EXCL`; reparse it as DER and require SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`. Do not print PEM bytes. The NixOS server observer review has the exact guarded backup and rollback commands under “Pending old-client certificate revocation review.” Recheck all local and server fences immediately before deletion.

## 3. Revoke the exact old certificate; read twice

Only after the hard stop and steps 1–2 pass, remove the exact fingerprint, never the display name:

```sh
sudo -n incus config trust remove fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622
```

Run this on `sandbox-server`. Read the complete trust list again and require that fingerprint absent. From AMD, invoke the dedicated `ezh-incus-observe` SSH identity with the installed pinned host-key file and exact original command `ezh-incus-noeffect-observe-v1`; do not use the unrestricted `dev` identity for this readback. Require a single JSON object with exactly `version:1`, project and instance above, `oldCertificateSha256` above, `absent:true`, `activeOperations:[]`, and `oldCertificateRevoked:true`. Wait at least 65 seconds and perform a second independent read. Check the frozen audit and rollback timer before and after each read, and save both responses and times in the private ticket. Any read failure, changed list, new operation, or changed fence is a stop. These operator reads do **not** replace the supervisor's later 65-second wait and two reads.

## 4. Submit one signed recovery request

With all fences still active, compare the saved fixture, binding, reservation, and CREATE against the staged database through the read-only verifier. Require `OUTCOME_UNKNOWN`, no provider operation ID, binding desired `STOPPED` and observed `UNKNOWN`, generation 1, connection revision 1, and no competing qualification run. The scope IDs and binding ID are pinned in `/root/ezh-qualification-stage/noeffect-fence-candidate-v2.json`. Build a new root-owned 0600 request with `O_EXCL` from those exact fields and the schema in the recovery contract. Use a fresh nonce, review ID, truthful `allClientsFenced: true`, concrete `fenceEvidence` naming the local and server fence receipts, and a deadline 145–180 seconds ahead. Do not reuse a request or invent a new resource ID. Run once as root:

```sh
/run/current-system/sw/bin/python3 /opt/ezharness/scripts/incus/incus-qualification-supervisor.py \
  --config /etc/ezharness/incus-supervisor.json \
  --recover-request /root/ezh-qualification-stage/noeffect-request-EXACT-REVIEW.json
```

The supervisor itself stops the app, writes a durable recovery hold, checks the local fence, waits 65 seconds, verifies the durable row and pinned server state twice at least five seconds apart, signs a receipt, and applies one transaction. After a success receipt, require durable readback to prove that the saved CREATE is `FAILED` with `OPERATOR_PROVEN_NO_EFFECT`, a separate audited no-op DESTROY receipt exists, the binding is `ABSENT`, and reservations are released. Independently read the server inventory before declaring recovery. Keep the original CREATE row and its idempotency key for audit.

## 5. Failure and restart rules

If a fence, observation, signature, or apply check fails, retain `OUTCOME_UNKNOWN` until the database proves otherwise. The supervisor leaves its `.noeffect-hold` marker beside the signing key and keeps the app stopped, including after service restart. Keep TCP ingress and the server administrator fence in place. Inspect the exact failed stage and read both database and Incus state before any operator removes the marker. Do not repeat CREATE or the same recovery request. If the old certificate must be restored before a successful database apply, use only the saved matching PEM and the exact restricted/project flags from the server packet, then verify its original DER fingerprint and scope. Restoring trust does not authorize restarting clients while the CREATE outcome is still unknown.

After a successful transaction, require a healthy supervised app and a read-only fixture/status result consistent with the signed receipt. Recheck the local TCP hold. Restore runner linger, unmask and start only the dedicated runner, and verify its authenticated private socket before admitting traffic. Review whether the old certificate stays revoked; a new provider connection or identity needs its own reviewed setup before any new guest CREATE. Remove the local hold only after the app, runner, database, and server inventory checks pass. Restore ordinary server administrator access only after recovery is final and no stale client can retry the old CREATE. Record each fence release and final cert trust list.
