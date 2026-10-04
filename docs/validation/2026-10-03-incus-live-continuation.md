# Incus live continuation — 3 October 2026

Current status, 4 October 2026: provider 0.1.3 is active in the isolated app at generation 4. The update correctly refused replacement while the diagnostic guest remained, then succeeded after UI Stop/Dispose and independent confirmation of guest absence. Earlier real qualification, UI CREATE/START/Open chat, native file/search/shell tools, and three Python tests passed on the previous release. The corrected Git image has built successfully. New connection planning and exact server policy review are next. Full native Git/Compose/retention proof on the new image, the ten-cycle run, and final PR gates remain open.

This is a chronological evidence record. Earlier snapshots below describe their observation times, not the current state. It begins with host restoration, Incus transport repair, and continuation of the saved fixture. At the initial snapshot, no new CREATE, START, STOP, DESTROY, marker, or Compose action had been sent. The first inspection's guest process outcome was uncertain; the later inspection succeeded after the transport repair.

Evidence snapshot: 3 October 2026, 16:05 UTC, after the successful post-START inspection and before the marker and Compose actions.

## Initial host state (14:01–14:38 UTC)

At 14:01–14:38 UTC, `nixos-amd` had no loaded `ezharness-qual-supervisor.service` or `ezharness-qual-runner.service`, no listener on port 4301, and no runner socket. Its `/opt/ezharness` manifest still has SHA-256 `e6295213f653cb89a33881f1f609c97f93255e4305e0db8c05e28738c927d6b6` (bundle `8213297a0`). The saved installer state remains `may_have_started_app`; it must not be treated as a pending automatic rollback. The exact local TCP ingress hold passed its root-private `verify-rule`; its script hash remains `a5e9555e75f7166ce94c5efe68af35ca5c3789eccb6d0fbeb68f95abf313de0b`. The retained runner artifact SHA-256 matches `2fc8d4c91d0b8ec779451cc6ff0f8fc93e17ddec9085e0d632d65d9bde7008d5`.

The September 30, 19:13:43 EDT NixOS switch stopped both qualification units at 19:13:54 EDT. The app log shows graceful PGlite close. The switch then reported the qualification runner user absent. At the initial readback, NixOS generation was 322, `/nix/store/7pl1wwz2w7sawdy5dmkjqcvnx58lb4mm-nixos-system-nixos-amd-26.11.20260929.b4fd65b`; both units had `LoadState=not-found`. Generation 319 retained the last loaded unit files. This explains the app outage then; it does not explain the earlier inspection HTTP 409.

The stopped PGlite source is `/var/lib/ezharness-qual-data/pglite`, UID/GID 62040, mode 0700, device 66306, inode 65145597. Its parent is root:62040, mode 0730. The exact `lsof -e /run/user/1001/doc +D` check found no holders; the excluded mount still identifies as `/run/user/1001/doc fuse.portal portal`. A root-private detached copy was made and checksum-compared with the source. A second untouched baseline copy remains for a checksum and deletion-aware pre-install comparison. The live source was never opened by the readback process.

The detached readback at 14:37:55 UTC found the exact fixture `incus-smoke-owned-lifecycle-20260925-v1`, binding `incus-qual-binding-668790ad210707f1ff64d9d6ec31ce28366c509a54ab893c4731a2e628d71c8d`, CREATE `ca4d3c6b-de37-4d2a-ba00-8a243fe3124d` and START `9b7b0246-e9ef-4b6d-b899-78f9d975c39a`. Both operations are `SUCCEEDED`. The binding is `RUNNING/RUNNING`, current operation START, without a tombstone. The 4 GiB/2000 millicore/1024 PID/20 GiB reservation is still `RESERVED`. Connection revision 1 is unrevoked with guest user `sandbox`. The root-private readback receipt is `/root/ezh-qualification-stage/oct03-current-readback.json`, SHA-256 `331f1bba570d0236e812afd82b229b8700e055d898d63a345820e135ea4bf6d2`.

The Incus server is reachable by SSH with an explicit empty config. Project `ezharness` lists the original `ezh-3706fb480a240548bcf13974451b200d` guest as `RUNNING`, with the same CREATE, binding, connection, preset, and base-image tags. There are no active Incus operations. Read-only expanded config shows the reviewed Compose profile, 4 GiB memory, 2000ms/1000ms CPU allowance, 1024 process limit, 20 GiB root quota, isolated unprivileged guest, and restricted private network. The server retains no substitute guest.

## Inspection and next gate

The installed bundle has only the opaque `smoke_unavailable` response. Source trace shows `inspectFixture` checks fixture authority, live Incus identity/resources/isolation, then runs a guest process to verify `sandbox`, `/workspace`, and boot ID. Current database and Incus observations support the durable identity and resource checks; the specific failed check is unproven. The updated bundle adds fixed diagnostic `failureStage` and `failureReason` fields for the next exact `inspect` request.

The new bundle at `/tmp/ezh-qualification-release-7a251ed01-oct03` has manifest SHA-256 `e9fefa291ea5cef52164156b719bcdd8e72724694e255722c2bc1a7c5c116aa5`; its verifier still hashes to `4e621540e76bd10d471adf2e84867fae40579a310e2465b06463eb4565875462`. The final guarded installer at `/root/ezh-qualification-stage/oct03-guarded-bundle-install.py` hashes to `2170f3ee04cfbe0fe277eb70920fdaf930fca6b6d259e55aab629138c1c960c8`. Five focused guard tests and Python syntax check passed.

## Guarded restoration and inspection

After review, the root-private NixOS activation script, SHA-256 `08b85fee0cb004bf6299ca282c173a74f7e2dcba7d1cc2e82e5a7802d654cc0a`, passed read-only preflight and applied candidate generation `33gh6nkfwn3k23mqvn4ls48lbw6klg18`. Independent checks found the system and profile at the same generation, the app, runner, and runtime-check units loaded but inactive, the original guest still running, the expected UID/GID assignments, SSH and Tailscale active, and the exact ingress hold in place. The rollback timer was then confirmed and disarmed while both qualification services remained stopped.

The final installer passed its stopped-app preflight. Its `apply` mode installed the new bundle and kept the 821 bundle at `/opt/ezharness.rollback-7a251ed01-oct03-from821`; both manifests match the hashes above. Its new state reached `swapped` while both units remained inactive. Its `start-preflight` passed, and `start` brought up the runner and supervisor. Before it started the supervisor, it atomically advanced the new state to `may_have_started_app`, which bars automatic old-bundle or old-database rollback. The runner socket is UID 62041/GID 62042 mode 0660; the app database directory remains UID/GID 62040 mode 0700. The saved hold script `verify` passed with the app healthy and ready. The provider release and connection were not changed.

The retained admin session returned role `admin`. One `status` POST with the saved fixture scope returned HTTP 200: exact binding `RUNNING/RUNNING`, original START `SUCCEEDED`. Receipt SHA-256: `1f3b1f5eae52a96ef3aeef2e8bb9dcadcb0600a6e6bb847fedf61b5e01020dac`. One `inspect` POST with the same six fields returned HTTP 409 `smoke_unavailable`, `failureStage=host_inspect`, `failureReason=unknown`. Receipt SHA-256: `a6e03d5d1216e749d31d6772dcaa408aad7d139fe09cdbd8394dbd9c65e7fb2a`. Both receipts are root-private under `/root/ezh-qualification-stage/oct03-smoke`. No marker, Compose, STOP, DESTROY, replacement CREATE, or repeat START followed.

At the inspection time, the runner launched one release worker, which ran from 11:00:53 to 11:00:54 EDT without a logged exception class. Source code constructs a new `ReleaseProcess` for each guest method call, so this suggests the request reached the first `processes.start` call, but it does not identify the exception. Read-only Incus file pull of the exact guest's `/var/lib/ezharness-helper` found it empty; the installed helper file still has SHA-256 `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75`. Incus file metadata shows that the helper is root:root mode 0755, while `/workspace` and `/var/lib/ezharness-helper` are UID/GID 1000 mode 0700. The helper creates a durable `status.json` before returning from `process.start`, so there is no evidence of an accepted helper process start. The transport sets its `execAttempted` flag immediately before the Incus exec POST; a later POST, WebSocket, or wait error can still mean an unknown mutation outcome. The cause and exec boundary need proof before another guest process call.

A separate, reviewed read-only `helper.file.stat` diagnostic used the production connection resolver and guest transport with a disposable clone of the untouched detached database baseline. The old admin cookie had expired; one login with the retained isolated-app credential restored an admin session. A fresh `status` POST then matched the exact fixture, release, connection revision, and original successful START. The diagnostic sent one fixed `path="."` helper stat, with no process start or file write. Its pinned instance GET returned HTTP 200 and the Incus exec POST returned HTTP 202. The transport failed before any of its four WebSocket opens reported success: sanitized error class `IncusTransportError`, kind `unavailable`, effect `unknown`. The first probe did not distinguish which concurrent WebSocket open failed. Afterward, the project had zero active Incus operations and the helper state directory still had zero entries. The original guest process start remains unresolved; no repeat was sent.

After an additional fresh exact status check, a reviewed classification-only version of the same read-only stat probe repeated the result: instance GET 200, exec POST 202, then the first WebSocket open failed with the fixed `tls_failed` class. Incus briefly showed this diagnostic exec running after the client returned; a bounded follow-up found zero active operations. This identifies a transport TLS failure before helper request delivery. It does not establish the final outcome of the earlier `processes.start` attempt.

The stored connection leaf and the server leaf each report validity from 22 September 2026 01:56:59 UTC through 19 September 2036 01:56:59 UTC. The 3 October 2026 check time is inside that window. Only dates were emitted; no certificate or key material was recorded.

Commit `10f0cafa1` repaired the pinned WebSocket TLS and EOF handling. It was cherry-picked into the isolated live worktree as `600b95dc9`; the installed app was not yet changed. A fresh saved-fixture status check still matched the exact release, connection revision, binding, and successful START, with zero active Incus operations. One reviewed `helper.file.stat` call for `path="."` through the repaired production transport succeeded: instance GET 200, exec POST 202, all four WebSocket channels opened, exec wait 200, and the helper returned a directory. Afterward, the project again had zero active operations and the helper process-state directory remained empty. This proves the repaired transport path for a read-only helper action. It does not settle the earlier `processes.start` outcome or qualify the full guest lifecycle.

## Fixed bundle and saved fixture continuation

The combined bundle from source `6803d1a71b52dc39dbebfcee641223f582a42218` was staged at `/tmp/ezh-qualification-release-6803d1a71-oct03`, with manifest SHA-256 `7bb58678aaa8a951dadbabdb42a1eea3d041c48b2611eaddda5107c5d71c645d`. Its non-root health smoke, manifest verification, and the source fix's focused checks passed. The reviewed forward-only cutover script SHA-256 was `91ffa9396ce9499b27d930ec7effbc3c5fd2fb9fe7c40a212e7864e660ddc872`. It reused the earlier guarded installer checks, and its focused state transition, tamper, and symlink tests passed.

The script's running-app preflight passed. It then stopped the isolated supervisor and runner, proved no source database holders, copied the current PGlite directory to the root-private `/root/ezh-qualification-stage/oct03-pre-tls-pglite-baseline`, and made a checksum and deletion-aware comparison. The source database was preserved. The stopped-app swap preflight and swap passed; the new manifest became active at `/opt/ezharness`, while the e9fefa bundle was retained at `/opt/ezharness.rollback-incus-tls-oct03-from7a` and the older 821 bundle remained retained. The start preflight passed. The runner started first; the new install state was durably advanced to `may_have_started_app` **before** the supervisor started. Both services became active with app health and readiness passing, and the exact TCP ingress hold passed `verify`. No automatic prior-bundle or database rollback is allowed after this point. NixOS generation, provider release, connection, and server authority were not changed.

A fresh authenticated `status` POST with the same six saved fields returned HTTP 200: fixture and binding IDs, installation and release IDs, connection revision 1, and preset were unchanged; the original START remained `SUCCEEDED` with binding `RUNNING/RUNNING`. Its root-private receipt SHA-256 is `1f3b1f5eae52a96ef3aeef2e8bb9dcadcb0600a6e6bb847fedf61b5e01020dac`. Before inspection, the project had zero active Incus operations, the helper process-state directory had zero entries, and the earlier release worker was gone. One exact post-START `inspect` POST returned HTTP 200. The inspection verified the saved binding running on the pinned image and helper digests, profile `persistent-web-compose.v1`, guest user `sandbox`, workspace `/workspace`, 4 GiB memory, 2000 millicores, 1024 PIDs, 20 GiB disk, btrfs, private network, restricted project, unprivileged mode, and a valid boot-ID shape. Its root-private receipt SHA-256 is `7dad7e03fcfd83a5966ad7892341298aeca88d8aa0c2946dafb8bcbc8707a249`.

The reviewed marker, immutable-image Compose, post-Compose status/inspect, STOP, reconnect/status, DESTROY, and independent empty-inventory checks remain. The separate SP01–SP08 qualification and real feature flow have not run. The approved owned-smoke runbook contains no second START after STOP; this continuation must not add one.

## Saved STOP recovery and smoke cleanup

