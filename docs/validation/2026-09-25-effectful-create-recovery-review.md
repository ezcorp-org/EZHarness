# Effectful CREATE: isolated-app bundle and one-journal recovery review

Status: **review packet only, 25 September 2026**. No bundle was installed, service stopped, database opened or changed, Incus request sent, provider release upgraded, or saved operation reconciled while preparing this packet. This packet asks for one separate decision covering the exact app swap and readback of the original CREATE. The TCP ingress hold stays in force throughout.

## Fixed inputs and present state

| Item | Pinned observation |
| --- | --- |
| Staged app | `/tmp/ezh-qualification-release-f77b7ab8a`; source commit `f77b7ab8a696d8634f0dba1790d2448a88e1c811`; `release-bundle-manifest.json` SHA-256 `1c573db7ddaa87f1ef4f4a46ede08d9e4fa3fb4cb2bd2d9d662b0777fd461b53`; 76,103 inventory entries. Stage `verify` and non-root smoke returned HTTP 200, as reported by the staging operator. |
| Staged runtime | Bun 1.3.14, binary SHA-256 `9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74`; root lock `8c2ae7d0ffec274681202bd8c90fd507597b2279ab631e03b71fdf73b9433b88`; web lock `96e8a5adbc441d2cc77c1b5c860ad79c5695f473c4ac387f34132e2d4c5f8dc5`. |
| Installed app | `/opt/ezharness/release-bundle-manifest.json` SHA-256 `8eafc130580ddb69a98c42d74441d32277f1ceb679ee6d632fde065e4d2de636`, Git `1ad9d81742fd9a49027c1fa58a3c1b0ee28c1c55`, Bun SHA-256 `80d5578a593f0c954739e7f14ec1e3c4dc00757cda1ff4bb8383e82b1e44871e`. The two lock hashes match the staged locks. |
| Services at readback | `ezharness-qual-supervisor.service` active, main PID `3496470`; `ezharness-qual-runner.service` active, main PID `3160354`; loopback `127.0.0.1:4301` listening. Both units work from `/opt/ezharness`; the runner executes its Bun/source there. Supervisor `Wants` and starts `After` runner, but does not `Require` it. The supervisor has the reviewed GCC library path `/nix/store/si4q3zks5mn5jhzzyri9hhd3cv789vlm-gcc-15.2.0-lib/lib`. Refresh boot ID, start ticks, child and port ownership immediately before a stop. |
| Active provider | Keep Incus extension release **0.1.2**, ID `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`, digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`, and the same installation generation and connection revision. Do not install or activate a new provider release; that is a separate decision after this guest is settled. |
| Original operation | Controller CREATE `ca4d3c6b-de37-4d2a-ba00-8a243fe3124d`, `OUTCOME_UNKNOWN`, saved provider ID `incus-create-921bde75-bc6b-4758-90b4-d5f189ecee71`, binding `incus-qual-binding-668790ad210707f1ff64d9d6ec31ce28366c509a54ab893c4731a2e628d71c8d`. The one stopped guest is `ezh-3706fb480a240548bcf13974451b200d`; its stable tag is `ezh-create-3706fb480a240548bcf13974451b200d-759711e7808616af825b3567aa6e3e0b`. The approved base image is `2f8868763f6cbec0452ab0d4db82ecb315c4aff1b9a3d2d1777cd878017e9fa1`. See the [execution receipt](2026-09-25-next-incus-owned-guest-smoke-execution.md). |

The saved root-private server readback has the exact `user.ezharness.create_key`, stable operation tag, desired state `stopped`, generation `1`, ownership, profile, preset, and `volatile.base_image` under `config`. The Incus daemon operation has aged out. These facts support a readback attempt; they do not authorize changing the journal by hand.

The frozen 0.1.2 runner artifact is SHA-256 `2fc8d4c91d0b8ec779451cc6ff0f8fc93e17ddec9085e0d632d65d9bde7008d5`. Its archived adapter maps legacy inspect input to a command without idempotency. A read-only call to the installed 0.1.2 contract validator accepted the five-field `lifecycle.inspectOperation` inputs for CREATE, START, STOP, and DESTROY and rejected `requestId`/`idempotencyKey` as `SCHEMA_MISMATCH`. This checks the old contract and archived adapter; it does not execute the frozen worker. The staged host broker first compares the old worker command exactly, then derives the original CREATE journal ID from the matching persisted row before readback. Its lifecycle transport requires exact ownership, journal key and operation tag, approved profile, preset and image, generation 1, and stopped desired/observed state. No extra fields need to reach the 0.1.2 worker.

## Guarded installer and exact installed-tree drift

A root-private installer is staged at `/root/ezh-qualification-stage/ezh-qualification-bundle-swap-f77.py`, root:root mode 0600, SHA-256 `9b1de07de21bf375c36dba50d9ee9daa6e3348845774839e9a6769e3d5766351`. It has separate `preflight`, `apply --execute`, `start-app --execute`, and `rollback --execute` actions. `preflight` checks the full staged inventory, the exact installed manifest plus only the three pinned cache extras below, at least twice the staged bundle size plus 1 GiB free under `/opt`, absent next/backup/failed/state/quarantine paths, the frozen runner artifact, pinned service PIDs, the PGlite directory identity, and the TCP hold. `apply` would copy to an absent next path, verify it, stop supervisor then runner, check port and database handles, move only those exact cache files to a new root-private quarantine, require a full old-tree manifest verify, rename the two trees, and start the runner. It deliberately leaves the supervisor stopped. `start-app` separately checks the runner/socket and both bundle inventories, then marks that the app may have started **before** starting the supervisor. The script's automatic rollback refuses once that mark exists.

The handle check requires the real PGlite directory to be a directory, never a symlink, with UID/GID 62040:62040, mode 0700, and filesystem device 66306; its parent must be root:62040 mode 0730 on the same device. It accepts `lsof +D` exit 1 with empty stdout **only if stderr is also empty**. Read-only regression calls against a nonexistent database path and a simulated `lsof` traversal error both failed closed. The revised read-only preflight passed; no service or database was changed.

Exact operator entry points, **not execution authorization**, are:

```sh
sudo -n sha256sum /root/ezh-qualification-stage/ezh-qualification-bundle-swap-f77.py
sudo -n python3 /root/ezh-qualification-stage/ezh-qualification-bundle-swap-f77.py preflight
# Only after a separate decision and a fresh passing preflight:
sudo -n python3 /root/ezh-qualification-stage/ezh-qualification-bundle-swap-f77.py apply --execute
# Only after runner, frozen artifact, journal, Incus, and hold checks:
sudo -n python3 /root/ezh-qualification-stage/ezh-qualification-bundle-swap-f77.py start-app --execute
# Only if the new app has never been started:
sudo -n python3 /root/ezh-qualification-stage/ezh-qualification-bundle-swap-f77.py rollback --execute
```

The first read-only preflight found that `/opt/ezharness` has three extra regular files absent from its 76,088-entry manifest. Every expected entry matches; none is missing or changed. All three extras are root:root mode 0644:

| Unlisted path under `/opt/ezharness/scripts/incus/__pycache__/` | Size | SHA-256 |
| --- | ---: | --- |
| `incus-qualification-recovery-fence-v3.cpython-313.pyc` | 10,418 | `e9d0ecc7815e1db917b85f5feb71cd6f6ae1a456a094fd7a1a5866d9ce4cb6d4` |
| `incus-qualification-recovery-fence.cpython-313.pyc` | 16,414 | `f537ff2feb415567f67f3e3455679613915cdf52369fb2cfb7ad7fcc659688e3` |
| `incus-qualification-supervisor.cpython-313.pyc` | 50,286 | `081fc9fcab12295f0e2316baec4f11e214fe4d3a7838a9c685aadb617ca24c43` |

The pinned resolution keeps the three files: only after both services stop, `apply` would move them to `/root/ezh-qualification-stage/opt-cache-quarantine-f77b7ab8a` (root:root mode 0700), then require the full old manifest to verify before renaming anything. The source cache parents and quarantine parent are root:root, mode 0755 and 0700 respectively, on the same filesystem. A **read-only** simulation showed that excluding exactly these three entries makes the current installed inventory equal the manifest, 76,088/76,088. The revised installer's read-only `preflight` then **passed**. No `/opt` file was moved, removed, or changed. Approval of this exact quarantine is part of the future install decision; any different cache file, digest, mode, owner, or extra path stops the script.

## One proposed swap after the stop gate is resolved

Before any write, refresh the staged and installed manifest hashes above; run `stage-release-bundle.py verify` against the staged tree and verify its root/web locks and Bun binary. Recheck the active provider release, connection revision, original journal from the authenticated app, one stopped Incus guest, runner artifact hash, app/runner process identity, health/readiness, and the root-only TCP hold. Once `apply` has stopped both services and before `start-app`, inspect a fresh **stopped-app** PGlite copy using the [prior stopped-copy procedure](2026-09-25-next-incus-owned-guest-smoke-review.md). Require exactly this unresolved CREATE with the same provider ID and no other unresolved operation or active qualification run. Do not open the live PGlite tree while the app runs. Preserve the copy and hashes in a new root-private evidence directory.

The only proposed install path is a root-owned, same-filesystem copy of the verified staged tree to **`/opt/ezharness.next-f77b7ab8a`**. Require that path and **`/opt/ezharness.rollback-f77b7ab8a`** to be absent before starting. Verify the next tree there. Under the TCP hold, stop the pinned qualification supervisor first, then the runner; require the app child, port 4301 listener, runner service, and PGlite handles closed. Rename the old tree to `/opt/ezharness.rollback-f77b7ab8a`, then the verified new tree to `/opt/ezharness`. Start the runner from the new tree first and verify its socket, authenticated app-UID call, and the unchanged frozen artifact before the separate `start-app` step. Do not alter `/etc/ezharness`, the database, the runner store, the Incus server, or the 0.1.2 provider release in this swap.

Immediately before `start-app`, refresh the stopped-app database copy and exact one-journal scope, runner socket/artifact, provider release, Incus guest, and hold. Startup can reconcile before any post-start health probe. After starting, verify one supervisor child under UID/GID 62040, one loopback port owner, healthy app/readiness, runner artifact, and same active provider release. Keep ingress held. Reconciliation must inspect only the original CREATE identified above; a second CREATE POST, a different journal or instance, or any START/STOP/DESTROY is a stop. Read status and an independent Incus inventory. Accept success only when the **original** journal becomes `SUCCEEDED` with observed `STOPPED`, its saved provider ID remains `incus-create-921bde75-bc6b-4758-90b4-d5f189ecee71`, one exact stopped instance remains, and no new provider mutation occurred. A missing or mismatched tag, image, profile, preset, generation, or state must leave the outcome unknown; preserve the hold and evidence for a new review. Do not retry CREATE or manually update database rows.

The one authenticated status request, if startup has not already settled the journal, is a same-origin `POST` to `http://127.0.0.1:4301/api/infrastructure/incus/smoke` with `Content-Type: application/json` and exactly this body. Keep the admin session cookie in the existing root-private client, outside this packet:

