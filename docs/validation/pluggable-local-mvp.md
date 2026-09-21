# Local EZHarness MVP validation

The local native EZHarness MVP is complete in `feat/pluggable-infrastructure`, in worktree `EZHarness-worktrees/pluggable-infrastructure`. Sol and Terra audited the plan, implemented bounded parts, and reviewed the result.

## Scope and plan corrections

The supplied plan assumed external infrastructure that does not exist. The active milestone was reduced to a local MVP. The review also corrected connection-persistence ordering, secret-delivery dependencies, provider execution ownership, lifecycle state, required workspace routing, and provider versioning. Decisions D25–D31 and the active scope are in [the plan](../plans/2026-09-20-pluggable-infrastructure-tasks.md#11-execution-review--20-september-2026).

Each task gets a dedicated sandbox project with a saved binding. All seven native tools use that binding. A sandbox error denies access; it cannot fall back to host files or processes. The reviewed v4 provider uses host-authorized operations. The settings panel provides create, start, stop, open chat, and dispose. One workspace can be retained, including while stopped; disposal frees the slot.

The rootless local runtime is offline, with a read-only root, dropped capabilities, seccomp, and CPU, memory, PID, and disk limits. A fixed-size filesystem stores workspace data. Guest UID/GID 0 map to the unprivileged host user. Process state, bounded output, cancellation, and files persist. Disposal can safely resume after partial removal.

## Verified results

Final test and coverage candidate: `0d74fc4418c3124f9ebd73cc280dcef7f78a365a`. Base: `550b7c67e1116f78f0448f2133f8ad18201fed1d`.

| Check | Result |
| --- | --- |
| Backend, web, and test type checks; lint | Passed |
| SDK, native tools, supervisor, production build | Passed |
| Browser suites | 2,187 passed across five suites |
| Host/package coverage test summary | 26,652 passed; 0 failed |
| Web Vitest coverage | 7,450 passed across 590 files |
| Per-file coverage gate | All 1,657 enforced files meet their thresholds |
| New source coverage | 32 files; all 1,659 measured executable lines covered |
| Changed-line coverage | Every changed executable line covered across 52 files |
| Gate integrity | Passed; no lowered gates or test bypasses |

The ordinary backend suite passed 25,844 tests and web Bun passed 3,626 at `8ea169e057b55f4428fa6a72b782d5e9cfe725cd`. The real local application journey also passed at that revision. Only two security test additions and one web coverage collector correction followed; the final wrapper proves exact production-source equality. The full browser and coverage runs above use the final candidate itself. All tracked files stayed unchanged throughout that run.

The live journey used real provider review, extension execution, authorization, database, rootless runtime, filesystem, and native tools. Only model responses were scripted. It proved all seven tools, an actual Bun test inside the guest, Start/Stop/Open chat, saved files through graceful application restart, browser disconnect/reconnect, cancellation, tool errors, and explicit disposal. No owned containers or mounts remained across seven recorded resource identities. Four desktop/mobile screenshots were inspected: [active desktop](pluggable-local-mvp/local-sandbox-real-desktop.png), [active mobile](pluggable-local-mvp/local-sandbox-real-mobile.png), [disposed desktop](pluggable-local-mvp/local-sandbox-destroyed-desktop.png), [disposed mobile](pluggable-local-mvp/local-sandbox-destroyed-mobile.png).

Real FUSE checks interrupted disposal after unmount, image removal, and mount-directory removal. Every retry and repeated disposal succeeded without remaining mounts or images. Focused checks passed 22 driver/workspace tests and 23 controller tests.

## Use and limits

Follow the [local provider setup](../../extensions/local-sandbox/README.md) and [tested image recipe](../../scripts/pluggable-infrastructure/README.md). Start the configured app, review and activate the provider, then create a sandbox in project settings.

Claude/Codex guest workers are excluded. All R4 features, external-host networking, Incus, Infisical, second-provider portability, previews, and Compose services are deferred. Graceful application restart is qualified. Host reboot, general helper-crash recovery, automatic resumption of an interrupted model run, and migration of an existing host project are not qualified.

[Receipt digests](pluggable-local-mvp/receipts.json) identify the retained local evidence under `tasks/evidence/`. Raw browser reports remain private. No deployment, push, pull request, or merge was performed.
