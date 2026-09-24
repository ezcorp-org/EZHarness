# Sealed settings preflight — 24 September 2026

Status: **read-only inventory**. No traffic hold, settings capture, service
change, database stage, CREATE repair, or Incus write occurred in this check.
The values below are nonsecret. Recheck every live identity immediately before
use. This packet does not authorize a cutover.

## Current isolated app

| Item | Read-only observation | Use |
| --- | --- | --- |
| Listener | `127.0.0.1:4301`, PID `3878560` | The old Vite app is still live. |
| App process tree | PIDs `3878477`, `3878556`, `3878559`, `3878560`; UID/GID `1001:100` | Refresh all PIDs before stop. |
| Pinned capture process | PID `3878560`, start ticks `28758896`, boot ID `12e34c4a-efb4-4b11-8e95-8b74e262b5b5` | **Time-sensitive.** The settings tool reads this process's actual environment. |
| Runner | PID `1982010`, gateway PID `1983979`; UID/GID `1001:100`; start ticks `22236814` and `22237060` | **Time-sensitive.** Separate from unrelated development runners. |
| Source data | `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`; project root `/tmp/ezh-incus-isolated-app.QMhk6Qhv/projects` | Source parent is `1001:100`, mode `0700`; DB is mode `0755`, projects mode `0700`. |
| Old runner paths | Socket `/tmp/ezh-incus-isolated-app.QMhk6Qhv/runner.sock`; token `/tmp/ezh-incus-isolated-app.QMhk6Qhv/runner.token` | New paths need the dedicated runner account. |
| Old setup path | `dev@sandbox-server.taile1c5b0.ts.net`, `https://sandbox-server:8443`, personal SSH key under `/home/dev/.ssh` | Replace with the reviewed dedicated principal, key, and known-hosts file in the new manifest. |
| Environment shape | All 16 settings-tool source keys present; no extra `EZCORP_` key and no `DATABASE_URL` | Presence check only. Secret values were not read into this packet or printed. |
| Dedicated services | Both `ezharness-qual-runner.service` and `ezharness-qual-supervisor.service` are `not-found` | They must be loaded and inactive for the later UID stage check. |
| Dedicated accounts | `ezharness-qual` and `ezharness-qual-runner` do not exist yet | Proposed UID/GID values `62040`, `62041`, socket GID `62042` are not live accounts. |

