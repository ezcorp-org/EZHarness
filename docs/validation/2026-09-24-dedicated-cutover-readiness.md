# Dedicated UID cutover: exact action packet, 24 September 2026

Status: **prepared, not executed**. The restored isolated app and runner still
run. This review did not hold traffic, stop a process, capture a secret, open
the live PGlite database, move data, or start a qualification service. The
saved fixture `live-fixture-20260924` and CREATE
`62633686-a1bc-4b93-b87a-54fdbc96c2fd` in `OUTCOME_UNKNOWN` were proved
on a detached copy and by the restored app's historical status request.
See the [database readback](2026-09-24-isolated-db-readback.md).

## Exact private inputs

All files below are in root:root mode 0700 `/root/ezh-qualification-stage`.
The JSON files are root:root mode 0600. They contain paths and identities,
not secret values. The settings capture directory is empty and mode 0700.

| Name | SHA-256 | Binding |
| --- | --- | --- |
| `settings-candidate-v2.json` | `54c9b2f73d0a45c83095ca50531ef7d91460f9c4e4cf7ce41f300fb75151a074` | Restored Vite/DB holder PID 708161, start ticks 30357176, boot ID `12e34c4a-efb4-4b11-8e95-8b74e262b5b5`; absent hold receipt and empty `settings-capture-v2`. |
| `stage-candidate-v2.json` | `e90007f272c8a1e588457318131abfee836cfbd8100235ed00fcbccee78f6899` | App PIDs 708153/708159/708160/708161; isolated runner and helpers 1982010/1982276/1982277/1982278/1983979; IDs 1001, 62040, 62041, socket GID 62042; exact DB paths and units. |
| `supervisor-candidate-v2.json` | `830487da9185c77df2d234d65925e8f90b447448c088073ab3b556aed1c89749` | Root supervisor starts the app as 62040:62040. Its `recoveryFenceCommand` is still `false`, so the full DB preflight rejects it. |
| `cutover-pins-v2.json` | `4a1067e8f0eff8c3c2b2d4e3874aae0b68d7e85b17c0f6a8de4b804d53a4c2dd` | Pins release, launchers, process IDs, all private script hashes, corrected old certificate, observer policy source, and GCC library directory. |
| `hold-ingress-v2.py` | `a5e9555e75f7166ce94c5efe68af35ca5c3789eccb6d0fbeb68f95abf313de0b` | Adds one reversible `iptables` OUTPUT rule that rejects non-root loopback clients of port 4301. It verifies root health, denied dev access, no established TCP client, and no Tailscale Serve route to 4301. Read-only `preflight` passed; no rule was applied. `verify-rule` checks the rule while the app is stopped; a failed apply removes its exact rule; `rollback-hold --execute` removes it without requiring app health. |
| `stop-isolated-v2.py` | `30dee61b27f45d9c59e5c3b0039ffcf764354afed5956e44109ec457949fef0c` | Under the verified hold, `stop-runner --execute` stops only PGID 1982010 before settings capture. After capture, `stop-app --execute` stops only PGID 708153. Both check exact group members and start ticks. |
| `stage-projects-v2.py` | `e78fa4a31c6c1b5d472c150928d6c709b9905fa77fb9acdd266075bfbc9c8194` | `check` inventories the stopped project tree. Only `stage --execute` copies it, verifies paths/content/modes, gives UID 62040 ownership, and writes a private receipt. The old tree stays in place. |
| `project-path-readback-v2.ts` | `532ccd2f6ae52444f6daba41bd24875480b9c091aa8a73439a66512e398c9b61` | Reads `projects.id,path` only from the named detached or staged DB; it refuses the live source path. |
| `restore-old-db-v2.py` | `f11401ebe2f04255a94f466b9f4e8531f03ebc36991804ed8fe7f29e2e18099e` | After new units stop, `check` verifies the stage receipt, quarantine digest, unchanged old projects, empty handles, and absent source. `restore --execute` returns the original DB and source-parent ownership. |
| `recovery-fence-candidate-v2.py` | `338956746a39cc353af25be44b6c11ec639a66f7ce626a181bc7246b8ae5047e` | Exact copy of the new local client-fence source. |
| `noeffect-fence-candidate-v2.json` | `05d8c73bd28720c355df049d92542a05e16e3a4bb1e11875b331ff6fc2d18d78` | Pins the saved CREATE scope, IDs 62040/62041, exact runner unit, instance, project, and verified old TLS client DER SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`. |
| `recovery-fence-wrapper-v2.sh` | `614979ba4a4f287b30888a86bf71bb96f4ea42c8a4e85dc9f139af0a5415e9ae` | Sets the exact observer-config environment path and runs the real fence with the private config. It currently denies because that observer config is absent. |
| `supervisor-candidate-v3.json` | `59501a9414f8f24ddee7b7ed405d2fc676a738c695f1b6d28b4a00e610e25ef1` | Same child and authority paths as v2; `recoveryFenceCommand` now points to the exact wrapper. Recovery still fails closed until the AMD observer config is installed, the old client certificate is revoked, and the local fence passes. |
| `noeffect-observer-candidate-v2.json` | `e9be6bf6c8cfe379bb1955e6c3491658e18c8d300928b7b0c200cc221b68ffd3` | Complete `LiveReadbackContext` derived from the detached saved CREATE fixture, connection, verified setup recipe, and saved release manifest. Pins observer account `ezh-incus-observe`, exact instance, project, and corrected old certificate. No provider private key. This is a snapshot candidate, not current live authority. |
| `noeffect-observer-identity` | `153f74d867ef79e2b7b1828c37a167f5dc57c75e6c6b509a84c556a039d7af69` | Root-owned mode 0600 dedicated private key. Its derived public key matches `noeffect-observer-identity.pub` SHA-256 `622081a5ef95e1db1c601cf85f582611e88ccd92dc1779cfe17843607efa043a` and SSH fingerprint `SHA256:Z0GVDCGtVP40VwHal9pYJI9x2LWnJsR8DB2i+Sw2w3g`. Confirm the same authorized key in the live server policy. |
| `noeffect-known-hosts-candidate-v2` | `4e8b94e567f8348c8429acbbe9ed9bcdffce22112b8be23385121f00d3321518` | Root-owned mode 0600 copy of the installed setup host pin for `sandbox-server.taile1c5b0.ts.net`; one key, fingerprint `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`. |
| `build-noeffect-observer-candidate-v2.ts` | `4cbf012ba2210563719b9eb73e1b009f4266e9370ec819ba904a2ffd503b18e4` | Private derivation and staged-DB verification script. Its build read only the detached copy; `--verify-staged` must match the complete sealed context to the stopped staged DB before install. |

The detached copy's two project rows have paths `/` and the synthetic
`/__incus_qualification__/55cd3694c953ba5c7f5213e70a779ef1939c5fbc31ee8963622a4fe146a2a8fe`.
No row points to the old project root. The private readback file SHA-256 is
`4f5ac9bb1938b08aa8cf94cba406ef346c42afa910193924d7644fd435958afd`.
Recheck after staging because the restored app can still change data.

The installed release manifest SHA-256 is
`82b2bfeaa7c311097b280a6156e936bf5c0627c14d3fc38736bbde3180194b17`;
it names source `0b81c087e7b2e5e896e0eea83e4bff16cfd91384` and 76,066
files. Both qualification units are loaded but inactive with MainPID 0. The
supervisor unit already pins
`LD_LIBRARY_PATH=/nix/store/si4q3zks5mn5jhzzyri9hhd3cv789vlm-gcc-15.2.0-lib/lib`.
That path is also in `cutover-pins-v2.json`; its `libstdc++.so.6` target
SHA-256 is `a2dcb70d9a52e47903bd53e343b8877c5811db80f1f97f78a882431188e36b0d`.
The old launcher omits this setting. Its last restart failed when `sharp`
could not load `libstdc++.so.6`; the rollback launch below sets it.

## Disposable dedicated-UID rehearsals

The installed bundle passed a disposable UID 62040 smoke: its app returned
HTTP 200 on a random loopback port with a temporary database. The smoke
removed its `/tmp/ezh-bundle-smoke-wvdwvs2h` root, left no UID 62040
process, and left the old app listening on port 4301 as PID 708161. The
release manifest hash stayed `82b2bfeaa7c311097b280a6156e936bf5c0627c14d3fc38736bbde3180194b17`.

UID 62041 also ran rootless Podman with a separate temporary store and
the pinned BusyBox image
`docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`.
The container exited 0 and printed `UID62041_PODMAN_OK`. Its graph driver
was `overlay`; its temporary store was reset and removed. The six existing
UID 62041 processes, including Podman pause PID 3474830, were unchanged.
Both qualification units stayed inactive. Private evidence is
`/root/ezh-qualification-stage/dedicated-smoke-v2.json`, SHA-256
`a481e4c560bd4630c0eddfa6d15b354075ac36d8cbe6ed96c37a70e13d6fdcf8`.
These checks prove host runtime capability for installed source
`0b81c087e7b2e5e896e0eea83e4bff16cfd91384`. They do not prove the
later PR #303 final bundle, dedicated service startup, runner socket, or
authenticated runner call.

## Required review before the stop

1. Review the active AMD generation, server SSH gate, scoped setup identity,
   release inventory, recipe/image digests, and exact private hashes. The
   installed release predates later PR #303 executable changes. Rebuild and
   re-pin if the cutover needs final PR source; do not silently substitute it.
2. Review the real local fence candidate and the corrected old certificate
   digest. A fresh server trust readback recomputed the `engine` certificate
   DER SHA-256 as `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`.
   The earlier proposed digest ending `73e58dc0b8d6e8bdd` was wrong. NixOS
   observer policy SHA-256
   `966d68f791c7fd015a5151a0e9cbba4cba35bda35ed576c3246c003f36a2ee61`
   is now installed on the server under the guarded generation recorded in
   [NixOS PR #7](https://github.com/EZArchy/nixos/pull/7). The AMD observer config
   `/etc/ezharness/noeffect-observer.json` is absent. The wrapper's current
   read-only trial denied with that missing path. Install and verify the
   live server policy, AMD observer identity/config, and exact host unit environment
   before any CREATE repair. Do not treat the stage check's acceptance of a
   non-`false` command as proof the fence can pass. The separate CREATE repair
   remains closed until the observer and credential revocation work is done.
   The observer candidate matches the detached saved fixture and setup, but
   it is not a live readback. After the ingress hold and DB stage, compare it
   with the stopped staged DB before install. Review the live server policy
   version 2, exact public key, project, instance, and old DER digest after
   server activation. Any drift stops the cutover.
3. The disposable UID 62040 app and UID 62041 rootless Podman smokes passed
   for the installed bundle, as recorded above. After final PR #303 source
   is committed, build and pin its release bundle and repeat the app smoke.
   Prove runner service startup and its authenticated socket call after
   staged data is ready. Keep both live qualification units off until the
   guarded action sequence reaches service startup. Recheck the GCC setting
   and the release hash:

   ```sh
   systemctl show ezharness-qual-supervisor.service -p Environment -p EnvironmentFiles -p ActiveState -p MainPID
   sudo -n sha256sum /opt/ezharness/release-bundle-manifest.json /root/ezh-qualification-stage/*-v2.json /root/ezh-qualification-stage/*-v2.py
   ```

4. Refresh app and runner PID start ticks, full process-group membership,
   port owner, source paths, and all hashes. Any restart invalidates the v2
   pins and requires a new candidate set. Port 4301 is loopback-only and
   Tailscale Serve has no 4301 listener or proxy. The private hold script
   can enforce a local TCP block for non-root clients; stop the isolated
   runner under that block before writing the hold receipt. Root operators
   can still connect, so the receipt also records the operator's control of
   root clients. Recheck the rule throughout the cutover because host rule
   reloads could remove it.

## Guarded action order after that review

1. Run the ingress script's read-only `preflight` and inspect the existing
   firewall and Tailscale Serve state. Then run `apply --execute` and `verify`.
   The rule blocks new non-root TCP clients of `127.0.0.1:4301`; root health
   must still return 200 and the dev probe must be blocked. It can be removed
   by the exact `release --execute` after the new app passes health. If apply
   succeeds but its verification fails, the script removes the inserted
   rule; `rollback-hold --execute` is the manual exact-rule removal command.

   ```sh
   sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py preflight
   sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py apply --execute
   sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py verify
   ```

2. Under that verified TCP hold, inspect and stop **only** the old isolated
   runner group. Its exact five members include the lock helpers. The app
   remains live, so the settings tool can still capture PID 708161. This
   closes the runner socket before the receipt is written.

   ```sh
   sudo -n python3 /root/ezh-qualification-stage/stop-isolated-v2.py check-runner
   sudo -n python3 /root/ezh-qualification-stage/stop-isolated-v2.py stop-runner --execute
   ```

3. With TCP blocked and the runner socket closed, create the exact root-owned
   mode 0600 hold receipt. It records this enforced state and the operator's
   control of root clients. Use the reviewed settings manifest values and
   `O_EXCL`; never overwrite a prior receipt. While PID 708161 still runs,
   capture and check its settings:

   ```sh
   sudo -n python3 - <<'PY'
   import json, os
   manifest=json.load(open('/root/ezh-qualification-stage/settings-candidate-v2.json'))
   receipt={key:manifest[key] for key in ('sourcePid','sourceStartTicks','sourceBootId','sourceDb')}
   receipt['trafficHeld']=True
   fd=os.open(manifest['holdReceipt'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(fd,'w') as stream:
       json.dump(receipt,stream,sort_keys=True)
       stream.write('\n')
   PY
   sudo -n python3 scripts/incus/prepare-qualification-settings.py --manifest /root/ezh-qualification-stage/settings-candidate-v2.json prepare --execute
   sudo -n python3 scripts/incus/prepare-qualification-settings.py --manifest /root/ezh-qualification-stage/settings-candidate-v2.json check
   sudo -n python3 scripts/incus/prepare-qualification-settings.py --manifest /root/ezh-qualification-stage/settings-candidate-v2.json check-live-source
   ```

   Review the hash-only receipt, file modes, and byte-equal crypto identity.
   Install the four sealed candidate files as root:root mode 0600 at their
   matching `/etc/ezharness` paths. Install `supervisor-candidate-v3.json`
   only after the observer policy/config review. It points to the private
   root-owned fence wrapper/config and keeps recovery fail-closed if the
   observer config is missing or differs. Neither app environment may set
   `DATABASE_URL`. The exact four source-to-target mappings are:

   ```sh
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/settings-capture-v2/old-isolated.env /etc/ezharness/old-isolated.env
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/settings-capture-v2/qualification.env /etc/ezharness/qualification.env
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/settings-capture-v2/qualification-runner.env /etc/ezharness/qualification-runner.env
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/settings-capture-v2/qualification-runner-token /etc/ezharness/qualification-runner-token
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/supervisor-candidate-v3.json /etc/ezharness/incus-supervisor.json
   ```
4. Run the private stop script's app check and inspect its readback. Then run
   `stop-app --execute`. It checks exact members and signals only PGID 708153.
   The separate development runner remains untouched. Stop on an unexpected
   member, listener, DB holder, or failed group exit.

   ```sh
   sudo -n python3 /root/ezh-qualification-stage/stop-isolated-v2.py check-app
   sudo -n python3 /root/ezh-qualification-stage/stop-isolated-v2.py stop-app --execute
   ```

5. Prove port 4301, both old groups, the isolated socket, and DB/project
   handles are gone. Record the source parent's original 1001:100 mode 0700,
   then seal it root:root mode 0700. Keep new units inactive and their socket
   absent. Seed the new runtime token from the sealed root-owned source with
   the guarded command in the [dedicated UID runbook](../incus-dedicated-uid-cutover.md).
   Prepare empty root:root mode 0700 quarantine and rollback parents on the
   required filesystems. Target parent remains root:62040 mode 0710;
   `pglite` and `projects` must be absent. After the no-holder check, the
   exact parent operations are:

   ```sh
   sudo -n stat -c '%u:%g:%a' /tmp/ezh-incus-isolated-app.QMhk6Qhv
   sudo -n chown root:root /tmp/ezh-incus-isolated-app.QMhk6Qhv
   sudo -n chmod 0700 /tmp/ezh-incus-isolated-app.QMhk6Qhv
   sudo -n install -d -m 0700 -o root -g root /tmp/ezharness-qual-quarantine
   sudo -n install -d -m 0700 -o root -g root /var/lib/ezharness-qual-rollback
   sudo -n stat -c '%d %n' /tmp/ezh-incus-isolated-app.QMhk6Qhv/db /tmp/ezharness-qual-quarantine
   ```

   Require the first stat to read `1001:100:700`, both device numbers to
   match, and every new DB/project destination to be absent. If either
   private parent already exists, inspect it before using `install -d`.
6. UID 62041 now has a lingering user manager and `podman pause` PID 3474830.
   Confirm no new containers or jobs, disable linger, and terminate that user
   session. If any UID 62041 process remains, inspect it and stop here. The
   DB checker rejects every process under 62040 or 62041. Restore linger
   only after staging and before runner startup. The reviewed session actions
   are `loginctl disable-linger ezharness-qual-runner` and
   `loginctl terminate-user ezharness-qual-runner`; inspect the session and
   Podman state first. Do not signal PID 3474830 by number if it has changed.
   Use a full UID process scan after termination:

   ```sh
   sudo -n ps -eo pid,uid,comm,args | awk '$2==62040 || $2==62041 {print}'
   ```

   It must print no process rows before the DB `check`.
7. Recheck the final manifest/config hashes and run the DB tool's read-only
   `check`. Review its exact output, idle UIDs, source digest, token modes,
   empty destinations, and same-filesystem quarantine. Only then run the
   separate `stage --execute`. It quarantines the stopped source and makes
   target and root-only rollback copies with a receipt. Do not retry a
   partial stage without inspecting the quarantine.

   ```sh
   sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py verify-rule
   sudo -n python3 scripts/incus/prepare-dedicated-uid.py --manifest /root/ezh-qualification-stage/stage-candidate-v2.json check
   sudo -n python3 scripts/incus/prepare-dedicated-uid.py --manifest /root/ezh-qualification-stage/stage-candidate-v2.json stage --execute
   ```

8. Still under the hold, run project `check`, review its count and digest,
   then run `stage --execute`. It leaves the original project tree in place.
   Read `projects.id,path` from the staged target DB and compare with the
   detached baseline. Reject new paths into the old root or unexpected rows;
   make only exact reviewed row corrections before app start.

   ```sh
   sudo -n python3 /root/ezh-qualification-stage/stage-projects-v2.py check
   sudo -n python3 /root/ezh-qualification-stage/stage-projects-v2.py stage --execute
   sudo -n /opt/ezharness/bin/bun /root/ezh-qualification-stage/project-path-readback-v2.ts /var/lib/ezharness-qual-data/pglite /root/ezh-qualification-stage/project-paths-staged-v2.json
   ```

   While the staged DB is stopped, verify the complete observer context
   again. The script compares the exact fixture, connection, verified setup
   recipe, saved release preset, digests, and certificate to the sealed
   candidate. It must print `verified: true`; never open the old live PGlite
   source. After the server observer switch passes live policy and key
   readback, install the three sealed AMD observer files. Check their hashes,
   root ownership, and mode 0600. A changed key or host pin needs new review.

   ```sh
   sudo -n /opt/ezharness/bin/bun /root/ezh-qualification-stage/build-noeffect-observer-candidate-v2.ts --verify-staged /var/lib/ezharness-qual-data/pglite
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/noeffect-observer-identity /etc/ezharness/noeffect-observer.key
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/noeffect-known-hosts-candidate-v2 /etc/ezharness/noeffect-known-hosts
   sudo -n install -m 0600 -o root -g root /root/ezh-qualification-stage/noeffect-observer-candidate-v2.json /etc/ezharness/noeffect-observer.json
   sudo -n sha256sum /etc/ezharness/noeffect-observer.key /etc/ezharness/noeffect-known-hosts /etc/ezharness/noeffect-observer.json
   ```

9. Restore runner linger. Start the dedicated runner, prove rootless Podman
   and an authenticated socket call from UID 62040, then start the supervisor.
   With ingress held, verify one child under 62040:62040, one port 4301
   listener, inherited GCC path, health/readiness/admin identity, project
   access, saved fixture and CREATE state, provider connection, and denial of
   app access to root-only key and operator socket. Release traffic only
   after every readback passes. Keep the original, quarantine, rollback,
   and target copies. Then remove the exact ingress rule:

   ```sh
   sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py verify
   sudo -n python3 /root/ezh-qualification-stage/hold-ingress-v2.py release --execute
   ```

## Rollback boundary

If the new app accepted **no work**, keep the hold. Stop the supervisor and
runner, and prove every target DB/project handle is closed. Preserve the
target copies for diagnosis. Check the DB stage receipt and quarantine
digest. The private rollback script checks the receipt, digest, original
projects, unit state, and open handles. Its `restore --execute` uses the
runbook's recursive owner checks, returns the quarantined DB only while the
source path is absent, and restores the source parent to 1001:100 mode 0700.
It leaves target and rollback copies intact.

```sh
sudo -n systemctl stop ezharness-qual-supervisor.service ezharness-qual-runner.service
sudo -n python3 /root/ezh-qualification-stage/restore-old-db-v2.py check
sudo -n python3 /root/ezh-qualification-stage/restore-old-db-v2.py restore --execute
```

Restart only the isolated old runner and app from their pinned launchers.
Runner launcher SHA-256 is
`03bbce37b7e4f0e574a6d038097b46c6375e9eabae33114c9800ec599ebc98ef`;
app launcher SHA-256 is
`7900b097212debb45a6054ba6309e2899c8beff9e0bd867b81ccc266f07e8e57`.
The app restart **must** set
`LD_LIBRARY_PATH=/nix/store/si4q3zks5mn5jhzzyri9hhd3cv789vlm-gcc-15.2.0-lib/lib`
in its process environment before invoking `start-app.sh`. Capture its log
and verify health, readiness, admin identity, one listener/DB holder, and
the original fixture/CREATE row. Only then run
`hold-ingress-v2.py release --execute`. If the hold apply failed after
inserting the rule, or the old app cannot yet pass health, run
`hold-ingress-v2.py rollback-hold --execute` to remove only this exact rule
after the operator has chosen a safe recovery point. If the new app accepted
writes or ran
migrations, compare states before choosing a rollback point; the old copy
can be stale. Never delete either rollback copy as part of recovery.

## Review result

Both v2 manifests passed the tools' exact-key parsers. The Python scripts
passed syntax checks; ingress preflight and read-only stop helpers match
current groups, listener, and DB holder. The detached project query found
two rows and zero old-root paths. The real fence wrapper denied because its
sealed AMD observer config is absent. No live cutover step has run. Server
observer activation passed; AMD observer config, final release choice, real hold,
sealed settings, and runner UID quiescence remain open. All
[cutover gates](../../gates/incus-app-cutover.md) remain unchecked.