The saved marker and pinned-image Compose calls succeeded before STOP. The original STOP `1a1f5737-d27e-4a6a-ae67-06724efe313e` reached an unknown app outcome while the backend guest was stopped. No second STOP, START, or CREATE was sent. Source `241ab38360fda31928eb4c887709b07be3f93c5e` repairs the comparison between the host journal fence and the persisted provider and guest generations.

The staged repair manifest is `0d7b17022b428d132859fbc95a6be5915636f436acfa39bf4612fdf0803a157a`. The reviewed wrapper SHA-256 is `de39fec3a3fa2b2354f15094e01180526315d6678f3ef423907b1b2c47461185`. Running preflight, quiesce, stopped swap preflight, swap, start preflight, and start each passed. Quiesce made and checksum-compared a new private stopped database baseline. The current source database was preserved. The previous 6803 bundle remains retained. The new state reached `may_have_started_app` before supervisor start. App health, readiness, runner, and exact ingress hold passed; old application or database rollback remains barred.

At 17:32:31 UTC, exact saved-fixture status returned HTTP 200 with the original STOP `SUCCEEDED` and binding `STOPPED/STOPPED`. The same approved fixture then received one DESTROY, `53ab479a-9c41-4708-9f5b-9dbda8f221f5`, with provider operation `incus-destroy-7e01da99-37f7-41f1-b191-e0f949ad5cb7`. It first returned HTTP 202, then an unknown outcome. Background reconciliation settled that same operation as `SUCCEEDED` at 17:33:31 UTC; the binding became `ABSENT/ABSENT`. No repeat DESTROY was sent. Independent SSH readback after settlement found zero instances across all server projects and zero active operations in `ezharness`.

Root-private receipts are `15-status-stop-fixed-bundle.json`, `16-destroy-admitted.json`, `17-status-destroy.json`, and `18-status-destroy-reconcile.json` under `/root/ezh-qualification-stage/oct03-smoke`. The stopped bundle baseline predates DESTROY and cannot prove the final reservation or qualification state. Fresh metadata proof remains required before SP01–SP08.

The read-only management API returned the approved release generation 3, connection revision 1, verified setup, no feature bindings, no qualification run ID, and an unqualified Compose preset. The capacity API returned the existing applied 32 GiB/8 CPU/4096 PID/80 GiB/4 slot authority. These APIs do not report current reservation counts. The supervisor socket and private control-probe directory exist; all required qualification environment fields are present. SP01–SP08 and the real native chat flow remain pending.

During read-only status setup, an invalid Cookie header caused an HTTP client traceback to print the isolated session token. The exact session was revoked through logout; reuse returned HTTP 401. A retained private login request renewed an admin session with login and session checks HTTP 200. Subsequent clients use the Netscape cookie parser and print only fixed failure classes and HTTP codes. No provider, server, or guest credentials were printed.

A reviewed bounded stop, snapshot, and same-bundle restart then passed under script SHA-256 `622f52c113552525717af015e335d3c58c23263bb085c0dde122b527c6f9af8b`. It kept the existing `may_have_started_app` state and preserved the source database. It copied the stopped source to a new private baseline, checked all file checksums and deletions, restarted the same 241ab bundle, and proved health, readiness, and ingress hold. A disposable clone of that fresh baseline was the only database opened for metadata readback.

The 17:38:48 UTC readback proves the smoke reservation compute and disk states are both `RELEASED`, all four smoke lifecycle operations succeeded, no provider operation is pending, no reservation remains allocated, no qualification run exists, and the proposed run's fixture and operation IDs are absent. The exact approved connection remains unrevoked at revision 1. The private receipt is `/root/ezh-qualification-stage/oct03-after-smoke-current-readback.json`.

Fresh server readback found 57.07 GB available memory, 12 CPUs, and the 100 GiB btrfs pool using 1.71 GiB. The project is restricted; its Compose profile uses the private managed network, port isolation, isolated UID mapping, an unprivileged guest, and a 20 GiB root quota. The exact pinned guest image is present with automatic updates disabled. The control-probe root is canonical, UID 62040, mode 0700; the supervisor socket exists; the immutable Compose image matches the review packet; the public key has valid PEM framing; and the configured readiness project `global` exists. Actual supervisor readiness must still succeed from the managed app process before qualification allocation.

## Qualification prerequisites and first live blocker

The first exact qualification POST returned HTTP 503 before allocation. The current supervisor configuration still had `receiptAuthorityCommand` set to `false` and no fault verifier. A reviewed private candidate reuses the existing restricted project mTLS identity and the installed production receipt and read-only fault verifiers. Both verifier readiness checks passed with exact protocol output. The actual supervisor environment has the correct isolated database path and no `DATABASE_URL`. Guarded installer SHA-256 `cbb9ac88d80b145bbba49c6b6c204fbd9e43e390c1522c284b8174424afe140c` passed preflight and apply, retained the previous configuration, and restarted the same 241ab app behind the hold. The active configuration SHA-256 is `d208f5cb012ef18fba1117db81ecdb52bd2a19760c18d4a6e3b5f1689d635697`; private connection file hashes were unchanged before and after. This added no server trust or permission.

The next POST returned HTTP 409. Read-only probe fixture status showed the current run's local negative controls absent. The reviewed plan digest `7c810d33046a2c93d3f0e93686fcc89af1760aec1df31043794082a3681de33f` creates four private AMD canaries and a plan file, four exact local database control projects, and two inert binding rows. It has no provider dispatch, reservation, or Incus resource effect. Apply and subsequent status returned HTTP 200 and `ready` with the same digest. All current scope, alternate unqualified preset, capacity, saved plan integrity, exact row ownership, private file ownership, and canary content guards were reviewed.

A further qualification POST still returned HTTP 409 before guest creation. A read-only diagnostic with the same production `HostIncusLiveReadback.image` and reviewed private connection reproduced the cause: pinned image GET returned 200, then `/1.0/?project=ezharness` returned 404. With only the HTTP diagnostic wrapper changing that root URL to canonical `/1.0?project=ezharness`, all image, server, storage, and profile GETs returned 200 and the compatibility observation passed (Incus 6.0.6, amd64, btrfs, nested Compose). The installed app source still needs the canonical root-path fix. Independent server inventory and operations remained empty. No successful SP admission, guest fixture, or restart checkpoint has been claimed.

The independent G2 probe used the same private connection context and pinned client/server identity. Approved project instance collection GET returned HTTP 200. The unapproved `default` project collection GET also returned HTTP 200, so the probe exited 1 and did not prove the expected HTTP 403 denial. The private metadata receipt is `/root/ezh-qualification-stage/oct03-g2-project-denial-receipt.json`. Independent server trust metadata confirms the exact client certificate matches the single `engine` trust entry, which is restricted to project `ezharness`. Collection filtering semantics or a direct existing-object denial must be checked before making an authority isolation claim. No trust entry or server permission was changed.

The corrected G2 probe used project objects, which have a distinct permission check from filtered collections. Under the same restricted mTLS identity, `GET /1.0/projects/ezharness` returned HTTP 200 and `GET /1.0/projects/default` returned HTTP 403. The probe exited 0. The exact reviewed script SHA-256 is `ccb46329b171b3fbfc67f8cc3893455c415102e2a463f1f22f02d029d57539af`; the private metadata receipt is `/root/ezh-qualification-stage/oct03-g2-project-object-denial-receipt.json`. The prior collection receipt remains retained. This proves actual backend project authority denial without a trust or permission change.

The canonical root-path source fix was cherry-picked into the isolated live worktree as `6adb23f19`. After both frozen dependency installs, the actual production image reader passed all four pinned GETs without a URL rewrite: image, canonical server root, btrfs pool, and Compose profile. The installed app remained the 241ab bundle; no qualification retry used uninstalled source.

At 18:07:12 UTC, the installed production inspection CLI, running as the actual app UID, captured a full server inventory through the existing reviewed SSH envelope and host-key pin. The root-private baseline is `/root/ezh-qualification-stage/oct03-g1-before-sp-inventory.json`, SHA-256 `a3b2495b3d0c3e9c68f0e58f5199af1d3525eda5e58b9f510bd2b1c2dd1807c0`. It includes host and server identity, routes and route bindings, all projects, pools, networks, profiles, images, instances, and trust metadata. A matching post-cleanup comparison remains required. This current interval baseline does not prove the missing historical setup inventory comparison.

The reviewed final forward installer `20ab76c608bc0a13f6b70cb1baae364c6698ae068c8cd6b008634d2b7defab44` passed active preflight, quiesce, swap, start preflight, and start. Source `70b4bdb1276b1306953b871e068327eaac49c5f5`, manifest `327d43e0bb7c9c59f5093100fde6d42559514be67aff275197c526ba2e1b4c3f`, is healthy behind the exact ingress hold. The database stayed current. The fresh stopped baseline and retained 241ab bundle remain separate. Supervisor and runner are active. Probe-fixture status returned READY with the same reviewed plan digest.

One qualification request used the same approved run ID `incus-live-sp01-08-20261003-v1`. It returned HTTP 409 after creating one stopped owned guest `ezh-c946b180415832d72a626fca8a84b79b`. Exact primary status reports generation 1, desired ABSENT, observed UNKNOWN, and existing cleanup DESTROY `ef7c6b70-5271-48bd-ad87-7d0a75fcee38` JOURNALED with no provider operation ID. No qualification retry or repeated guest command was sent. The route catches the exception without logging it; HTTP 409 does not prove no effect. A reviewed fresh stopped copy is being prepared to inspect the saved CREATE and cleanup states. Live qualification and native feature proof remain open.

The reviewed fresh-copy wrapper `3f1b7e95bcd6f0736a3ea797adb0400a7195ccee8529db1f86352b0f78c9403b` passed preflight and apply. The same 70b app restarted healthy. A disposable clone of the stopped current baseline shows CREATE `51856ef9-861d-48a7-994f-11e87656c1be` OUTCOME_UNKNOWN, with provider receipt `ezh-create-c946b180415832d72a626fca8a84b79b-0e3baabcceb14692e2ec52d431a7e685`. Its error code and message are null. The existing DESTROY remains JOURNALED with no provider receipt or error. Both reservations are RELEASE_REQUESTED. The binding is tombstoned, generation 1, with current operation DESTROY. There are no qualification-run rows. The exact saved operations remain intact for recovery; no repeat CREATE, DESTROY, or qualification was sent.

One real keyless model readiness turn passed on the unchanged 70b app. Normal authenticated APIs created conversation `9ef86d97-1e50-42fb-a233-aebb783faee2` in the existing unbound global project, then admitted run `1dcc1c5a-ea75-40b2-b78b-2d7f3f685899`. The exact user prompt was `Reply with EZH_MODEL_READY only. Do not use tools.` The saved run is successful and the saved assistant reply is exactly `EZH_MODEL_READY`, with provider `kilo` and model `kilo-auto/free`. The saved message response contains zero anchored or orphaned tool calls. No pending permission was approved. Both POSTs were sent once. No paid fallback, project sandbox binding, or server operation was used. The private receipt `27-model-readiness-final70.json` retains HTTP timings, run reads, and saved messages. This proves actual inference availability; guest tool and feature qualification remain open.

The reviewed recovery wrapper `0c9f245b83c92e8c65b9839bfe62a140a84d3c953171d21856f85dcf22cfdd22` passed active preflight, quiesce, swap preflight, swap, start preflight, and start. The active source is `f97661c7d16c8db0c09b8c7151d11a413742b51d`; manifest `c7d0d881d2fefba7a0791fee410d07c25e56788894ff869d1a38629fb518a6f7`. The fresh stopped current baseline and retained 70b bundle are separate. Current DB was preserved; hold remains exact; supervisor and runner are active; startup health passed.

Startup background recovery dispatched only the already queued DESTROY `ef7c6b70-5271-48bd-ad87-7d0a75fcee38`, with provider receipt `incus-destroy-2d06a889-f7a5-4cbe-81d7-a89aec2d74b6`. It first became PROVIDER_PENDING, then the same operation SUCCEEDED at 19:43:13.948 UTC with binding ABSENT/ABSENT generation 1. Independent all-project server instance inventory and active operations were empty. No operator CREATE, START, STOP, DESTROY, qualification replay, new ID, DB edit, or old DB restore was sent during recovery. Fresh post-cleanup reservation and saved CREATE readback is pending; the pre-cutover baseline is not used as current cleanup proof.

The reviewed fresh post-recovery copy `5e9b942d1b7c281b7269e6ed29458ee08eabf25118fe5ae47b19cfe2fe575eb3` passed preflight and apply; the same f976 app restarted healthy behind the hold. A disposable clone of the new stopped baseline proves the exact original CREATE `51856ef9-861d-48a7-994f-11e87656c1be` SUCCEEDED at 19:42:44.235 UTC with its original provider receipt. The queued DESTROY `ef7c6b70-5271-48bd-ad87-7d0a75fcee38` SUCCEEDED at 19:43:13.948 UTC with its saved recovery provider receipt. Both error fields remain null. Compute and disk reservations are RELEASED. Global pending operations, allocated reservations, and qualification runs are empty. The private readback receipt is `oct03-sp-after-paired-recovery-readback.json`. The original failed v1 attempt remains recorded; it is not counted as a successful qualification. Its immutable tombstoned primary fixture cannot be reused. Any subsequent v2 attempt needs a separate explicit control plan and review after these cleanup facts.