The last recorded isolated-app database review reports active provider release
`0.1.2`, release ID `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`, digest
`4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`.
It also reports CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` as
`OUTCOME_UNKNOWN`. These are prior [review-packet observations](./2026-09-24-isolated-app-cutover-ready-review.md),
not a fresh database read. Preserve that CREATE record and re-read the active
release, connection revision, binding, and operation before repair or a new
setup plan. A zero-instance backend list does not clear an unknown effect.

## Root staging inventory

`/root/ezh-qualification-stage` is root-owned mode `0700`. The dedicated
candidate SSH private key is root-owned mode `0600`; its public key has
fingerprint `SHA256:OnzXcp0enZGflnUeycmXGju1C3YafdlELmcw75Z+XrQ`.
The staged gate script SHA-256 is
`016cc5b8573875a12baae4ffeec1642e99d20e72346336c1eb521a420786a1c3`.
The staged read-only policy SHA-256 is
`2733d259eb12b04a13aa816974d3836a8dd52e0a1f07a2b661830de5594995c7`;
its plan digest is
`0a8df5487ec054a1236b2f6e2a9d0905fee534dd5c97eeca734f74e3fff73054`.
The private key bytes were not displayed or copied. Staging does not prove
that the server trusts this key or that its forced command is active.

## Candidate manifest shape

The following is an **intentionally incomplete template** for
[`prepare-qualification-settings.py`](../../scripts/incus/prepare-qualification-settings.py).
`null` fields must be replaced in a root-owned mode `0600` manifest before
running it. No secret belongs in this manifest. The tool requires exactly
these keys and a root-owned mode `0700` empty `stageDir`.

```json
{
  "sourcePid": 3878560,
  "sourceStartTicks": 28758896,
  "sourceBootId": "12e34c4a-efb4-4b11-8e95-8b74e262b5b5",
  "oldUid": 1001,
  "newUid": 62040,
  "runnerUid": 62041,
  "sourceDb": "/tmp/ezh-incus-isolated-app.QMhk6Qhv/db",
  "sourceProjectRoot": "/tmp/ezh-incus-isolated-app.QMhk6Qhv/projects",
  "targetDb": "/var/lib/ezharness-qual-data/pglite",
  "targetProjectRoot": null,
  "stageDir": null,
  "holdReceipt": null,
  "port": 4301,
  "origin": "http://127.0.0.1:4301",
  "publicUrl": "http://127.0.0.1:4301",
  "runnerSocket": "/run/ezharness-qual-runner/runner.sock",
  "runnerTokenRuntime": "/run/ezharness-qual-runner/token",
  "runnerStore": "/var/lib/ezharness-qual-runner/store",
  "supervisorSocket": null,
  "controlProbeRoot": null,
  "qualificationProjectId": null,
  "composeFixtureImageRef": null,
  "setupSshMode": "reviewed-envelope-v1",
  "setupSshTarget": null,
  "setupSshIdentityFile": null,
  "setupSshKnownHostsFile": null,
  "setupSshHostKeySha256": "SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co",
  "setupEndpoint": "https://sandbox-server:8443",
  "setupRecipeFile": null,
  "supervisorPublicKeyFile": null
}
```

The PID, start ticks, boot ID, host key pin, source paths, and port are
**time-sensitive**. The target paths shown are proposed, not confirmed host
configuration. The present personal SSH identity is unsuitable for
`setupSshIdentityFile`. Obtain the server-installed gate principal and the
dedicated app-only key location from the reviewed host generation. Pin a
root-owned mode `0600` canonical Ed25519 **public** PEM for
`supervisorPublicKeyFile`; it was absent from `/etc/ezharness` at this check.
Pin the fixture image by immutable `@sha256:` digest and match the exact
reviewed project, probe, recipe, and supervisor socket paths.

The settings tool requires a root-owned mode `0600` traffic-hold receipt with
exactly `sourcePid`, `sourceStartTicks`, `sourceBootId`, `sourceDb`, and
`trafficHeld: true`. This is an operator assertion; this read-only check did
not make it. During an authorized hold, `prepare --execute` captures the
old process environment and writes five mode `0600` files: old and new app
environments, runner environment, runner token, and a hash-only receipt.
Its `check` verifies their bytes; `check-live-source` must run immediately
before stopping the pinned process. The crypto values remain byte-equal,
`DATABASE_URL` is refused, and no value should enter logs or Git.

[`prepare-dedicated-uid.py`](../../scripts/incus/prepare-dedicated-uid.py)
has a separate exact-key manifest. Its read-only `check` is valid only
**after** the old app and runner stop, their sockets close, the source parent
is sealed as root-owned mode `0700`, the new services are loaded but inactive,
the dedicated users exist with the required groups, and the reviewed runtime
token and supervisor config are in place. The manifest must pin old UID/GID
`1001:100`, new app `62040:62040`, runner UID `62041`, socket GID `62042`,
all old app and runner PIDs, source/quarantine/target/rollback DB paths,
`oldAppUnit: null`, exact new unit names, built entrypoint
`/opt/ezharness/web/build/index.js`, three sealed environment paths,
runner socket/token paths, and supervisor config path. Its `stage --execute`
renames the stopped source and makes verified target and rollback copies;
this inventory did not run either action.

The project root is outside the PGlite directory. The DB stage script does
not transfer it. A reviewed project-tree transfer and reference check are
also needed before the new app starts. The current source parent includes
both trees, so sealing it and transferring projects must be planned together.

## Missing inputs before candidate generation

1. A reviewed, activated server SSH gate; its restricted principal, server
   readback, dedicated key path, and pinned known-hosts file. The root staging
   key alone is insufficient.
2. The reviewed AMD host generation and exact target paths. It must define
   the dedicated users, groups, loaded inactive services, supervisor socket,
   public signing key file, control-probe root, and runner store.
3. The final project-root transfer plan, qualification project ID, pinned
   Compose fixture image, and reviewed setup recipe path.
4. A fresh app PID/start-tick/boot read and a real traffic hold with its
   root-owned receipt. A process restart invalidates the template identity.

Review result: the current old app environment has the expected key shape,
and the candidate scripts have explicit identity and file checks. Sealed
candidate generation remains closed on the listed host and traffic inputs.
