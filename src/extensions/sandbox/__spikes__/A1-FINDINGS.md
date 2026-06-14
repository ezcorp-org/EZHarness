# Phase A1 — Landlock spike findings (GO/NO-GO gate)

## VERDICT: **GO**

Landlock restricts the filesystem **in both the host and the live app
containers**. A raw process under the Landlock fs-jail can read its allowed
workspace but is **denied (EACCES)** on a secret file outside the allowlist —
the `.ezcorp/data` leak class. The isolation thesis holds: build Part A.

## How to reproduce

```bash
# Host
bun src/extensions/sandbox/__spikes__/landlock-selftest.ts

# Inside the app container (dev or prod)
docker exec <ctr> mkdir -p /tmp/llspike/sandbox/__spikes__
docker cp src/extensions/sandbox/landlock-ffi.ts        <ctr>:/tmp/llspike/sandbox/
docker cp src/extensions/sandbox/capability-probe.ts    <ctr>:/tmp/llspike/sandbox/
docker cp src/extensions/sandbox/__spikes__/landlock-selftest.ts <ctr>:/tmp/llspike/sandbox/__spikes__/
docker exec <ctr> bun /tmp/llspike/sandbox/__spikes__/landlock-selftest.ts
```

Exit 0 = containment proven. The script applies a read-only Landlock ruleset
allowing only a temp workspace dir (+ runtime system dirs), then asserts an
allowed read succeeds and a read of a secret file in a NON-allowed temp dir
fails with EACCES.

## Evidence captured (2026-06-13)

Updated for the **write-inclusive** jail (the fix-loop correction — the rw
workspace must be WRITABLE, not read-only, or git/file-edits EACCES on the
landlock tier). The self-test now asserts allowed-WRITE + denied-write too:

| Environment        | arch | ABI | tier     | rw read | rw WRITE | data read | data write | verdict   |
| ------------------ | ---- | --- | -------- | ------- | -------- | --------- | ---------- | --------- |
| Host (NixOS 7.0.3) | x64  | 8   | bwrap    | OK      | OK       | EACCES    | EACCES     | CONTAINED |
| ez-corp-ai-app-1   | x64  | 8   | landlock | OK      | OK       | EACCES    | EACCES     | CONTAINED |

Raw self-test JSON (container `ez-corp-ai-app-1`, write-inclusive):

```
LANDLOCK_SELFTEST_JSON {"arch":"x64","landlockAbi":8,"tier":"landlock",
"allowedReadOk":true,"allowedWriteOk":true,"deniedReadBlocked":true,
"deniedWriteBlocked":true,"deniedErrno":"EACCES","verdict":"CONTAINED"}
```

The original read-only proof is superseded: `applyReadWriteJail(rw, ro, abi)`
grants a write-inclusive access subset (WRITE_FILE/MAKE_*/REMOVE_*/TRUNCATE/
REFER, ABI-masked) to rw paths and read/exec only to ro paths; the full write
set stays in the handled mask so ro paths genuinely lose write and ungranted
paths lose everything.

## Why the tier differs host vs container (expected, not a problem)

- **Host** resolves to `bwrap`: `unshare -Ur true` succeeds here (unprivileged
  userns is NOT blocked on this dev box), so the optional bwrap upgrade
  (/proc + PID hiding) is available on top of Landlock.
- **Container** resolves to `landlock`: unprivileged userns is unavailable
  inside Docker, so bwrap can't upgrade — but Landlock alone fully contains
  the fs. This is exactly the scenario the prior bwrap/netns spike failed on,
  and precisely why Landlock was chosen: its syscalls (444/445/446) pass
  Docker's default seccomp profile and need zero namespaces/caps.

## Implementation notes for A2 (`buildSandboxArgv`)

- **FFI is the durable path** (no `landrun` installed anywhere). The 3 Landlock
  syscalls + `prctl(PR_SET_NO_NEW_PRIVS)` are FFI'd via libc `syscall(2)` in
  `landlock-ffi.ts`.
- **Two load-bearing gotchas** (cost real debugging — keep them):
  1. The libc `syscall` FFI binding MUST declare `number + 5` i64 args.
     `landlock_add_rule` takes a trailing `flags` arg and `prctl` needs
     arg2..arg5; a short binding silently drops them and the kernel reads
     garbage registers → **EINVAL (errno 22)**.
  2. `restrict_self` returns **EPERM** unless `prctl(PR_SET_NO_NEW_PRIVS,1)`
     succeeded first. Order: create_ruleset → add_rule(s) → no_new_privs →
     restrict_self.
- **libc path differs per distro**: NixOS host has no bare `libc.so.6` on the
  loader path — `libcCandidates()` derives the real path via `ldd $(bun)`.
  The Debian container resolves `libc.so.6` directly. Both covered.
- **Allowlist granularity matters**: granting a broad parent (e.g. `/tmp`)
  re-exposes anything beneath it. A2's builder must allow the SPECIFIC
  per-run workspace dir, runtime RO dirs, and **never** an ancestor of
  `.ezcorp/data` (reuse `preview-jail.ts`'s `assertOutsideDataDir`).
- **Per-process, not per-argv**: Landlock restricts the calling thread/process,
  so for spawn sites the jail must be applied in the child after fork/exec
  (or via a tiny pre-exec shim). A2/A3 wiring should account for this — unlike
  bwrap (an argv prefix), Landlock is an in-process syscall sequence. A
  hybrid `buildSandboxArgv` can still emit a bwrap prefix on the `bwrap` tier
  and a `landlock` pre-exec shim on the `landlock` tier.
- `/dev/kvm` present on host (microVM upgrade path exists later; not needed now).
- cgroup v2 `subtree_control` writable on host (delegation available).