After terminal v1 cleanup, an explicit reviewed v2 control plan was prepared and applied with digest `14c5f9dcc0807a4f7635e08f03c38e8f983d9526eb8e06355dd45776fdc34ec7`. Apply and fresh status both returned READY. One qualification request used `incus-live-sp01-08-20261003-v2` on unchanged f976. It returned HTTP 409 `qualification_operation_preserved`, preserving START `64228811-9c7d-48b2-b9ca-c94f939b5ed4` OUTCOME_UNKNOWN and instructing no retry. The provider receipt was `incus-setPower-f2c89c59-4920-440c-bc09-5b743faa72cd`. No effect command or qualification replay followed.

Read-only status subsequently proved the same START SUCCEEDED at 19:49:59.958 UTC, with RUNNING/RUNNING generation 1 and error cleared. Independent guest `ezh-17ba7af7d669d0a124db7c79e564ef7a` is RUNNING; active backend operations are empty. Incus metadata says it was created at 19:49:17.562574134 UTC and started at 19:49:25.972635858 UTC, about 1.96 seconds after the START journal time 19:49:24.015 UTC. The qualification warning was emitted at 19:49:29.572 UTC, before the background terminal readback. No concrete provider error was logged. The running fixture and exact receipts are retained while the bounded readback wait is reviewed. This is not a completed qualification, and no new run ID is used to conceal it.

The bounded G6 diagnostic used the installed protected HostIncusGuestTransport and the same private approved mTLS identity. Its first guard rejected an IP hostname assumption before any request. The reviewed correction retained endpoint `sandbox-server:8443`, TLS hostname and leaf validation, and required all resolved addresses to be exactly IPv4 `100.81.181.39`. Fresh v2 ownership status matched before execution. Three fixed guest Python commands completed with exit 0: network/UID/cgroup readback, management TCP without application payload, and managed DNS. UID/GID are 1000. Guest cgroup values are memory.max 4294967296, cpu.max 2000000/1000000, pids.max 1024. Independent Incus configuration confirms hard 4GiB memory, 2CPU, 1024 PIDs, isolated nonprivileged host idmap beginning at 1065536, and a 20GiB root disk. Cgroup namespace values alone are not load-containment proof.

Guest TCP to `100.81.181.39:8443` returned connectCode 11 (timeout), with authenticated pinned host project GET 200 before and after. Managed `example.com` DNS resolved IPv4 and IPv6 addresses. Guest IPv6 interface/route readback shows loopback/link-local scope; independent bridge IPv6 configuration is `none`. This supports only disabled global IPv6 scope, not tested IPv6 firewall denial. No active neighbor listener, approved metadata target, synthetic secret consumer, or AMD filesystem canary was tested. No new target, listener, credential, privilege, or route was added. Private receipt `39-SP-v2-g6-readonly.json` preserves exact process identities and output.

After all read processes were terminal and fresh ownership status still showed the same successful START, one reviewed product cleanup request targeted the exact v2 primary fixture. HTTP 202 returned new saved DESTROY `315cb272-daed-4a97-8f43-ffb933305f4c` FAILED, error `REVISION_CONFLICT`, provider operation ID null, generation 1. The binding is desired ABSENT/observed RUNNING. Independent owned guest remains RUNNING with provider tag generation 2 and its prior power operation identity. No repeated destroy or direct backend deletion was sent. The failed saved operation and guest remain intact for private request/error diagnosis; v2 cleanup and qualification are not complete.

The reviewed failed-cleanup stopped-copy script `0f8ad9b002e9c84ece915b562f38302f4239078887101c8702418833052cf166` passed preflight and apply; the same f976 app restarted healthy. Private copied-DB readback confirms DESTROY `315cb272-daed-4a97-8f43-ffb933305f4c` requested provider expectedGeneration 2, matching independent guest tag generation 2. It remains FAILED with REVISION_CONFLICT and no provider receipt. Its saved message is the adapter generic constant `The Incus resource revision changed`, which does not retain the transport precondition. Both reservations are RELEASE_REQUESTED; no operation is pending. The running-destroy precondition is a source-supported diagnosis candidate, not a recovered original exception. The guest and failed record remain intact; no STOP, new DESTROY, direct backend deletion, or DB repair was sent. Private full request/error receipt is `oct03-v2-failed-cleanup-readback.json`.

While durable cleanup recovery was under source review, bounded read-only inventory and idle samples left the guest and operation unchanged. Installed f976 CLI inspection with the existing reviewed SSH context captured full host inventory at 20:17:06.785 UTC: 2 projects, 1 pool, 4 networks, 3 profiles, 3 images, 1 owned instance, and 1 trust entry. The root-private inventory SHA-256 is `5b508d2aa7b8e5db8c10f1350b916255c6419fb90ae3a4775d91157c6827d140`. The CLI needed an accessible install-root working directory for the dedicated app UID; no permission was changed. This is current inventory, not post-cleanup empty-inventory proof.

Two private samples read AMD and Incus-host `/proc` pressure, memory, load, CPU statistics, and uptime, plus guest state through Incus. No guest process or load was started. Over 75.493492979 seconds, cumulative guest CPU increased 154591000 nanoseconds (mean 0.0020477394 CPU cores); guest memory rose from 285143040 to 285908992 bytes; process count stayed 36. Incus-host CPU/memory/IO pressure averages at 10 and 60 seconds were zero; load averages were 0.06/0.07/0.02. The shared AMD host load was 6.35/9.96/16.99. These are raw held-fixture observations with missing baseline and thresholds, not a performance gate pass or a Q05 cycle. App health was 200, units active, hold exact, source f976 and manifest c7d unchanged. Status receipt 44 retains cleanup `315cb272-daed-4a97-8f43-ffb933305f4c` FAILED/REVISION_CONFLICT and binding ABSENT/RUNNING; it is held, not unknown or complete.

Exact immutable configuration comparison of the G1 before-SP inventory (18:07:12.644 UTC, SHA `a3b2495b3d0c3e9c68f0e58f5199af1d3525eda5e58b9f510bd2b1c2dd1807c0`) and held-v2 current inventory (20:17:06.785 UTC, SHA `5b508d2aa7b8e5db8c10f1350b916255c6419fb90ae3a4775d91157c6827d140`) found zero changed paths in projects (2), pools (1), networks (4), profiles (3), images (3), and trust (1). No field was ignored. Only top-level collection ordering and dictionary key ordering were normalized; nested arrays retained their order. Before instance inventory was empty; current inventory has only exact approved held guest `ezh-17ba7af7d669d0a124db7c79e564ef7a`, listed separately, and unrelated instances remain identical. Private receipt is `oct03-g1-held-configuration-comparison.json`. This proves those current-interval configuration collections stayed unchanged. It does not prove final guest cleanup, route/address equivalence, or the missing historical September pre-setup inventory.

Native G5 execution preparation staged the independently reviewed enhanced driver source SHA `624ee9873b433d4f8570890d9d62d3850be4d8be6464702de5c0571b4026c4d2` and a standalone Bun bundle SHA `0dc94dab92cb328bb8d88d5e6920aeec46932353751e512dc0c415722ea63abf` under root-private `oct03-native-g5` (directory 0700, files root:root 0400). Pinned Bun 1.3.14 bundled five modules; the bundle has no external module imports or require calls. The approved driver adds native Python code and positive/zero/negative unittest execution before Git commit and after retention, while retaining exact tool approval, canary, immutable Compose, saved-call, and no-retry controls. No driver runtime, login, inference, project creation, or guest effect occurred during preparation. Candidate, management project, cookie, and canary configuration remain unprepared until live qualification and exact-flow review. Staged code is preparation, not G5 proof.

The reviewed forward cutover to source `1907c09de309c07203713ae5d6a196e878b12bd4`, manifest `1df513a4a6bb65b7c9712a90a29873c8e24b6b95d2c4fc22811cc53f8bffeb54`, passed all sequential guards and non-root start behind the hold. The current database was preserved with a fresh stopped baseline; no old database restore occurred. Fresh status retained original DESTROY `315cb272-daed-4a97-8f43-ffb933305f4c` FAILED and desired ABSENT/observed RUNNING. One reviewed `recoverCleanup` request returned HTTP 202 at 21:28:31 UTC and saved recovery `6ce17abe-db81-47c0-ad93-df67e69c6a46`, STOP `1a2c4ad0-8040-44d5-b821-08193fc77cc7`, and DESTROY `c043816a-a507-4a37-ba7f-2e276df2a861`. Only background reconciliation and status reads followed. STOP settled, then that exact DESTROY dispatched and SUCCEEDED at 21:29:29.643 UTC. Status receipt 48 reports recovery COMPLETED and binding ABSENT/ABSENT. Independent all-project Incus inventory returned `[]` with exit 0. Fresh copied-database accounting proof remains pending; API completion alone is not a reservation-release claim. No fresh qualification was sent.

The conditional fresh stopped copy and same-source restart passed. A disposable clone proves recovery `6ce17abe-db81-47c0-ad93-df67e69c6a46` COMPLETED, linked STOP and DESTROY SUCCEEDED, and provider expected generations 2 then 3 while durable binding generation remains 1. The tombstone remains and current operation is the successful recovery DESTROY. Compute and disk reservations are RELEASED. Global queries across all sandbox operation rows and all reservations returned pending `[]` and unreleased reservations `[]`. The original failed DESTROY metadata and its full selected request/error row are unchanged from the retained pre-recovery copy; canonical before/after row SHA-256 is `b3cf2782240bb50f5d48374576eda7f378440709cb3453067563ac7aeacdc478`. Sanitized private receipt is `oct03-v2-linked-cleanup-sanitized.json`; live PGlite was never opened by the diagnostic. Only after this proof, a v3 plan-only request returned HTTP 200 with digest `ef445a9160061c4cfd42123f620f2061ab9b45aa5b98e97ab13d2dec20142d22`. It retains the exact provider scope and proposes four local canaries/projects and two inert control bindings. No v3 apply or qualification was sent at this milestone.

The exact reviewed v3 plan applied once and status confirmed READY with digest `ef445a9160061c4cfd42123f620f2061ab9b45aa5b98e97ab13d2dec20142d22`. With health 200, one qualification POST was sent after an exclusive, fsynced request marker. It returned HTTP 409 `qualification_unavailable`; no retry occurred. Fresh stopped-copy readback proves primary CREATE `2e21e183-c23c-4481-a4c6-b53aa4047210` and START `102ca01d-a0f7-4f2e-a9e7-fbe6886e377e`, plus unrelated CREATE `0d76b248-3870-4123-9cc5-6f12c0796f3b` and START `20046876-ec19-4965-9a2a-4b00269adf49`, all SUCCEEDED. Failure preceded the restart checkpoint: no v3 run row, recovery fixture, or error-log row exists. Its exact exception is unavailable because the generic route catch does not log it. The observed window is after unrelated START success at 21:42:49.805 and before cleanup primary STOP at 21:43:06.188 UTC; enforcement and controlled-load verification occur there in source, so neither is claimed passed. Product cleanup STOP and DESTROY for both fixtures SUCCEEDED; final unrelated DESTROY `302e67e3-6812-4427-b141-36d501d2e3dd` succeeded at 21:43:53.881. Global pending operations and unreleased reservations are empty, and independent all-project Incus inventory is empty. Fresh snapshot/restart preserved source 1907 behind the hold. V3 is a failed qualification, not a green SP suite or native lifecycle.

A fresh full inventory after v3 cleanup at 21:53:00.351 UTC was compared with the before-SP inventory at 18:07:12.644. Projects (2), pools (1), networks (4), profiles (3), images (3), and trust (1) remain exactly unchanged after collection ordering normalization; instance inventory is empty in both. Only capture time and host free bytes were excluded as volatile fields. Exact network set comparison found one removed eno1 IPv6 address, `fd09:6fdd:d16f:4ce8:8b4e:ace2:b25f:163d`, and its route/binding entries, with no additions. That change was retained rather than ignored. Full route/address parity is therefore not proven; no historical September setup parity is claimed. Private records are `oct03-g1-after-v3-inventory.json` and `oct03-g1-post-v3-comparison.json`.

The independently reviewed diagnostic bundle source `74970fa36c4f1a63d393e0f48e9773100b55f281`, manifest `863a1fe7ebefa1038c53adb78c7648b1ad665f261526bcdeb2884052cbc5e907`, was installed with wrapper SHA `b491fc9ca5b8a28930412f391dc075cde9314a1bef095fbab769ac48f4919835`. Every sequential preflight/quiesce/swap/start gate passed; the current database was preserved with a fresh stopped baseline, prior 1907 bundle retained, and app healthy behind the hold. V4 exact plan digest `625dd727d72153478e83e26d67d8b64645a94e2fe4930906700fc2accaf7cdc6` applied once and status confirmed READY. One qualification POST followed an exclusive fsynced request marker. It returned HTTP 409 `qualification_preparation_failed`, stage `enforcement`, cause `distinct_ip_literal_targets_are_required`, cleanup `confirmed`. This is the actual classified v4 cause; no inference from a generic error is needed. A saved cleanup STOP briefly reported OUTCOME_UNKNOWN, then the existing controller settled it without repeat dispatch from the operator. Primary DESTROY `3eb62c3c-207f-4be5-841d-36fbfde855de` SUCCEEDED at 22:24:59.970 UTC and binding is ABSENT/ABSENT. Independent all-project Incus inventory returned empty. Current v4 ledger release awaits fresh copied-database proof; API cleanup alone is not that proof. No qualification retry or native project creation occurred. This pinned diagnostic candidate is not claimed identical to the later main merge.

