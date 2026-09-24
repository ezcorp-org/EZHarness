# Isolated app database readback, 2026-09-24

Target operation: `62633686-a1bc-4b93-b87a-54fdbc96c2fd` (confirmed CREATE in the detached database readback below).

## Pinned preflight

- Isolated app process group and session: `3878477`; expected members: `3878477`, `3878556`, `3878559`, `3878560`. Leader start ticks: `28758883`.
- Separate runner process group: `1982010`. The stop script has no signal directed at this group.
- Source PGlite directory: `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`, device and inode `66306:27577653`, size 65 MB. The only observed open-file holder and port 4301 listener is app PID `3878560`.
- Launcher: `/tmp/ezh-incus-isolated-app.QMhk6Qhv/start-app.sh`, owner `dev`, mode `0700`, SHA-256 `7900b097212debb45a6054ba6309e2899c8beff9e0bd867b81ccc266f07e8e57`. It sets the source DB and original app settings, then runs Bun dev on loopback port 4301. Secret values are excluded from this record.
- Baseline HTTP checks before stop: `/api/health` 200, `/api/ready` 200, authenticated `/api/auth/me` 200.
- Root-only script: `/root/ezh-qualification-stage/stop-copy-restart.sh`. SHA-256 `3b75867dd1fa858ba42df681ed94f2d65713e39e81acc05ee804a40da9083e17`. Bash syntax check and read-only `--preflight-only` mode passed. Parent approved and the script ran once.

## Procedure

The script checks every pinned process and file identity, current DB holder, app probes, and the separate runner. It rejects every symlink or special entry under the source database before copying. It sends TERM to the isolated app group only, waits up to 45 seconds for the group, port, and all DB file handles to close, copies the stopped database into `/root/ezh-qualification-stage/db-readback`, verifies the copy by an rsync checksum dry run and the original inode, and restarts with the original launcher as `dev`. It then verifies health, readiness, the authenticated admin session, the new listener's identity and DB ownership, and the runner group. An exit trap attempts restart after a post-stop failure only when the port and DB handles are closed. A failed restart is reported as unverified and needs the manual recovery below. The script does not open the live PGlite directory.

The one approved run reported: preflight passed; consistent detached copy complete; source inode unchanged; restart attempted; restart verification failed after its 60-second window. The launch script did not pin a GCC library path, so the restarted app could not load `libstdc++.so.6` for `sharp` and health, readiness, and auth returned 500. Parent recovery stopped only failed app PGID `649957`, then relaunched the original script as `dev` with `LD_LIBRARY_PATH=/nix/store/si4q3zks5mn5jhzzyri9hhd3cv789vlm-gcc-15.2.0-lib/lib`. Health, readiness, and authenticated admin checks then returned 200. New app PGID `708153`, Vite and DB holder PID `708161`; runner PGID `1982010` remained. The reviewed stop/copy/restart script must not be reused without fixing this missing library path.

## Manual recovery if restart does not verify

The script preserves both the source database and the detached snapshot. Keep the runner process group `1982010` running. Inspect the root-only restart log. Use `sudo -n lsof -nP +D /tmp/ezh-incus-isolated-app.QMhk6Qhv/db` and `sudo -n lsof -nP -iTCP:4301` to identify any new app holder and listener. Use `ps -o pid,ppid,pgid,sid,user,args -p <holder-pid>` to confirm that each belongs to the restarted isolated app. Send TERM only to its verified new process group with `sudo -n python3 -c 'import os,signal; os.killpg(<verified-new-app-pgid>, signal.SIGTERM)'`, then wait until the group, port 4301 listener, and source database file handles are all absent. The NixOS `kill` executable rejected the negative group argument during actual recovery; `os.killpg` succeeded. Do not restore a database while any file handle is open.

If the detached copy exists and its checksum verification passed, preserve the failed restart state and restore the verified copy with these commands. Run them only after the no-holder check:

```sh
sudo -n mv /tmp/ezh-incus-isolated-app.QMhk6Qhv/db /root/ezh-qualification-stage/db-after-failed-restart
sudo -n install -d -m 755 -o dev -g users /tmp/ezh-incus-isolated-app.QMhk6Qhv/db
sudo -n rsync -a /root/ezh-qualification-stage/db-readback/ /tmp/ezh-incus-isolated-app.QMhk6Qhv/db/
sudo -n chmod 755 /tmp/ezh-incus-isolated-app.QMhk6Qhv/db
```

Restart as `dev` with the pinned launcher, then verify `/api/health` 200, `/api/ready` 200, authenticated `/api/auth/me` with admin role, and the new listener and database holder. If no verified copy exists, leave the original database in place and restart it with the same launcher. Never use the copy as a second live PGlite directory while the source is open.

## Detached-copy readback

Two SELECT-only PGlite readbacks opened `/root/ezh-qualification-stage/db-readback`, using the app's `postgres` database and vector/trigram extensions. They did not open the live database or send any request to the Incus server. Root-only evidence files are `/root/ezh-qualification-stage/create-readback.json` and `/root/ezh-qualification-stage/scope-readback.json`, both mode `0600`.

The reported provider operation UUID `62633686-a1bc-4b93-b87a-54fdbc96c2fd` exists. It is a generation 1 `CREATE` in `OUTCOME_UNKNOWN`, with idempotency scope `incus-qualification` and key `live-fixture-20260924`. Its binding ID is `incus-qual-binding-55cd3694c953ba5c7f5213e70a779ef1939c5fbc31ee8963622a4fe146a2a8fe`. The binding points to project `incus-qual-project-55cd3694c953ba5c7f5213e70a779ef1939c5fbc31ee8963622a4fe146a2a8fe`, desires `STOPPED`, observes `UNKNOWN`, and names the CREATE UUID as its current operation.

The first join on fixture `operation_id = provider operation UUID` returned no fixture row. A second bounded SELECT counted exactly one fixture row and found its `operation_id = live-fixture-20260924`, the operation's idempotency key. The fixture's binding and project IDs match the CREATE binding and project. Its installation ID is `00bcc640-c430-4c9a-8d97-e35835b8bcf8`, release ID `02ce233e-ccbf-4b19-a93f-4e6ee63a926a`, connection ID `9be7969a-0319-4cd7-8b85-d6e034f0f226`, connection revision `1`, and preset ID `incus-compose-v1`. This is the saved fixture for the reported CREATE, not an orphan.

The saved connection uses Incus project `ezharness`. The source `resourceName(connectionId, sandboxId)` function derives the instance name from the connection ID and binding ID as `ezh-6b3b9dde8ce9a4cc358f04db0d5cbde1`. This is a derived name from saved identifiers; it is not a live Incus observation.

After app recovery, a parent-run authenticated status request with the exact historical 0.1.1 scope returned HTTP 200. It corroborated fixture `live-fixture-20260924`, the binding ID above, CREATE UUID `62633686-a1bc-4b93-b87a-54fdbc96c2fd`, and `OUTCOME_UNKNOWN`. Two earlier authenticated status requests returned generic HTTP 409. Their cause remains unknown; the later 200 response does not explain them.
