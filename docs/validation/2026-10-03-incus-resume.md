# Incus completion work — 3 October 2026

Status: in progress. This record does not close the live release gates.

## Confirmed state

- EZHarness worktree head: `7a251ed01`, branch `feat/pluggable-infrastructure-v1`. PR #303 still has head `18e46a7c8`.
- SSH to `dev@sandbox-server.taile1c5b0.ts.net` works with the existing personal key and normal host-key checks. Local TCP sockets and GitHub access work.
- The original guest `ezh-3706fb480a240548bcf13974451b200d` is running in Incus project `ezharness`. No active Incus operation was reported. No replacement CREATE or START was sent.
- AMD has no loaded qualification supervisor or runner unit. Port 4301 is closed. The current NixOS source omits the qualification module. The journal records both services stopping on 30 September.
- The saved app bundle manifest still hashes to `e6295213f653cb89a33881f1f609c97f93255e4305e0db8c05e28738c927d6b6`. The runner artifact remains present. The exact ingress hold check passes.
- The current database remains at `/var/lib/ezharness-qual-data/pglite`. Its owner, mode, and device match the saved configuration. A scoped open-file check found no database holder; the excluded portal mount was separately verified. The current database must be preserved, not replaced with a September backup.

At 14:37:55 UTC, detached database readback confirmed CREATE `ca4d3c6b-de37-4d2a-ba00-8a243fe3124d` and START `9b7b0246-e9ef-4b6d-b899-78f9d975c39a` are both `SUCCEEDED`. The binding remains `RUNNING/RUNNING`, with the same connection, profile, and START operation and no tombstone. Its 4 GiB / 2 CPU / 1,024 PID / 20 GiB reservation remains reserved. Connection revision 1 is not revoked. The detached copy matched the source by a checksum comparison before it was opened; source and copy have distinct inodes, and the source had no open holder.

The later app inspection previously returned `smoke_unavailable`. Marker, Compose, reconnect, and cleanup have not yet passed for this fixture.

## Checks completed

- Pinned Bun: 1.3.14.
- Release bundle staging tests: 15 passed.
- Host live-witness tests: 14 passed, 84 assertions.
- Six focused management browser tests passed before the additional recovery journeys. These use real authentication and a fresh database with mocked Incus responses; they do not prove live provider behavior.
- The expanded management suite passed all 11 journeys. Review then identified two request counters that did not observe their overridden routes; those assertions are being strengthened before integration.
- The restricted fast run passed lint, typecheck, gate integrity, visual-evidence checks, Svelte checks, and 3,645 web tests. Its backend result was 26,992 passed and 44 failed. A reproduced container failure was a denied Podman runtime write under the session filesystem sandbox. This was not a passing gate.

The first unrestricted fast rerun stopped during backend tests when the session permissions changed. It has no final verdict. A fresh unrestricted run is recorded in `.cache/incus-oct03-fast-final.log`; its result must be checked before publication.

## Diagnostic app bundle

Staging a clean checkout of `7a251ed01ecb1872817f34272ade258fb3fed85e` completed successfully at `/tmp/ezh-qualification-release-7a251ed01-oct03` with 76,139 manifest file entries. The manifest SHA-256 is `e9fefa291ea5cef52164156b719bcdd8e72724694e255722c2bc1a7c5c116aa5`. The pinned Bun binary SHA-256 is `9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74`.

The bundle's non-root startup smoke passed as UID 1001 with HTTP health status 200, using the candidate host's GCC runtime `/nix/store/j7qx4s4mr17j1wqgvqdzj33lmrnzb387-gcc-16.2.0-lib/lib`. Verification also passed after shutdown. No root-owned install or live app start has occurred yet. This smoke proves bundle startup with disposable state, not the live Incus workflow.

## Active work and constraints

The missing-service cause is now traced: the earlier NixOS module and recovery dependency fix merged into `feat/ezh-amd-activation-packet`, not `main`. The 30 September switch removed the units, and current generation 322 still omits them. The restoration branch is based on current NixOS `main` (`3914170`) and builds candidate `/nix/store/33gh6nkfwn3k23mqvn4ls48lbw6klg18-nixos-system-nixos-amd-26.11.20260929.b4fd65b`. Module, access, runtime, and flake checks pass. Its closure comparison reports qualification units/checks and Podman added, with no unrelated package replacement. The candidate has not been activated. The source must reach NixOS `main` to keep this repair in future host builds.

1. Restore the qualification module and tests on the current NixOS source. Keep automatic startup disabled. Build and compare the candidate before any activation.
2. Inspect a detached copy of the current database and the current guest to identify the failed inspection invariant. Do not open the source database concurrently or issue a duplicate operation.
3. Complete management browser recovery tests and all five canonical browser coverage lanes on a frozen source commit, then run the merged coverage gates.
4. Resume the original live fixture after service restoration. Complete workload, retention, cleanup, qualification, and native project-tool checks before marking the deployment ready.

Work is split between isolated Sol worktrees for live validation, browser coverage, and the NixOS repair. Only the live worker may operate the isolated app or sandbox server. The parent integrates source and records the final checks.

See [the release gates](../../gates/incus-live-pr303.md) for the full remaining acceptance boundary.