The reviewed FQDN-fix candidate `ad2b151df1c8408946e4ce89f4769878a4382b65`, manifest `799613706f79f08e7fed30ea6536b586c6448beb1aece5d37960c60a87457d56`, passed the complete guarded cutover with installer SHA `0bd09cf241fd77a0724abc968b0f5e2360efe6b8d853e72b1cbfac48af7ca45c`. Its fresh stopped baseline supplied a separate disposable-clone v4 readback: both fixtures ABSENT, all eight lifecycle operations SUCCEEDED, both compute/disk reservations RELEASED, global pending operations and unreleased reservations empty. Metadata-only receipt is `oct03-v4-ledger-sanitized.json`; no separate service stop was needed.

The reviewed v5 plan digest `2838a81d912a2474bf82c45f15e3fc17ce9eb4a709a7d0e344298d5efce50cd5` applied once, status confirmed READY and health was 200. One qualification POST followed an exclusive fsynced request marker. Actual response was HTTP 409 `qualification_preparation_failed`, stage `enforcement`, cause `othersandbox_control_target_is_not_reachable_from_the_host`, cleanup `confirmed`. This proves the previous literal-target guard was crossed and identifies failure of the host positive control for the neighbor target; it does not prove neighbor isolation or controlled-load containment. Saved primary DESTROY `da73e1cc-9a9d-49f9-b56d-ffb042ce4822` SUCCEEDED at 23:01:21.488 UTC; binding ABSENT/ABSENT and independent all-project Incus inventory empty. Current v5 global accounting awaits a fresh stopped baseline; it is not inferred from cleanup status. No qualification retry, v6 plan, route/firewall change, new credential, or server privilege occurred. App remains the pinned ad2 candidate, healthy behind the hold. The later source head is not claimed as the deployed bundle.

## Current evidence scope after v5

G2 cross-project backend denial and v4 global cleanup accounting are proved by the exact receipts above. V5 retains its classified enforcement failure and confirmed guest cleanup; its global accounting is not yet proved. SP01–SP08, native user-project execution, and ten consecutive full feature cycles remain incomplete. Current management prepares an empty remote workspace, not a repository checkout. Repository bootstrap, preview/log browser flows, a guest secret consumer, and cross-host/provider portability remain unproved. Real keyless model readiness and staged native driver code do not substitute for those product flows. Historical observations above are preserved at their stated time and candidate.


## October 4 guarded update and v6 result

The fresh stopped baseline from the 9c3 app update proved v5 accounting: both fixtures ABSENT, all eight lifecycle operations SUCCEEDED, compute and disk reservations RELEASED, and global pending operations and unreleased reservations empty. Private metadata receipt `oct03-v5-ledger-sanitized.json` SHA256 is `5f302949f5d57f7f2133065bf065cde082ccbca116c6bec8640d679610f029d4`. This advances the earlier pending v5 ledger claim only.

The user-approved server update retained the exact candidate, gate, policy, and authority through four failed staging or activation attempts. A tar flag conflict failed before extraction. A Nix JSON shape guard failed before arming. A relative timer deadline guard refused after test activation; the reviewed rollback restored both external files before the old system and profile. A later control check failed because root SSH rejected the existing group-readable key. Its exact rollback also completed. No key permissions were changed. The final driver used the existing service identity UID/GID 62040.

An instrumented harmless timer rehearsal proved a whole-second boot deadline stayed exact across daemon reload. The retained `/true` service started 4,792 microseconds and exited 33,386 microseconds after that deadline. Seven unrelated timer property sets stayed equal. The owned units were stopped and the old system verified. Private receipt SHA256 is `46616204cdd2ad2218bd79716a224d6adec3987d5547bd6d1ae7add3c73a4454`. Earlier unsuccessful rehearsals remain retained; they are not passes.

The final guarded server update completed. Active system and profile are `/nix/store/wwipbxfgqsb5z24px0whsdlf2m2dzhfm-nixos-system-sandbox-server-26.05.20260430.15f4ee4`. Gate SHA256 is `73dbd83f1212a54b3d046adc0ac878653651345adbb6ed205b3f5b99c2e63eb8`; policy SHA256 is `88941390ced553e6f2aab435eb7d23a1d911313a8b52c3b48f14f6ac32bf1a6e`. Fresh capability, inventory, scope, shell, and forwarding controls passed. Rollback timer and service are inactive; observer guards passed. Receipt SHA256 is `496f513c85ddd90b411e9bc547799c5e218cb11da055c2a3a15f378a2f080775`. Independent inventory was empty and all seven unrelated timer property sets matched the rehearsal snapshot. This does not close the historical G1 route/address gap.

The guarded app update installed source `214cc678bc251f9578e2fc0019a200094bd5aadb`, manifest `802c126a2c31d9b30b798b471d080e99c88e2c47a83764ec3432f856a6aa8b76`, preserving the current database and a fresh immutable stopped baseline. Health and hold checks passed. Fresh source/services/capability preflight receipt SHA256 is `4cde136c9ff77767b8313794c8cecb24010355f27e4608e5f5681fbf8ead89ec`.

V6 plan digest `7e14d1e5504dd71de3789dd13a14c81c3385de5c9ba743e483e7526b321b858e` applied once. READY matched all four control projects and canaries and both inert bindings. One qualification POST followed an exclusive request marker. It returned HTTP 409, stage `limit_loads`, cause `cpu_load_did_not_prove_containment`, cleanup `confirmed`. The CPU proof JSON was not persisted at the failing source seam; no numeric containment claim can be made from this response. No workload or qualification was repeated.

Primary DESTROY `c7817b58-f16d-4ea7-a619-808a52678255` and unrelated DESTROY `c728cbe7-e08c-4fd3-9078-987cfc7fc1fb` are SUCCEEDED; both bindings are ABSENT/ABSENT. The recovery fixture was not allocated before this preparation failure. Independent all-project inventory is empty, receipt SHA256 `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`. V6 global reservation accounting still needs fresh copied-database proof. SP01–SP08 and native ten-cycle product proof remain incomplete. Repository bootstrap, preview/log browser flows, guest secret delivery, and portability remain unproved.

## October 4 CPU correction and restart test

The corrected app source `9bc0cd5f9143139866ef567fc4dba70332862bb3`, manifest `d678747774b0afbc75aba9c2526bbf8bce00d87b66ef7a2e5ac66201dd029819`, passed bundle verification, startup smoke, and the guarded update. The current database was preserved. The CPU correction passed 44 focused tests with 287 assertions, independent review, and 100% measured coverage in the three changed source files. These checks do not replace live qualification.

A disposable clone of the fresh stopped baseline proves v6 accounting: eight operations SUCCEEDED, both bindings ABSENT/ABSENT with tombstones, both compute and disk reservations RELEASED, no qualification run, no pending operations, and no unreleased reservations. Private receipt `oct04-v6-ledger-sanitized.json` SHA256 is `9a697bd3d1d57b40b48c148c2e4b3f74dbd4bb3769d83b2b309d73a3d8f78808`. The live database was not opened by a second process.

V7 used operation `incus-live-sp01-08-20261003-v7` and plan digest `f7dcc8bfd357b2c435f160397ae24653dc122c89ed75e81c832257bb8e7ddb3b`. The plan applied once, READY matched, and one qualification request returned HTTP 202 with state AWAITING_RESTART. Preparation crossed the CPU proof. The automatic engine restart occurred; continuation failed at 02:27:59.501 UTC with `Incus probe fixture receipt changed`. This is a failed qualification, not a pass for all eight cases.

The primary STOP `a9dda8b8-2a49-4dd3-be74-69b0aa79f5a6` and unrelated STOP `938f2584-bc49-48cb-86ca-df685f393daa` both SUCCEEDED. Independent inventory showed exactly those two stopped guests and no active processes; the recovery fixture was not allocated. Saved evidence is being inspected before cleanup. Source review found order-sensitive JSON scope comparisons after database reload; the exact persisted predicate and regression remain under verification. No qualification replay or normal feature cycle was started.

Fresh stopped-copy readback proves the exact v7 cause. Saved plan scope keys are installation, release, connection, preset; checkpoint JSONB returns preset, release, connection, installation. All four values match. Only the stringified scope comparison failed; saved digest, operation ID, directory, cases, and every other metadata predicate passed. Private receipt `oct04-v7-predicate-sanitized.json` SHA256 is `01be7b5c8a7a9d788614d7a71bdec78891ee43cebfb0b2a8d2aa1159ea1d154e`. A local database dump, close, and reopen reproduced the same failure through the reconstructed fixture service. Successful CPU preparation measurements were not retained in the checkpoint; no numeric result is claimed.

The authorized product cleanup completed: primary DESTROY `ca7cb0f6-15db-4086-8c55-ac16d2384c1d` and unrelated DESTROY `2baf7dc1-2d85-401e-8c0a-3e59ae0068c6` both SUCCEEDED with ABSENT/ABSENT bindings. Independent all-project inventory is empty. The original failed run remains unchanged. Reservation and global journal accounting await the next fresh stopped baseline; they are not inferred from guest absence.

## October 4 scope correction and recovery probe

The scope correction preserves legacy fixture IDs and plan digests while comparing validated scope fields without dependence on JSON object key order. Its actual database dump/reopen regression, 67 focused tests, types, lint, and independent review passed. A separate coverage run passed 80 tests and measured every changed line and touched function. The guarded update installed source `973609aa1917348d6108e80d3d9a72419d004bfe`, manifest `06de35cc196445cff2f81bde6047d22fbd4a45441d98cc7daf4925e62c32daf6`, preserving the current database. The fresh stopped baseline supplied v7 accounting: both fixtures tombstoned and absent, eight operations succeeded, both reservations released, and global pending operations and unreleased reservations empty. Private receipt `oct04-v7-ledger-sanitized.json` SHA256 is `f491d67b61e52abf10eed516b8546d103e206bbceca212f13d28d17b3299c764`.

V8 used operation `incus-live-sp01-08-20261003-v8`, plan digest `08a4ab89e7338462cf35c084f23599c5e0b304ed098a496653c5294b29cca9d4`. One Apply and one qualification request followed fresh pinned-source and service checks. Preparation passed and the saved engine restart continued past the former scope failure. The final recovery probe failed at 03:10:16.649 UTC with `Incus recovery probe failed: lost destroy effect is not durably uncertain`. No qualification replay followed. All eight qualification cases remain incomplete.

Failure cleanup completed through the product. Primary DESTROY `833d8ee9-5a47-4faf-9f67-bd3936a9eede`, unrelated DESTROY `9ea5dcc2-c241-41f2-8deb-19755ce54995`, and recovery DESTROY `a3ceef2b-7845-4c1d-8f8a-4f5837c032a4` are SUCCEEDED. Independent all-project inventory is empty. A separate stopped-copy audit confirms all three bindings absent and tombstoned, all compute and disk reservations released, and no global pending operations or unreleased reservations. The original run remains FAILED. Private receipt `oct04-v8-fault-sanitized.json` SHA256 is `823ee04d3f72ee4b2d12915f68a7e6848efa9c0bb9fd3acead98408fba359e90`.

The final operation row does not preserve the state at the failed assertion: failure cleanup can reconcile that same saved operation before the error is logged. Source review and a real-controller regression found a separate contract error: the durable controller returns OUTCOME_UNKNOWN after a lost provider reply, but the probe expected an exception. Its caller also counted any exception as the intended fault. The fix and complete native receipt regression are in progress. This confirmed defect alone does not establish the historical v8 cause.

The fast local gate on source 973 passed lint, types, component tests, and build, but failed one backend witness fixture that lacked the newly required CPU proof fields (27,390 pass, one fail). Commit `f2f09b277b378cfe3346443faabc19d397cc5b6d` corrects only that fixture; all 15 targeted tests pass. A fresh full fast gate and exact-source browser/coverage checks are still required. Hosted checks on the older pushed head 214 are green after one hosted-runner communication failure and a passing diagnostic retry; these are not evidence for the current unpushed changes.

The operator supervisor had another concrete defect: it required the cleanup-fault guest to equal the original restart guest, while the checkpoint authorizes a separate `qual-recovery-<runId>` guest. A regression with the real recovery identity failed with `fault claim mismatch` before dispatch. The correction requires the exact derived operation, a binding distinct from the original, and the same run, nonce, scope, and connection revision. It retains the independent verifier's stopped-guest ownership and provider-generation checks. The three Python wrappers pass, including real process restart, kernel peer checks, signed one-use receipt, fault arm/readback, and forged identity denials. This reproduces a blocker in the installed v8 source; the discarded historical exception is not recovered. The original failed v8 record remains unchanged.

V8 local control cleanup also completed through the normal API: all four exact control projects and both inert bindings are absent in an untruncated management response. Private absence receipt SHA256 is `aa49a10d918e9e080baaa24599d244409763a54ebd9024fc9b8d437897c5a1f0`. The reviewed native supplement archive SHA256 `43def89f29fc445f87a15f320ea29e7dca72afebd8eadad2f1f1fe27c24e4d7e` is staged privately. No normal user feature or supplement runtime has executed.