```json
{"action":"status","installationId":"00bcc640-c430-4c9a-8d97-e35835b8bcf8","releaseId":"9ec8e626-0a5d-4ed6-9333-a3fd1aa25472","connectionId":"540e2032-532f-4d8f-9a4e-df50c8e9f43a","presetId":"incus-compose-v1","operationId":"incus-smoke-owned-lifecycle-20260925-v1"}
```

## Rollback and stop rules

If the swap or runner start fails **before the new app starts**, the installer's guarded rollback stops the new runner, preserves the failed tree as `/opt/ezharness.failed-f77b7ab8a`, restores the old tree, and starts the old runner then supervisor. Verify old manifest, health, provider release, frozen artifact, unresolved journal, and one stopped guest under the hold. If the new app may have started, the installer refuses automatic rollback: stop and make a fresh stopped-app copy, classify durable rows and server state, and seek a new decision before code rollback. Never restore a database copy or replay the request on an uncertain response. No rollback step deletes the guest or reservation.

If `apply` stops during cache quarantine or between filesystem renames before it writes its state file, keep both services stopped and the hold active. Do not rerun `apply` or use the guarded `rollback` command until an operator has checked the exact tree names, cache files, manifests, and database handles and prepared a separate recovery step.

Any changed manifest hash or inventory, service identity, runner artifact, hold, provider release, journal/provider ID, or server inventory is a stop before the corresponding write. A lost app response is not proof that reconciliation did not commit. The operator must record UTC times, pre/post manifest hashes, process start identities, quarantined cache hashes, exact renames, health/readiness results, status responses, server inventory, journal state, and rollback decision in root-private evidence. This packet stops at the human approval boundary: **no app installation, restart, reconciliation, provider upgrade, traffic release, or further guest lifecycle action is authorized by its preparation**.
