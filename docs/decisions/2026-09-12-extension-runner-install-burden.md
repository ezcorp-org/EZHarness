# Decision: the extension runner's install burden, and wiring the built-but-dormant `trusted-local` mode

**Date:** 2026-09-12 · **Status:** Accepted (path C implemented on `feat/trusted-local-runner`; A unchanged; B open) · **Area:** extensions / runner deployment
**Code:** `src/extensions/runner-connection.ts` (`getConfiguredExtensionRunner`),
`packages/@ezcorp/extension-runner/src/podman.ts` (`PodmanRunner`),
`packages/@ezcorp/extension-runner/src/trusted-local.ts` (`TrustedLocalRunner`),
`deploy/extension-runner/` · **Related:** [security.md](../extensions/security.md),
[v4 plan § Trusted fallback](../extension-system-v4-plan.md#trusted-fallback)

## Context

A v4 extension (`city-conditions`, `source: release-v4`) failed on the primary dev box with:

```
Configure an absolute extension runner socket and one valid host credential: token or token file.
```

Root cause was not a bug. `getConfiguredExtensionRunner()` requires `EZCORP_EXTENSION_RUNNER_SOCKET`
plus exactly one of `EZCORP_EXTENSION_RUNNER_TOKEN` / `_TOKEN_FILE`; none were set because the stack
was started from `docker-compose.yml` + `compose.podman.yml` without
`deploy/extension-runner/compose.runner.yml`. The runner — the only thing allowed to create
extension containers — simply was not deployed. That is the documented design: **missing isolation
fails closed** (`src/extensions/CLAUDE.md`, `security.md:7`).

Two things came out of diagnosing it and are recorded here so they are not rediscovered.

## Finding 1 — the app is one command; extensions are eight root-only Linux steps

Installing EZHarness is `docker compose -f compose.prod.yml --env-file .env.prod up -d --build` on
any OS. Running **one** v4 extension additionally requires, per `deploy/extension-runner/README.md`:

1. A Linux host. The runner is Linux-only by construction: `SO_PEERCRED` peer identity
   (`peer-gateway.py:32`), rootless Podman 5 with cgroup v2 delegation, util-linux `setpriv`/`flock`,
   a pinned conmon.
2. A dedicated account with subordinate IDs and lingering.
3. A root-owned copy of the application tree at `/opt/ezharness` (~2.3 GB, 1 GB of it
   `node_modules`) — required because the runner account cannot read a `0700` checkout and
   `provisionToolchain` reads the SDK/TypeScript from the release it trusts.
4. The repository's *pinned* bun at `/opt/ezharness/bin/bun` (1.3.9; nixpkgs ships 1.3.11 and this
   repo treats skew as a defect).
5. A credential file with exact ownership and mode — readable by BOTH the runner and the compose
   user, since compose mounts it as the app's secret.
6. The pinned runtime image pulled *under the runner account* (image stores are per-user;
   execution is `--pull=never`).
7. A systemd user service under that account with `Delegate=yes`.
8. The stack restarted with three compose files and two extra env vars.

Then step 3 again on every application upgrade, or the runner keeps building against the old SDK.

Non-obvious traps hit while doing this once on NixOS, kept here because none of them name
themselves: the socket directory must be **setgid** (the gateway `chmod`s the socket `0660`, so the
app reaches it via group bits it would otherwise not inherit); a flake cannot see an *untracked*
module file; rootless Podman does not carry the host account's supplementary groups into the app
container (`group_add: [keep-groups]` is the Podman fix); the dev container runs as container-root
so its host-visible peer UID is the compose user's (1001 here), not 0 and not 1000.

**Consequence.** The README lists extensions and the marketplace as a headline feature; the quick
start never mentions the runner. A user who installs the app and tries an extension gets the
error above and no pointer to a second install. On macOS/Windows there is no second install to do.
Realistically, few self-hosters will ever run an extension.

## Finding 2 — nested rootless Podman: isolation survives, resource limits silently do not

Tested on the dev box (Podman 5.8.2, cgroup v2) to see whether the runner could ship as a compose
service instead of a host service — which would make it one command on every OS, since Docker/Podman
on macOS and Windows already run a Linux VM.

Outer container `quay.io/podman/stable`, rootless, **no `--privileged`**, no host socket
(`--device /dev/fuse --security-opt seccomp=unconfined --security-opt label=disable --user podman`):