The host correction is integrated as `6da8dbab4` from reviewed commit `071666dca8d0ed61b7d82bbb14d38fa5951216b9`. The injector now requires a durable OUTCOME_UNKNOWN record and proof that the exact authorized fault was consumed. It resolves only after that proof; its caller no longer treats arbitrary exceptions as injected loss. Errors expose only a fixed stage and a bounded saved-state value. Five focused suites pass 79 tests with 550 assertions, including an actual signed checkpoint, JSONB scope reload, supervisor-command authority, and refusal cases. Types, lint, and mapped commit checks pass. The separate delayed native receipt suite passes 23 tests with 249 assertions through the adapter, broker, transport, controller, and real fault object; an expired fault does not fabricate UNKNOWN, and background reconciliation leaves the recovery journal for its explicit owner. Focused coverage and a new installed live qualification remain required.

## October 4 candidate 63237 and v9

Source `63237ccf376d49722dc6139a7f4a12f2c88528a7` passed the fast local gate: 27,399 backend tests, 3,638 web Bun tests, 7,719 component/server tests, types, lint, Svelte checks, integrity checks, and build. Focused recovery coverage passed 102 tests with 799 assertions; all three changed TypeScript source files and all 31 changed measured lines were covered, with maximum touched-function CRAP 28. The separate coverage worktree first lacked the already-fixed CPU witness fixture; that failed log is preserved and the correct fixture passed. No source or threshold changed to obtain the coverage result.

The release bundle manifest is `78cae9d72271336746377effd93809da85e7115445eef86d48e237d1aed91fa7`. Independent integrity verification and non-root startup passed (HTTP 200, UID 1001). Guarded installer `f50f4308d9ff9998f6400c01227a071971fbfb6dae203075ee7ce3a36891841c` passed preflight, quiesce, swap preflight, swap, start preflight, and start. The current database was preserved; the previous 973 bundle and a fresh stopped baseline remain. This source is pushed to PR #303; hosted CI is in progress.

V9 operation `incus-live-sp01-08-20261003-v9` used exact plan digest `3c270e689dfc16db45e1f641dd59ca2053bc571a6d2344b2776ee52058914866`; private plan file SHA256 is `4e70ebd4354a57c2742e4ca7b36b7703181040bba6930e03e991541d007c7cc8`. One Apply matched READY. Fresh bundle/service/hold and seven server-control checks passed. One qualification request followed an exclusive marker and returned HTTP 202 AWAITING_RESTART. The automatic continuation failed at 03:57:20.284 UTC with `Incus qualification fixture cleanup is unverified`. No qualification replay followed.

Product cleanup left all three fixtures absent. Primary DESTROY `23185cb6-ff8a-4e4a-aaf8-a7132d0ee08b`, unrelated DESTROY `28325734-ce42-42df-89b2-48d81866b78b`, and recovery DESTROY `13f1df29-8ac4-4040-9995-93274d4031c9` are SUCCEEDED. Independent all-project guest inventory is empty and backend operation inventory is empty. Current v9 reservation accounting still requires the next stopped baseline; terminal operation rows alone do not establish the transient state at the failed assertion.

A signed-checkpoint reproduction through the real fixture, controller, and feature service produces this exact cleanup error when the first provider inspection remains pending: the probe tries terminal settlement after one inspection. A separate readiness audit found that historical failed DESTROY receipts are rejected even when their linked cleanup recovery completed. Both paths are being corrected with strict saved-operation and recovery-link checks. Original failure receipts remain intact. These reproductions do not recover a discarded historical stack or transient v9 state.

An audit used a unique disposable clone of the existing immutable pre-632 stopped baseline; it did not stop services or open the live database. All 18 historic DESTROY rows were checked against the readiness predicates. Exactly two failed: original FAILED `315cb272-daed-4a97-8f43-ffb933305f4c` failed the succeeded/current checks, and linked SUCCEEDED `c043816a-a507-4a37-ba7f-2e276df2a861` failed the original scope/key checks. COMPLETED recovery `6ce17abe-db81-47c0-ad93-df67e69c6a46` links those receipts through successful STOP `1a2c4ad0-8040-44d5-b821-08193fc77cc7`. Every other historic row passed. Private receipt `oct04-historic-cleanup-audit.json` SHA256 is `f7a889599fce0d888c353b616de4f5e6f0414d16781e12c984751fcf59d594cd`. This confirms a real readiness blocker but contains no v9 rows. The retained v9 error has no stack location, so its exact throwing line remains unavailable.

The bounded-readback correction is integrated as `c11cadfbc` from `09d501869813002f46fb3f1f1f46196ba77b906f`. It reuses the existing exact-operation waiter before terminal settlement. The complete signed-checkpoint recovery probe now passes with an initial UNKNOWN inspection, the same saved and provider operation IDs, released accounting, and one DESTROY dispatch. The fixture suite passes 55 tests with 386 assertions; the controller suite passes seven with 65 assertions. Types, lint, hooks, and independent review pass.

The historical readiness correction is integrated as `87d788d9f` from `22f268c46`. It reuses the failed-receipt policy and requires the exact completed recovery's original failure, successful STOP and DESTROY receipts, matching generations and scope, current absent binding, tombstone, and released original reservation. Arbitrary successful later deletes do not clear history. The original failure record is not changed. Eighteen focused tests with 234 assertions, types, lint, hooks, and independent review pass; changed validation functions have complete measured coverage and complexity below 30. Combined coverage and installed live proof remain pending.

V9 local controls were removed once through the supported API. An untruncated management response confirms all four project IDs and both inert binding IDs absent. Private receipt SHA256 is `73ff8605c42e73383664beaf9d0ef269337f6936f24008d314758405296ba3fa`. The failed run, exact plan, and guest operation receipts remain.

NixOS PR #14 at `e07a6ca37e9c5063c4ffc82d2471f3bd0fe09c0a` passed fresh module, access, runtime, no-build flake, and cached offline AMD build checks. The result is the current `/nix/store/33gh6nkfwn3k23mqvn4ls48lbw6klg18-nixos-system-nixos-amd-26.11.20260929.b4fd65b`; no new activation occurred. The PR is ready for non-author review. Its qualification units remain configured with automatic start disabled.

## October 4 candidate 8cf769 and successful v10 qualification

Source `8cf769a2b1aa039d7250bbd2db3d93af0c319f9b` passed all fast local gates: 27,402 backend tests, 3,638 web Bun tests, 7,719 component/server tests, types, lint, Svelte checks, integrity checks, and production build. Combined focused cleanup coverage passed 80 tests with 685 assertions. All 39 changed measured lines and touched functions were covered; no measured CRAP score exceeded 30. The commit is pushed to PR #303. All 51 hosted checks passed for its predecessor 63237; those results do not establish current-head CI.

Bundle manifest `f6e11fef500b030c13d76f0d7c1e96b3124c762b7aedf342fb9f4813a0f17671` passed independent verification and non-root HTTP 200 startup. Guarded installer SHA256 `bc1a4adb333e5e23ef2ace3e4d603368e80b88c75bafa96cf003557b71f272a1` completed all six steps. The current database, ingress hold, and service wiring were preserved. The previous bundle and fresh stopped baseline remain available.

A unique disposable clone of that baseline supplied v9 accounting without opening the live database. Original run state remains FAILED. All 12 operations succeeded; all three bindings are absent, tombstoned, and cleanup-confirmed; all three compute/disk reservations are released; global pending operations and unreleased reservations are empty. Private receipt `oct04-v9-accounting.json` SHA256 is `914ab62a289fc6fc6ecb4f1144b4ce9fcb8005b17ca05ad31433da393ab7c919`.

V10 used operation `incus-live-sp01-08-20261003-v10` and reviewed plan digest `8872b3498cd03a6fc3882c4e37897666525f6ee7c46bf08c6f7cef4128e7f2e8`. One Apply matched READY. Fresh bundle/service/hold and seven server controls passed. One qualification request followed an exclusive durable marker and returned AWAITING_RESTART. Its supervised continuation completed successfully. Normal management reports the exact Compose profile as qualified, with qualification valid until `2026-10-04T05:30:00.085Z`. Private management receipt `103-SP-v10-management-terminal.json` SHA256 is `da498b9f36a21afd5e5677d5605e87b0d6feae726eb96ed14f029f102783b679`.

Primary DESTROY `79f15bc9-b87b-489f-a6d8-4fba0297f38b`, unrelated DESTROY `96bea564-6a43-4704-9a45-c10d795ddb2d`, and recovery DESTROY `14c8043d-64cb-4f81-8293-0a52e736f306` succeeded with absent bindings. Independent all-project instance and backend operation inventories are empty. The final stopped-copy accounting audit will also verify these reservations. This closes live qualification; it does not yet prove the normal user feature flow, ten-cycle target, guest secrets, repository bootstrap, or independent-provider portability.

## October 4 normal-flow preparation and current-main runtime review

V10 local control cleanup completed once through the supported API. All four control projects and both inert bindings are absent; the successful qualification remains. The first normal browser attempt sent no feature request and created no project or binding: the isolated account's unfinished onboarding redirected management to `/onboarding`. Its incomplete receipt is retained. Normal UI onboarding was then completed using the existing model configuration, and a new browser reached the Incus management screen. No API seed or test bypass was used.

Main `beaff68c8a4aa53dd1ac9968b440efbb321923df` landed during this proof with Pi 0.87.1 and a composer correction. Merge `42e7a2c2c2093c2926953a831c34864179c2c102` is conflict-free; both frozen installs, targeted runtime/composer tests, types, and lint passed. The isolated app remains on 8cf769 while independent runtime review is completed.

That review reproduced two new dependency-integration failures through the actual EZHarness agent loop and a loopback HTTP provider. Short and compacted turns lost system instructions because the converter removed system messages. A separate historical tool-update fixture showed trimming restore an obsolete tool and discard updated instructions. Pi 0.85.1 supplied system instructions and tools separately; 0.87.1 derives them from the converted transcript. The earlier passing tests did not cover this boundary. Corrections and actual-wire regressions are in progress; no normal guest workflow has run on the affected candidate.

The corrections are integrated as `3b3a8c517` (shared compaction) and `c5789d770` (provider conversion). They use Pi's existing system-state replay helper, reserve the full effective declaration cost before trimming or summarizing history, and preserve system messages at provider conversion. Removed tools stay removed; current instructions and named sections survive. Saved history and model limits are unchanged. Seventy-three focused trim/summarize tests and five actual agent-to-HTTP tests with 44 assertions pass, including initial and post-tool requests. Full type checks, lint, and hooks pass. The compaction fix passed independent review; final converter review and changed-line coverage are in progress before isolated installation.

## October 4 merged candidate and refreshed qualification

Both runtime corrections passed independent review. Combined focused coverage passed 96 tests with 300 assertions, both production modules at 100% measured coverage, all 17 changed measured lines covered, and maximum CRAP 23. Source `aaa3cf9f91c847085eb54a9f05bb6b6005ec9b60` passed all fast local gates: 27,409 backend tests, 3,638 web Bun tests, 7,722 component/server tests, types, lint, Svelte checks, integrity checks, and production build. It is pushed to PR #303; current-head hosted checks are still running. All 51 hosted checks passed on the previous 8cf769 revision.

Bundle manifest `036fcb6ed300756928612ec1a57ebbff9e722d0006cd764ad535cd0c2dfd1950` passed independent verification and non-root startup (HTTP 200, UID 1001). Guarded installer SHA256 `005517ce3c1942fe350396dbc176cefccfbc3c525a0713092318ae5778b7a69c` completed all six steps. The current database and completed onboarding were preserved. A subsequent test-only commit, `a7dc77d27`, does not change deployed production code, configuration, or dependencies.

The fresh stopped baseline supplied v10 accounting through a distinct disposable clone. Private receipt `oct04-v10-accounting.json` SHA256 is `3a369b8e358e1023d44e3a6feeb9d2241e0aa6b9bbab3790633478e4e6cd160a`. It records COMPLETED, all SP01–SP08 cases passed, the exact approved release/connection/profile/image/helper, three absent tombstoned and cleanup-confirmed bindings, all reservations released, and no global pending operations or unreleased reservations.

Because that qualification was near expiry, one refresh ran on the merged app under the unchanged expiry policy and resource budget. Operation `incus-live-sp01-08-20261004-v11` used plan digest `1a1dff5dd74c1e557d55fc4d66a20dc5cab1ad7532c737606561483f2ccfac95`. One Apply, exact READY, fresh installed/server checks, and one durably marked qualification request completed successfully through restart. Private management receipt `109-SP-v11-management-terminal.json` SHA256 is `7d0fe24955af608cd93a2b54d04ca6702b39c074e806c8e809bdc56d33772cc6`. The exact Compose profile is qualified until `2026-10-04T06:17:45.066Z`. All three saved fixture deletes succeeded with absent bindings; independent instance/operation inventories and all four local control projects/two inert bindings are empty. V11 reservation accounting will be included in the final stopped-copy audit.

The next browser attempt again stopped before any request: the proof used exact label text for a select whose wrapping label includes option text. Both the installed page and an independent Chromium reproduction have the correct accessible combobox name; no product accessibility defect was established. The original incomplete receipt, empty mutation list, absent project/binding, and no-effect readback remain. The amended archive SHA256 `55d0ee0a5b599b01070802b79121ea766a68ee728b1beb88ec1d4e36143431f1` changes only that locator, adds the actual-browser regression, and updates its manifest. Independent review and 19 artifact tests with 129 assertions pass; native files and authority/retry guards are unchanged. No product redeployment was needed.

The test-only credential boundary proof in `a7dc77d27` composes the active Incus manifest, production ReleaseProcess reverse-RPC dispatcher, and attached credential handler with a synthetic resolver. Undeclared `env.get` and `credentials.read` return CAPABILITY_DENIED before handler, resolver, or backend dispatch; captured output excludes the canary. The focused suites, types, lint, hooks, and independent review pass. This proves the host boundary with an in-memory runner transport; it does not claim live guest secret delivery. Managed DNS, disabled global IPv6, and the absence of an approved metadata test target remain explicit limits of the live negative-test evidence.

## October 4 first UI-created sandbox and lifecycle-response correction

The amended normal browser flow prepared project `incus-project-37aba303d95baf7ca8d1bc525e8b3df813e01fb83a402688` and binding `3fcc24fc-66da-4d51-a0ca-31ea90470fd9`, generation 1. Preparation returned 200. The single CREATE, idempotency key `0ded506e-0a9e-4082-bb50-7c22fca9500e`, returned HTTP 409 without a response receipt. No CREATE retry, START, or native inference followed. Normal status exposed saved operation `9b542086-2b46-40cf-9ba4-7ce0c36d558d` as PROVIDER_PENDING with its provider receipt recorded. That same operation settled SUCCEEDED at `2026-10-04T05:32:52.676Z`; the binding became STOPPED/STOPPED. Independent backend readback confirms stopped guest `ezh-34b610683213b5e219592c7bf10b512f`, exact ownership tags, and the original create key. Its reservation is legitimate held capacity while diagnosis proceeds.

The original browser did not retain the 409 body, and the bounded journal window had no exception stack. A subsequent actual PGlite/controller/service regression found that the returned operation contains the internal `reconcileOrder` BigInt; SvelteKit JSON serialization throws on that real result. An unchanged route test reproduced expected 202 versus actual 409 with the same database-shaped operation. These are reproduced defects at the observed post-admission response path, not a recovered historical response body.

Commit `d2de80a8a` projects the same public operation fields already used by status/recovery across all lifecycle responses. Saved IDs, provider receipts, state, generation, timestamps, and error code remain; internal counters and private journal data do not leave the route. Controller behavior, HTTP admission rules, and authority checks are unchanged. An admitted response may carry explicit OUTCOME_UNKNOWN; it is not a completion claim and does not authorize redispatch. Real database/SvelteKit tests pass 14 cases with 161 assertions, Bun route tests pass 14 with 63 assertions, and Vitest route tests pass 10. Full types, lint, hooks, and independent review pass. Installation and normal-flow validation of this correction remain pending. The failed first UI cycle will remain separate from the subsequent consecutive-success batch.

Hosted CI on aaa3cf9 passed 50 checks and failed the per-file coverage gate: management page line 323 was not measured, leaving 99.65% against its unchanged 100% threshold. The damaged-storage journey could overwrite its stored record again before client hydration restored retry keys. A test-only repair now waits for a real lifecycle action and checks valid-key retention and malformed-entry removal before the next corruption. Focused browser measurement is in progress; no production UI code or coverage threshold changed.

Focused DTO coverage confirms all five changed measured route lines hit and the new public projection at 100%, with maximum measured route CRAP below 30. The focused producer does not cover five existing route paths; it is not a full per-file gate result. Bundle manifest `0214958bb6fdcac24f3d06bceddee2b5a3dca05fe4e6e791aa57b79fc1b39896` for d2de80a8a passed independent integrity verification and non-root startup (HTTP 200, UID 1001). Installer SHA256 `3119d9105f8396068560cedf95b532be4ed8ecaa903cf3bacfd2c358458fa11c` matches the reviewed template after only source and manifest substitutions. The guarded update and exact normal UI disposal of the stopped diagnostic guest are authorized; their results remain pending.

The retry-record test repair is integrated through `e7e005206` (test-only changes). Its first focused run found an incorrect test state label; the second exposed a second race, where initial START completion overwrote the deliberately damaged record. Both failed logs remain. The final test waits for running state and enabled Stop before inserting the record, then completes a real Stop after reload before asserting retained and rejected keys. Independent review and the focused real-auth browser run pass. The same-build browser coverage records three hits on line 323, versus zero in hosted CI. This focused diagnostic is not the complete browser coverage gate. A separate successful linked-cleanup response test brings route tests to 11 passing cases and covers the existing recovery response branch; all five changed measured route lines remain covered.

All six guarded update steps passed for d2de80a8a. The current database and prior bundle were preserved. The exact diagnostic guest was then disposed through its normal UI after fresh source checks. One DESTROY `511c7dc4-3f68-45b2-82bc-8b36960f6cfc` settled SUCCEEDED; binding `3fcc24fc-66da-4d51-a0ca-31ea90470fd9` is ABSENT with tombstone and confirmed cleanup. Private terminal receipt SHA256 is `97b63a6ed11a8a2b92f13907a4bc4b3cf3ddcc70794354fb65a6be44a9d25efa`. Independent instance and backend operation inventories are empty. The original failed UI cycle remains excluded from the success batch; reservation release will be checked in the final stopped-copy audit.

V12 renewal plan digest `f0aac05e2ed11b21e73db1c90f891c4a426e4f238ea6d771d7d429b5bcda2160`, file SHA256 `fadef996818c9e144263794bb8ff39479d526ca5a77ccca0d58795ed5a19cc1b`, preserves the approved release, connection, profile, settings, and budget. It is scheduled before the new batch because V11 has only 11 minutes left. Qualification restarts the engine and does not drain active model jobs; renewals therefore run between disposed cycles. No expiry rule changes. The fresh normal batch uses nonce `4ab484d79eb2bc3a`; no success is claimed before its actual execution.

V12's single request timed out at the client after 180 seconds without a response body, but **the server run passed**. An initial interpretation incorrectly treated an earlier management snapshot and later cleanup as preparation failure. Independent process start times showed that the engine was replaced at `06:11:49 UTC`, during V12. The subsequent full management receipt selects `incus-live-sp01-08-20261004-v12`, reports `qualified=true`, and gives validity through `2026-10-04T07:12:54.605Z`. Receipt `121-SP-v12-management-current.json` SHA256 is `bd3975d2eebc963f5ab245c35b07074b36ca704a44b52330405bd15474e1171c`. The earlier no-handoff and failed-run interpretations are withdrawn; the client timeout record remains unchanged.

Primary DESTROY `c69b0884-f769-4e74-8bdc-ae55f58ca6a4`, unrelated DESTROY `4a1a91bf-5936-4a60-a960-89a30f09bbc9`, and recovery DESTROY `6dfebda6-3d62-4ddb-8cf3-5686e336906d` are SUCCEEDED with ABSENT bindings. Independent instance and backend operation inventories are empty. Their private receipt hashes are `8ebedec80ed1e4289c065b839bc85eadb19362857502bd96ad24111413fffcb4`, `4eb7fa041da3b1f5a327aff2c77c0fc55d80b3864b4f4365158c2a705d39c4b8`, and `2c3d0749339e5c6c15ca26c1473350fedf961350321047fe9b83f011832a511c`. Final stopped-copy reservation accounting remains pending. No normal feature creation had run when these observations were recorded.

A real disconnected HTTP client against the durable runner and controlled witness still produced the correct typed preparation error and cleaned both fixtures; no cleanup escape was reproduced. The compiled route imports its error class and runner from the same chunk. The old response collector's 180-second bound was shorter than the route's independent 20-minute preparation deadline. A reviewed replacement collects one request's private response for up to 30 minutes, with an exclusive durable marker and no retry. This collection fix does not change server deadlines, qualification expiry, or production behavior.

Source `e7e005206ebeca30d25807929a736f3b12d2451a` passed the fast local gate: 27,410 backend tests across 1,782 files, 3,638 web Bun tests, 7,724 component/server tests, types, lint, Svelte checks, integrity checks, and production build. It differs from installed d2de80a8a only in tests. Final same-head browser coverage, merged coverage, and hosted CI remain pending.

V13 plan digest `6cb4fb0d423b52e98874699616aa3633053e980ecfeb2329f8bfb94ce8b54f83`, file SHA256 `f9082db92b013b53539de24d0b802e7a66b13cd08db1d3bc48997287107a4eb7`, retains the same approved scope and budget. One Apply matched READY. V12's four local control projects and two inert bindings were removed through the supported API; its run and guest operation receipts remain. The new collector SHA256 is `373f0580d8f820729b686a1078e590c9b4b53d72d5bb13ee85d516fcbc11d726`; concrete input SHA256 is `a48e75eb2881718dd41ea794836fd5c50b36e8c316f8171bfefa8a693200a2fc`. Its single request captured HTTP 503, `qualification_unavailable`, because the host witness readiness check refused it. Exact fixture status and independent backend reads confirm no V13 guest allocation. This redundant attempt followed the stale V12 interpretation; it is not a V12 failure or qualification pass.

Both live readiness verifier commands pass with exact output in 20 ms and 35 ms. Filesystem metadata and environment checks pass. Source review found a separate deterministic budget mismatch (a five-second client versus two sequential five-second verifier budgets) and a retained supervisor claim that blocks later readiness even after successful continuation. The timing mismatch is reproduced without a wall-clock assertion; it is not asserted as V13's cause. A fix must release only a matching durable terminal claim with verified cleanup, preserve active-run and replay protections, and keep database access inside the engine. Work is in progress. The normal UI/native vertical slice can use successful V12 qualification; the final ten-cycle batch waits for a fixed candidate.

## October 4 normal UI create with a valid receipt

After V13's unused controls were removed, the fresh browser flow admitted CREATE `ade854fa-2857-42b8-a21e-06fc04b29310` with HTTP 202. Project `incus-project-9000f04eb6f091909de2dc4c549f4ec16d418223c62cb71a`, binding `31cc88eb-28a6-4627-9750-28c24e339f12`, and create key `d08f7fb8-5581-4db8-a237-dda6fbca6882` remain fixed. The same operation changed from PROVIDER_PENDING to SUCCEEDED through reconciliation. Independent Incus readback confirms stopped owned guest `ezh-30b37c2d0f1a5730593017a9f40af7e6`, matching the binding, connection, create receipt, and generation. No START or CREATE replay occurred.

The browser artifact stopped after admission and before its first recorded readback. Its private receipt SHA256 is `788f3e691dea82f0021d2d9a639df621ccaf56b47f03702e604da7617a19935f`; it retained the operation DTO but not the complete response body. An offline regression reproduces rejection of the real initial binding shape, desired STOPPED/observed UNKNOWN with the exact pending CREATE, by the artifact's readback validator. Admission already permits PROVIDER_PENDING and will remain unchanged. The correction permits bounded read-only polling of that exact admitted operation while preserving scope, terminal-state, and OUTCOME_UNKNOWN checks. A guarded continuation will start this existing sandbox through the UI; it will not replace the CREATE or claim that the original incomplete artifact passed.

The repaired proof archive SHA256 is `94580c666d67899eef9f0d60ec8ca138b2ad5399c434c5d2da30184d149cac75`. It passes 25 Bun tests with 160 assertions, strict type checks, and an actual Node Playwright worker test. The latter verifies exact-byte receipt hashing with Bun absent. Independent review confirms that the portable hash and timer preserve the admission, scope, timeout, and unknown-effect rules. Its resume path requires the immutable failed receipt hash, original operation and request keys, matching current source, and a fresh successful CREATE readback before one normal UI START. It cannot replay preparation or CREATE. Root reviewed concrete config SHA256 `f9c86cf37e75b8a79c997873530690a19499231a6a3803f8f1aa6d1333735b41`; live execution remains separately evidenced.

The guarded continuation passed in 31.9 seconds. START `7f95c7cd-c0cc-4a70-acf0-b8473b1329b6` settled SUCCEEDED with the same binding RUNNING. Open chat entered the correct project. Private completed receipt SHA256 is `dc0bfefd66a753f4e9f161c6661a52beca58f5a790becfa5864ad8733ce93aa5`; root independently checked its original incomplete-receipt link and sole new START request, and visually inspected both screenshots. The initial CREATE attempt remains incomplete in its original artifact. This proves management CREATE/START/chat entry, not native development work.

Before inference, actual UID/GID 1000 guest checks found Python and Docker/Compose available, but no Git. The current image builder installs Python and the Docker firewall dependencies, not Git. Sudo requires a password; no permission change or package installation was made. The published image deliberately has an empty Docker cache, so the absent pinned BusyBox test image is a per-guest fixture prerequisite rather than a shared-cache defect. Native development proof is held while the Git image recipe is corrected; no test administrator will patch this guest merely to pass the proof.

The terminal supervisor correction is integrated as `b88660c56`, reviewed from `a408bbbc70104f57f9ce6f701411ced01a353646`. Only the managed engine can attest to a signed, durable terminal run with all three exact fixtures cleaned, successful current deletes, released reservations, and no unsettled operations. The supervisor retains run and fault replay fences. Failed-state persistence must succeed before release. Readiness uses a 12-second budget for two sequential five-second verifier calls; restart acknowledgment remains five seconds. Fifty-three focused Bun tests with 396 assertions, 14 actual Python supervisor tests, full types, lint, hooks, and independent review pass. The real managed-client test completes a second distinct restart handoff in the same supervisor without a manual reset. Focused coverage and installed proof remain pending.