| Check (inner container, the runner's real flag set) | Result |
|---|---|
| Nested container starts at all | ✅ |
| `--user=65534:65534`, `--cap-drop=ALL`, `no-new-privileges`, `--network=none`, `--read-only` | ✅ `uid=65534` |
| `--memory=128m` → `memory.max` | ❌ `max` |
| `--pids-limit=32` → `pids.max` | ❌ `2048` |
| `--cpus=0.5` → `cpu.max` | ❌ `max 100000` |

Cause: `/sys/fs/cgroup` is mounted **read-only** in the outer container
(`ro,nosuid,nodev,noexec … cgroup2`) while all controllers are present (`cpu io memory pids`).
Podman accepts the limit flags and drops them without error. `--systemd=always` did not change it.

The runner would catch this: `PodmanRunner.probeSecurity()` asserts the probe container's
`memory.max`/`cpu.max`/`pids.max` and refuses to start (`isolation_probe_failed`). So a
containerised runner fails **closed**, not open — but it does fail, until the outer container is
given a writable delegated cgroup subtree (the same `Delegate=cpu memory pids` dance
`scripts/lib/extension-runner-delegation.sh` already does for CI). On macOS/Windows the VM is built
and controlled by `podman machine` and runs systemd, so that delegation could plausibly be baked in
by tooling rather than by the user. **Untested; it is the make-or-break question for a drop-in
isolated runner.**

## Finding 3 — the "less secure mode" was designed, built, tested, and never wired

The question "can an env var put the app in a mode where extensions run without the runner?" has a
more precise answer than yes/no: the project already decided how such a mode must look, and shipped
the engine for it.

- `security.md:9` and the v4 plan § Trusted fallback define **`trusted-local`**: an explicit
  admin exception, *not* recovery from a runner failure. Approval is per **exact digest and
  phase** (build / execute), with an approver, an expiry, an audit record, and acknowledgement of the
  omitted controls. It must run under a non-root account and "must never be described as isolated".
  Automatic fallback is forbidden.
- `TrustedLocalRunner extends PodmanRunner` implements exactly that by overriding the three
  protected seams (`trusted-local.ts:29-42`):
  - `probeSecurity` — Linux only, process must run as the configured **non-zero** `dedicatedUid`,
    bun binary must match a pinned digest;
  - `authorize` — `approvalFor(phase, digest)` must return a live approval naming all seven
    `TRUSTED_LOCAL_OMITTED_CONTROLS` (`filesystem-isolation, network-isolation, seccomp,
    cgroup-memory, cgroup-cpu, cgroup-pids, bounded-temporary-storage`), then `audit()` is called;
  - `launch` — `setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all <bun> …` as a plain
    process; no container.
  - Builds are stamped `localhost/trusted-local@sha256:…` so a release built this way is
    distinguishable forever; `packages/@ezcorp/extension-runner/tests/trusted-local.test.ts` proves
    build + execute end to end with the approval and audit hooks.
- **Nothing in `src/` constructs it.** `runner-connection.ts` only ever builds a `RunnerClient`;
  there is no env var, no approval store, no audit sink, no CLI path, and no `EZCORP_*TRUST*`
  variable anywhere. It is a finished engine with no ignition.
- The lifecycle already has the invariants a mode switch needs for free: `runnerProfile` is stamped
  on every approval and release and rechecked at activation (`v4/lifecycle.ts:291` →
  `stale_approval`), so switching the host from `rootless-podman-v4` to a `trusted-local-v4`
  profile invalidates every existing approval and forces a human to re-approve each release under
  the new terms.
- The prod image already satisfies the adapter's preconditions on **every OS**, because the
  container is Linux regardless of the host: `util-linux` (`setpriv`) is installed
  (`Dockerfile:73`) and the app runs non-root as uid 1000 (`Dockerfile:275`, `USER bun`). The dev
  compose stack runs as container-root and would be rejected by `probeSecurity`
  (`dedicatedUid === 0`) — dev would need `user: "1000:1000"` or the prod compose file.

## Proposal

Wire `trusted-local` as the operator-selected **adapter**, and keep trust **per release** in the
existing approval flow. Two keys, neither sufficient alone:

1. **Operator, once, at deploy time — fail-closed, modeled on `isTestSurfaceEnabled()`
   (`src/test-surface.ts`).** Two independent variables, both required, unknown values refuse to
   boot:
   ```
   EZCORP_EXTENSION_RUNNER=trusted-local
   EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers
   ```
   The second is a sentence, not a `1`, so it cannot be set by copying a line from an e2e config.
   Unlike the test surface this must be **allowed** in `NODE_ENV=production` — self-hosters on
   macOS/Windows are the audience — which is why the second key and the per-release approval carry
   the weight instead. `getConfiguredExtensionRunner()` then constructs `TrustedLocalRunner`
   in-process with `dedicatedUid = process.getuid()`, `bunPath = process.execPath`, `bunDigest`
   computed at boot, `approvalFor` backed by the approvals table, `audit` backed by `audit_log`.
   `runnerProfile` becomes `trusted-local-v4`.
2. **User, per release, in the UI.** The activation approval screen shows the seven omitted
   controls and requires an explicit acknowledgement; the approval record gains `approvedBy`,
   `expiresAt`, `omittedControls`. That record *is* `approvalFor()`.

Plus: an error-level startup log, a persistent UI banner ("extensions are NOT sandboxed"), and the
mode exposed on `/health`. In this mode none of the eight steps above exist — no socket, token,
account, `/opt` copy, or NixOS module.

**What this mode protects and does not.** An extension runs as the app's non-root uid with
no-new-privs and all capabilities dropped, inside the app container — it cannot escalate and it is
not on the host. It has the app's **full** reach: database, provider keys, memories, every user's
data, outbound network, unbounded CPU/memory/disk. That is the seven omitted controls, stated plainly
in the UI, approved per release by a human. It is a considered downgrade for a single-tenant
self-hoster who writes or reads the extensions they install; it is not for multi-user deployments.

**Not an env-var-only global switch.** A bare `EZCORP_INSECURE_EXTENSIONS=1` would make every
marketplace download run with those powers silently and forever. The per-digest approval is the
line the v4 plan drew, and `TrustedLocalRunner.authorize` enforces it in code — the wiring should
not bypass it.

## Decision

*Accepted 2026-09-12: ship C.* Implemented as described under Proposal, with these specifics worth
knowing when reading the code: the build-phase approval is written **before** the build operation
exists (and outside the lifecycle's state transaction — a second handle inside it would deadlock
single-connection PGlite), the execute-phase approval **after** the approval decision commits and
only for a yes; approvals live in `extension_trusted_local_approvals` keyed per installation and
expire after 180 days; candidate verification (`verifyExtensionCandidate` starts a worker from the
new artifact — an `execute` the runner gates — before any release approval can exist) runs under the
build acknowledgement, extended to the artifact for a fifteen-minute window with the same approver
(`recordTrustedLocalVerificationApproval`), so the release-phase gate stays a separate human act;
the `dedicatedUid` is the app's own non-root uid (uid 1000 in the image), the
looser reading named below; `trusted-local` mode is refused by the runner under root, so the
root-running dev compose stack needs `user: "1000:1000"` or the prod compose file. Three paths, not
mutually exclusive:

| | Isolation | Setup | OS |
|---|---|---|---|
| **A. Host runner** (today) | full | 8 root steps + re-sync per upgrade | Linux |
| **B. Runner as compose service** | full, *if* nested cgroup delegation is solved | one command | all |
| **C. `trusted-local` wired** (this proposal) | none of the seven controls; non-root, no-new-privs | one env pair + per-release approval | all |

Recommended: ship **C** now as the explicit, loud, per-release-approved escape hatch; keep **A**
the default and the only thing called "isolated"; pursue **B** as the real fix, gated on the
delegation prototype in Finding 2.

## Pros / cons

**Pros of C:** the engine, tests, digest labelling, approval-staleness and audit seams already
exist; makes the headline feature reachable on macOS/Windows; honest about what it omits; per-release
human approval preserved; no host changes at all.

**Cons of C:** a compromised extension is a compromised app (not host); resource exhaustion is
possible; two more UI states to test (the gate demands e2e + `@evidence`); the `dedicatedUid ===
app uid` reading of "dedicated non-root account" is looser than the plan's wording and should be
named in the approval text rather than hidden.

**When to reconsider:** if B's delegation prototype succeeds on `podman machine`, C's audience
shrinks to "no container engine at all" and its default-off should be revisited; if EZHarness ever
targets multi-tenant hosting, C should be refused when more than one user exists.