Focused coverage for that correction passes all 77 changed measured lines, with full touched-function coverage and no measured complexity above 30. The focused producer does not cover several unchanged feature-service and witness paths, so it is not a complete per-file gate. Installed validation remains pending.

The first actual native conversation is `787033df-8505-40e0-a7d5-cf3e79439d0b`, on the existing running feature. Normal saved API records prove nine successful tool calls: shell directory creation, file creation/editing, reads of the proof and guest canary, grep, glob, and listFiles. Independent guest observation confirms the edited content and exact guest canary; the AMD canary's hash, inode, size, and timestamp are unchanged. Saved messages SHA256 is `3083dd9e4daf35f8fa326bada81367cff307646fc9d52740da66453b43e4a3ed`; independent readback SHA256 is `fcc88e20bab177dc304093def958014609c1630f49cfff5398ec470997f14d5a`.

The partial driver denied tool call `12c5e539-b524-4db0-96b9-dceaacb281f2`: the model omitted one trailing newline from the approved Python source. The code otherwise matched. This is a proof allowlist mismatch, not a transport error. Run `cfe67b3a-f4ed-43eb-b01e-7573c415e15c` then became terminal; both Python files remain absent. The original partial receipt stays incomplete. A separately reviewed continuation archive `39765bcd0cd71b03a6676a69d419b857d9a2d62f8b069a3ce4143a24b2532d0e` allows only that optional final newline for the two known fixtures. It requires the original receipt, terminal run, unchanged successful prefix, denied call, and independent absence proof before one remaining message in the same conversation. It cannot replay the completed work. Python tests, Git, Compose, retention, and the ten-cycle claim remain unproven at this point.

The Git recipe correction is integrated as `d8b7889d8`, with temporary builder resource bounds in `110ba5c9e`. The exact signed Debian package and normal-user local smoke are recorded in [the candidate evidence](2026-10-04-incus-git-image-candidate.md). All 33 setup tests pass with 323 assertions; changed TypeScript validation lines are covered. The legacy recipe validator has diagnostic complexity 70 and is outside the existing complexity enforcement scope; no gate was changed. Builder SHA256 `fd7ba0631037ec37cbac9e1e42b5c906db511b2c8b42e836b506f7466d9a0246` and unpublished recipe SHA256 `f7ac880c52c494b30b4ae9e6fe1ebec10556a2cc09cc10667a0c4aa0e50f0374` pass independent review. The exact build packet SHA256 is `73f183651ec5dc8e32658d2e9ebc3d8f220c96d4e281dd7090930715c6ef8958`; it creates only a bounded temporary builder and a new image alias, preserving the current guest and old images. Publication, provider release approval, image-bound host policy review, setup, and fresh qualification are separate remaining steps.

The single bounded image build passed. New fingerprint `ebe5ce977a726130fd1aa90d2c853467bb6d143141ed07f74b7a06e98efd3912` is published as `ezharness-guest-0-1-3`. The builder ran the exact package and UID/GID 1000 Git checks before publication. Temporary guest `ezh-build-1791099062-2312744` is absent; backend operations are empty. Old image aliases and immutable fields, pool and network configuration, and the existing running user guest are preserved. Private result SHA256 is `231dd078823b5c29951896cd8c42260c119fdddbb1ed2f543cb7c3460c16f77a`; build log SHA256 is `6dcec87a0233c92f6adc89c8f50fd4909ef441e8e26f4119be9d410a8fa3b8de`. No new provider activation occurred.

The partial native continuation also passed. It used the same conversation and one new run, `fecd2006-ecae-4087-b2fc-0c746756addb`, with only the remaining three tool calls. The complete continuation receipt SHA256 is `9551bfb25482ef8955d5126ae50fa06c5c04d64373c6619028d7249b47a16673`. It keeps the original denied call and links the unchanged incomplete receipt. Independent guest code/test hashes match the approved fixtures without the optional final newline; positive, zero, and negative Python tests pass as UID 1000. The AMD canary's hash and metadata remain unchanged. Independent receipt SHA256 is `195193ddea991eb0001eb1e1350f4d9d1d782f44f9fe046ad694f27e62154ab3`. This closes the partial workspace-tools proof, not Git, Compose, lifecycle retention, ten cycles, or all of G5.

Reviewed source `2dbc7fba3` prepares provider 0.1.3 and canonical recipe 1.2.3 for the new exact image; recipe SHA256 is `f260fc92d4aa477422ecea5fba66a6c4f1494f9df79fd55c4c52a34a5bffcff8`. Helper, base, Python, Docker, Compose, capabilities, and permission scope remain unchanged. Extension tests pass 24 cases with 344 assertions, conformance passes eight with 24 assertions, and types, lint, hooks, and source-lock checks pass. Exact human release review remains required. The existing release cannot select another image through connection settings: its preset pins the image digest. The current guest must be drained before activation; the new release-bound connection, image-bound host policies, and qualification must then be established through the existing review flow.

## Verified 0.1.3 candidate and guarded host update

The first sealed build failed because its manifest test read the repository-only
recipe. Commit `47341ea65` keeps package assertions inside the extension and moves
recipe parity to the existing setup suite. An actual copied-package subprocess
checks this boundary. Revision 2 remains failed. New revision 3 passed all six
checks; candidate release and exact approval scope are recorded in the
[0.1.3 review packet](2026-10-04-isolated-incus-release-0.1.3-review.md).

Commit `65b636696` prevents provider activation while dependent sandboxes,
unresolved operations, or reserved resources remain. It checks before migration
preparation and again while holding the installation lock. The same predicate
protects retired connection identity reuse. Twenty-nine real database tests,
all 25 changed measured lines, and independent review passed. The separate mock
browser test in `d9401c9d7` passed Chromium and proves visible refusal guidance,
unchanged active release/generation, and one activation request. Live activation
refusal is still pending; mock UI evidence does not establish it.

The source-65 bundle passed inventory verification and non-root health 200;
manifest SHA256 is `ca749d392f571bb0f77dda5c11209bc264dc44d7450db33423715a17ab4f3da7`.
The guarded installer SHA256 is
`ad5d6f57ec70250237341c09fe25773b490ca62a58a07b5c027f769967d4a041`.
Root checked its constant-only change from the previous installer. It preserves
the database, current guest, previous bundles, and forward-only startup rules.
Installation began only after all native jobs and extension builds were terminal.

The broad fast gate passed type checks, lint, boundaries, integrity, visual-spec,
source-lock, route, both web test lanes, Svelte, and production build. Backend
results were 27,414 passed and one failed. That failure was an incomplete
miniature test database after sharing the drain predicate. Test-only correction
`9dcefa6ae` restored the required columns and reservation table; root independently
ran its 19 cases with 99 assertions successfully. This is not yet a green full
gate or final same-source coverage result.

All six guarded update steps passed. The installed source and manifest match
the staged bundle. Health returned 200 behind the unchanged ingress hold;
management and independent Incus readback still show the same running guest,
host generation 1, provider generation 2, and successful original START.
Pending approval `58e2b991-5170-4f74-850e-c3e678506782` was created through the
normal review API for the exact 0.1.3 candidate. No approval decision or
activation has been submitted.

The stopped pre-update database baseline was copied into a separate disposable
audit directory. The audit never opened the live database or immutable baseline.
V11/V12's six fixtures and the earlier disposed diagnostic binding are all
ABSENT, tombstoned, cleanup-confirmed, and released for both compute and disk.
All 28 selected operations succeeded; there are no global pending operations.
Only retained binding `31cc88eb-28a6-4627-9750-28c24e339f12` is running and
reserved. Root independently checked these assertions. Derived receipt SHA256
is `ffd255c9617cd4d0a4d23ffdce4366c21351f0ebe3a2f9ad76515b5bbe0ab89c`.

Post-update retention receipt SHA256
`eec4831d0c6b9a37673ef919b9c71f358d46a2ddab2c5ba263207929b12b49ba`
confirms the same guest boot ID, four unchanged file hashes read as UID 1000,
unchanged AMD canary hash and metadata, and all 13 saved tool calls in the same
conversation. Root checked the receipt against earlier evidence. This proves
partial workspace and transcript retention across this guarded app update;
it does not prove full native Git/Compose retention or cancelled-job retention.

The next fast run passed all other lanes but reported 27,415 backend passes and
one Podman disk-worker failure. A later controlled comparison exposed a test
confound: allocating a 20 MiB write buffer can exhaust the separate 128 MiB
worker memory limit before filling the 8 MiB tmpfs. Test-only `fb2e43ae5` uses
bounded 1 MiB writes and asserts exact ENOSPC, written bytes, and kernel capacity.
No resource ceiling, deadline, or separate memory test changed. The entire real
Podman file passed twice with 11 tests and 62 assertions; types, lint, hooks, and
review passed. This demonstrates and corrects the confound without claiming the
unrecorded historical worker exit was certainly an OOM. The earlier failed gate
remains failed; final same-head gates remain pending.

## Delayed human approval correction

At 13:36 UTC, the user approved the exact 0.1.3 review packet. Fresh app,
release, guest, file, canary, and idle-job checks passed. The normal approval
API then returned HTTP 400 `INVALID_QUALIFICATION`: the saved build report's
validity ended at 09:01 UTC. Approval remained pending; no activation or cleanup
ran. The failed response remains recorded.

The defect was `checkApproval()` applying current expiry to immutable build
evidence before activation could obtain fresh evidence. Commit `c2aa96415`
uses the existing integrity mode for that saved report. Digest, scope,
timestamp structure, future timestamps, and required passing cases remain
checked. New builds, fresh activation verification, and configured live
qualification still use current-time validity. No stored report, release
digest, approval scope, or provider source was changed.

Twenty focused database/contract tests passed with 137 assertions, including
a five-hour review delay and six fresh-evidence denial cases that preserve the
old active release. The browser human-approval flow, types, lint, hooks, and
changed-line coverage passed. Independent review approved the exact fix.
The earlier source `958b77a30` also passed the entire fast gate on its first
run: 27,416 backend, 3,638 web Bun, and 7,724 Vitest tests. This older-head gate
is kept distinct from the new fix's focused proof and the final release gates.

The new bundle is source `c2aa964158003da409d71c1117e789d55b70eac0`, manifest
`bce14c5c60ed004e7bce085d1e94fb239862364c399a474b9455d597ac65bde8`.
Inventory verification and non-root health 200 passed. Root reviewed the
constants-only forward installer
`c05b9134b49ad4eb73e808c1960dc2754bcc8535aec7324fbc2e89762d868808`
and authorized its guarded execution. The existing user approval remains valid
for the unchanged provider candidate; no repeated release approval is needed.

All six update steps passed, with exact installed `c2aa96415` source and `bce14c5c`
manifest readback. The fresh approval/candidate and retained-guest checks passed.
One normal approval request returned 200/approved. One activation attempt returned
terminal failure `provider_not_drained`, operation
`b5b007a4-6cfe-4e15-bd6b-03cb9b52c37f`. This proves the installed drain guard
refuses replacement before cleanup. The requests and responses were saved;
there was no repeated activation or substitute release.

## Diagnostic cleanup and proof-script corrections

Fresh app and server readback confirmed the old release, generation 3, and
retained running guest were unchanged after the refusal. The sanitized receipt
SHA-256 is `f6b659d2610c185b00acf14edd411393cbbaa1e97c44d1c127fcb01156239081`.
The cleanup config preserves all historical source and evidence pins. Its only
changes from the reviewed post-update config are the installed source, manifest,
and fresh preflight path; its SHA-256 is
`c5761df30b9c411cddf5d6303d1e694b13b0908cb710e2c8b660c69f8212445c`.

The first cleanup browser attempt stopped before an attempt marker or API effect:
its receipt validator required a private cookie-file path deliberately omitted
from saved evidence. Diagnostic archive
`cb3914d7d10dc18fa5e858212cea80eb64f7276e96bd5ff7c47b40a297039f05`
reconstructs a receipt-only placeholder inside pure validation. Live execution
still requires its real private login file. Twenty-five tests, 157 assertions,
strict types, independent review, and an offline replay of the exact saved
CREATE, partial-tool, export, config, and canary inputs passed. The failed
attempt remains preserved. This is diagnostic cleanup, with no full-cycle credit.

Preflight of the later native supplement found a second proof-script mismatch:
the base fixture allowed one omitted final newline, while the supplement assumed
canonical file hashes. The reproduced failure is fixed in archive
`8b45b78fb61a3535bc479b62a23c7e62a3dc603dc8fb0cdf35db81e8fe57891a`.
It derives expected hashes from one successful, strictly validated saved edit per
Python file and requires the fresh saved tool feed to match those bytes. The
independent guest observer and exact hash comparison remain unchanged. Eighteen
tests, 107 assertions, types, build, and independent review pass. Four additional
denial checks pass. This artifact has not yet run on the new live guest.

The corrected diagnostic UI run passed once. STOP
`35b82945-c365-47bb-a133-7aafa067a5f0` and DESTROY
`d7bc140c-cb58-4931-831e-cd4b83f5db80` both settled as `SUCCEEDED`.
Binding `31cc88eb-28a6-4627-9750-28c24e339f12` is `ABSENT/ABSENT`,
tombstoned, and cleanup-confirmed. Independent all-project Incus inventory is
empty. The complete diagnostic receipt SHA-256 is
`a0be1c32bfb5e0a9b40a4fb3373b2c12b694d8b8fd3579c53ea70c87e8572aa1`;
root checked the saved IDs, two requests, terminal state, classification, and
disposed UI screenshot. This remains diagnostic-only, with no full-cycle credit.
The activation drain guard must also confirm released reservations. A separate
explicit accounting readback will use a stopped database copy at the next
required verifier-configuration restart, never an independent live database reader.

Activation after cleanup succeeded once through the normal API: operation
`4e6ca150-b321-4ec4-a627-4d503655d685`, state `active`, no diagnostics.
The collector expected the wrong terminal label (`completed`) and exited 1
after saving the successful response. No activation was repeated. Independent
app inspection confirms release `1fd0e129-f000-4b68-8f4a-7720a3101346`
active at generation 4 and approval `58e2b991-5170-4f74-850e-c3e678506782`
consumed for the original reviewed digest. Root checked both saved responses:
activation SHA-256 `32a9934735320b82ba106e693d563f8d257eb5344d6158773ce868dc5206dff6`,
inspection SHA-256 `70441601689bba09420dd4dca6d06b2c37130a035235d96c00c98673f72a4152`.
The production drain guard passed before replacement. New connection planning
and its exact server policy review remain separate from this completed approval.

The reviewed same-bundle stop/copy/restart procedure
`840b490c3ad60ac247570ac3b1610e9f8624ccd7cd054d8d42f1f39facea976e`
then passed. With the app stopped and no database holders, it made and verified
an immutable current baseline and restarted the same app healthy behind the hold.
Only a distinct disposable clone was opened for accounting. Receipt SHA-256
`3569ebe23b94925758540cd5cd57c620cc3ca1c5c241a46a3b8321a27e69f171`
proves the exact diagnostic binding absent and cleanup-confirmed, compute and
disk reservations both `RELEASED`, no global pending operations, and no
unreleased reservations. Root checked the receipt. The new setup remains
planned with no approval; no server policy was changed.

## Stable setup review and replacement connection

Production-generator reproduction showed that a 1 MiB change in sampled free
disk space invalidated setup review even when all commands and capacity checks
were unchanged. Correction `74cedcf3970e8d416a43f5b17afc7241f885e89f` removes
only this volatile sample from the setup review fingerprint. Fresh capacity
checks still run; insufficient capacity blocks export and Apply, with zero
runner commands. Host, image, certificate, and resource changes still invalidate
review. Fifty-five focused tests, types, lint, and independent review passed.

The corrected isolated app is installed with manifest
`487d2f724006d7dad7180f0e1081258549c4cd10deaf94b2d9ed222ad09008f1`.
Normal Plan generated setup `129bf7e6-9037-4f52-a09b-6b4b5a112ef4`,
connection `5ee601f8-b0f2-46d5-b65c-0250e66edd28`, revision 1, digest
`263ddc5bf0a699675773bd97bc49d6d65bfd5669f5cb3c16dbf5e657e856f926`.
Its 15 steps exactly match the prior plan. The prior unapproved plan and all
receipts remain preserved. The replacement is ready, unapproved, and unapplied.

Private verifier files were generated with the production resolver from a
disposable stopped-database copy. They bind the new connection and active release
generation 4; credential bytes match the existing credentials. The server policy
procedure passed 15 offline tests and independent review. The combined
[connection review](2026-10-04-incus-0.1.3-connection-review.md) is being completed
with the guarded AMD refresh and capacity step. No new server policy is installed.

The final combined procedure is reviewed. Frozen server archive
`e15ef84ec6ca4b6c44cee82aaccd5376430cb3348bff1849c255818395dcf7c1`
passed eighteen offline tests and independent review. Exact AMD refresh/restore
`53091fdb29abff726df1d50578ce38fc2e73dc214cce90949ad33b0c57e1f7a7`
passed nine independently rerun tests. Root verified the archive pins and
script hash. The new server plan, temporary/final policies, capacity Apply, and
AMD refresh await the separate human review reserved by the release packet.

## Approved combined connection execution

The user approved the combined work on 4 October: “approve the work do with
sub agent sol team”. Root rechecked the exact approved packet SHA-256
`3abf0e0e99f83ae200fb5c5f027b3ff20a30d517369ce68f18ddd332b5d9371d`.
The packet is immutable. One Sol agent owns live execution; another verifies
saved results independently. The remaining agents prepare native workflow
evidence and final gates. Execution results will be recorded below; approval
alone does not close the setup or full-workflow gates.

The normal setup approval and official policy export succeeded once. The
exported policy hash is
`4db4e44ddf6728359ddc8d64a9fb7c8a6f6ea6773bf3e35dae15b38df3929349`;
its canonical permissions match `9e79c6c9...`. Its write window is exactly
15:57:57.035–16:12:57.035 UTC. Initial staging stopped before a policy effect
because the engine file was mode 0600 rather than required 0700. Exact file
mode correction, fresh byte checks, and fresh old-policy controls passed.
The original error is preserved. The same attempt then armed rollback and
installed its exact temporary policy.

Independent review of the saved normal API responses confirms setup
`129bf7e6...` is `verified`, with no failures. All 15 existing-resource steps
were skipped successfully; no Incus resource write was needed. Setup Apply,
capacity Plan, capacity Apply, and capacity GET each returned HTTP 200. The
capacity receipt binds the exact reviewed release, generation, connection,
revision, budget, and safety reserve. Its plan digest is
`98461a0c009470ee30d416c045682c708e191a72bc94e5d98e47a6f8a17bcdc9`,
applied at 16:01:38.468 UTC before expiry at 16:11:33.778 UTC. Final policy,
inventory comparison, and AMD refresh results remain separate checks.

## Combined setup milestone passed

The frozen offline comparison helper failed before producing a result because
its hash reader also tried to parse Python files as JSON. The failure was
preserved. A separate read-only correction hashes raw helper bytes, parses only
JSON inputs, and retains every original artifact and manifest check. It uses
the same installed production fingerprint function. Correction SHA-256
`3ed624243721814579c23b27644f5ba94bcff8ad1017bcc6ff12d1799880361f`
passed regression tests and independent review. A separate producer sidecar
records its actual hash and the failed original producer; the original packet,
config, and armed state were not changed.

Before and after inventories have zero guests and equal normalized fingerprint
`4db05cfdac73013e19a0e7841d324118999eda6f20837916f656a2a249f0e50f`.
The independent reviewer recomputed this with the installed production helper.
The final read-only policy is installed and confirmed. All eight final controls
passed, including denial of the former temporary authority, wrong scopes,
extra fields, shell access, and forwarding. The original rollback timer is
inactive after confirmation; it was not reset or rearmed.

Saved evidence under `/root/ezh-qualification-stage/oct04-policy-capacity-approved`:

| Receipt | SHA-256 |
| --- | --- |
| `setup-verified.json` | `d905667bee1b5e5d1bb44ed46e3f40f21ed589564b4ab7a066c44bebf2a0b8a2` |
| `capacity-verified.json` | `668339515d4b806df5d59f30eb52501ac56529bb10bf008dd14598778a40c520` |
| `inventory-comparison.json` | `97d14d86d9a9785e00abb60a3b1c037400917c360258d5fee0435636e6caee2e` |
| `inventory-comparison.json.producer.json` | `926c2b173a4c78769ed5be0d7fb40d0f97ab130e558ab12a15255226e6fc1b75` |
| `new-controls.json` | `0e51982b246ccadc5009e408d1f0c0cfe4db13847e9b57c3534203ccd1e5403e` |
| `completed.json` | `53308b322ad6ece10b682db252908109a0bdc5848a00882bbbf716ae2637d813` |
| `server-final-readback.json` | `775b104aa1d28fac836a6ad942c3361645b4494cb2530f44e2d72d47d7dcb06a` |

Root checked these receipts and hashes. Independent review closed the exact
setup/capacity/policy milestone. The approved AMD refresh then exited zero once:
the new verifier wiring is installed, the same app is healthy behind the hold,
and the old config is retained. Fresh connection qualification and the full
native workflow remain separate live gates.

The first normal probe returned `helper_version_unverified` before any fixture
allocation. Source review confirmed this is the expected pre-qualification
refusal: the normal provider probe receives guest claims only from a matching,
unexpired qualification. It does not establish an image/helper mismatch.
The separate qualification bootstrap checks current release, connection, and
published-image pins without requiring an earlier qualification. No source or
policy change was needed. Normal fixture Plan then returned HTTP 200 for
`incus-live-sp01-08-20261004-git-v1`, digest
`70adb3d4a59bee450205cee3e7df6c45e57ed5df6ba938d8547028ae0d1c3492`.
The normal probe must be repeated after qualification passes.

AMD post-update receipt
`07-amd-postapply-sanitized.json`, SHA-256
`a0bdaccde9b4198081f7d8c3dc11674391ad20dec608ffd804187aeeff7603d1`,
confirms current manifest `487d2f72...`, supervisor config `0883f155...`, both
services active, database device/inode `66306/65145597`, and the ingress hold.
Root checked the saved metadata without opening the database.

The new qualification fixture Apply reached `READY`. One qualification request
then returned HTTP 409 `qualification_operation_preserved`, preserving operation
`069a01c0-83e0-42ca-9efa-8e8e65b4340f` as `OUTCOME_UNKNOWN`. The collector
completed its transport successfully; this is not a qualification pass. The
independent reviewer confirmed one request, zero retries, and no new qualified
profile or expiry. Backend read-only inventory found one owned, stopped primary
guest `ezh-a51a9153641e7cb3d3d7880a9c64c4d3` using image `ebe5ce97...` and
connection `5ee601f8...`. The guest remains retained. No cleanup or recovery
is claimed. A guarded stopped snapshot and disposable-clone journal audit are
used to diagnose the exact saved operation; no new CREATE is sent.

The disposable-copy audit identifies `069a01c0...` as START. Its native receipt
is `incus-setPower-182045d2-7795-4fdb-81de-faf6c6a744c3`; a read-only native
lookup returns 404. CREATE `009c7ac3...` is recorded as successful in the host
journal. Current guest state is stopped, PID zero, with no recorded start time.
Volume metadata and the image exist, but rootfs readiness is not proved. A
daemon `statfs` warning mentions a missing rootfs path; it does not establish
the cause of the failed start. Both compute and disk reservations remain held.
The complete sanitized copied snapshot SHA-256 is
`571a63e38a85c3bdce9c1f8c7558bacb9cb6d41a64d64769e456cdd049858695`.

Code investigation found a concrete async lifecycle race. CREATE discarded its
native operation ID and could report success from a visible stopped instance
before asynchronous volume creation completed. PATCH also lacked a completion
barrier before the power request. A composed test through the real database,
controller, dispatcher, broker, adapter, and transport reproduces premature
CREATE success while native CREATE is still running. Focused tests reproduce
both missing barriers. This proves code defects, not the unrecoverable historic
native error. Fixes must preserve terminal native results and remain compatible
with the frozen 4.0 provider contract.

Incus documents background operation IDs and a wait endpoint. Its maintainer
also documents a five-second retention window after an operation reaches a
final state. This supports immediate bounded capture of terminal results;
later polling cannot guarantee recovery of a discarded failure. See the
[official REST API](https://linuxcontainers.org/incus/docs/main/rest-api/) and
[maintainer explanation](https://discuss.linuxcontainers.org/t/creating-new-instance-over-rest-api/22812).

The current recovery path also has no way to close an unknown START whose
requested running state is not observed after its native receipt disappears.
The original record must remain uncertain. A separate signed, fenced cleanup
path is being implemented to admit one normal-broker DESTROY, retain the original
history, and release reservations only after confirmed absence. No recovery
or backend power request has been executed during this investigation.

The setup guidance defect was reproduced in the browser and corrected in
`f5e5c8ac8` (worker `c120315a5`): the page now directs capacity, qualification,
then probe. Four operator-setup browser tests, type checks, lint, and hooks
passed. This change is local; the installed app still uses source `74cedcf397`.

The first lifecycle correction is integrated as `08dba2940`, with shared
controller settlement in `2edd93c5f` and its typing correction in `552c947f2`.
It saves native operation IDs before waiting, waits for intent PATCH completion
before dispatching power, and saves captured terminal results before returning
through the worker. The shared controller transaction checks the exact current
binding, journal, generation, payload, and native ID. It does not release a
reservation on native failure.

An independent review passed. On the combined branch, Bun 1.3.14 passed 20
controller tests (112 assertions), 36 lifecycle tests (411 assertions), and
13 dispatcher tests (61 assertions). The lifecycle tests include actual child
worker termination at both the accepted-ID and terminal-failure checkpoints.
The new optional terminal receipt requires host contract 4.1; frozen 4.0
schema equivalence and legacy cleanup remain tested. The unbuilt provider
source is version 0.1.4, with the same image and helper. It is not activated.

Release remains blocked on long-operation observation as well as cleanup.
The normal reconciler's 30-second interval can miss Incus's five-second
terminal receipt window after the first bounded call ends. Host-owned bounded
observation is being added. Intent PATCH success must never be reported as
power success. Unknown effects remain preserved; no blind retry is allowed.
