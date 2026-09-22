# Resume pluggable infrastructure

## Start here

The local native EZHarness MVP is implemented. Finish PR validation before starting the next infrastructure milestone. The full external-infrastructure roadmap is not complete.

- PR: [#292](https://github.com/ezcorp-org/EZHarness/pull/292).
- Branch: `feat/pluggable-infrastructure`.
- Local worktree: `/home/dev/work/EZCorp/EZHarness-worktrees/pluggable-infrastructure`.
- [Completed MVP task record and deferred backlog](../../tasks/pluggable-infrastructure.md).
- [Validation report, screenshots, and receipt digests](../validation/pluggable-local-mvp.md).
- [Original plan and scope decisions](2026-09-20-pluggable-infrastructure-tasks.md), especially section 11.
- [Local provider configuration](../../extensions/local-sandbox/README.md) and [tested image recipe](../../scripts/pluggable-infrastructure/README.md).

## Accepted scope

Native EZHarness only. One retained offline sandbox workspace at a time, using a dedicated project and persisted binding. All seven native tools use that binding. Files, bounded logs, cancellation, graceful application restart, browser reconnect, and explicit disposal are supported. Sandbox failures cannot fall back to host files or processes. Existing provider review and approval remain required.

Claude/Codex guest workers were removed by the user. Do not restore them as optional backlog items. All R4 features remain deferred. No external AMD/Xeon host, Incus service, or Infisical deployment has been provisioned. The original PRD/prototype was not available; the supplied plan and recorded user decisions are the working input.

## Last observed PR state

Checked on 21 September 2026 UTC at head `939a10a05b57224eef83dc2421cf676776e72c68`, which merges current `main` into the MVP branch. The PR is open, has no merge conflict, and requires review. This is a snapshot; refresh the status when resuming.

Known blocker: the **Visual evidence** job failed because `web/src/lib/components/FeatureIndex.svelte` changed, but its mapped evidence spec, `web/e2e/feature-index-scan.spec.ts`, did not change. [Failure log](https://github.com/ezcorp-org/EZHarness/actions/runs/35550159154/job/106183433642).

Dependency audit, manifest-lock drift, and gate integrity had passed. Other checks were queued or running. Do not treat that partial result as all CI green.

## First work on resume

- [ ] Refresh PR head, checks, and reviews. Preserve any local edits and other agents' changes.
- [ ] Fix the FeatureIndex visual-evidence gap with a meaningful browser assertion and screenshot for the affected behavior. Update the existing mapped spec, or add a genuinely covering spec and its mapping. Do not use a token edit or bypass label to make the gate pass.
- [ ] Run `BASE_REF=origin/main bun scripts/check-visual-evidence.ts` and the affected Playwright scenario. Inspect its screenshots.
- [ ] Complete validation on the updated branch and fix any remaining CI failures. Obtain the required non-author review before merge; no merge is claimed by this handoff.

Useful read-only status commands:

```sh
git status --short
git fetch origin main feat/pluggable-infrastructure
gh pr view 292 --repo ezcorp-org/EZHarness
gh pr checks 292 --repo ezcorp-org/EZHarness
```

Use the Bun version pinned by the repository (1.3.14 at handoff). The pinned local executable used for qualification is `/tmp/bun-pinned/bin/bun`; that machine-local path may not survive cleanup. After incorporating upstream dependency changes, run frozen-lockfile installs in the root and `web/`. Use the canonical test wrappers documented in `AGENTS.md` and `docs/development-lifecycle.md`.

## Validation already retained

- Full browser/coverage candidate: `0d74fc4418c3124f9ebd73cc280dcef7f78a365a`. Passed 26,652 host/package coverage tests, 7,450 web Vitest tests, and 2,187 browser cases. All 32 new source files and every changed executable line across 52 files were covered. Static checks, production build, and gate integrity passed.
- Live local application proof: `8ea169e057b55f4428fa6a72b782d5e9cfe725cd`, production-identical to that coverage candidate. Only model responses were scripted; provider review, worker execution, authorization, database, runtime, tools, filesystem, and cleanup were real.
- The later merge of `main` changes production code and dependencies. The earlier evidence remains valid for its named revisions; it does not certify the merged head.
- Local raw evidence: `tasks/evidence/pluggable-final-third/`, `pluggable-real-final/`, `pluggable-local/`, and `pluggable-disposal-recovery/`. Raw files are ignored and do not travel with a clone. The tracked validation report retains safe screenshots and receipt digests.
- On this machine only, private host configuration is `/var/tmp/ezharness-mvp-qualification-yvf3qju_/host.json`. Do not copy its contents into Git or messages. The configuration and state are local test resources, not provisioned remote infrastructure. Use a fresh isolated test database for another live qualification.

For another full browser/coverage run, freeze all tracked files for the entire run, use a new evidence directory, and retain the exact browser build before coverage verification. Receipts bind to the source revision. Do not re-label an old receipt after a source change. Serialize heavy local checks with `/tmp/ezcorp-validation-heavy.lock` and do not stop unrelated jobs.

## Work deferred beyond the MVP

| Area | Remaining work |
| --- | --- |
| External host milestone | Provision one approved host; design scoped transport, host identity, network policy, and connection records; repeat the same lifecycle and tool workflow against it. |
| Incus and portability | Implement and qualify the Incus provider and an independent second provider; prove unchanged consumer flows. |
| Secrets | Integrate Infisical and qualify approved credential delivery, cleanup, and recovery. |
| Services and previews | Qualify Compose services, authenticated previews, and the full clone/edit/test/PR workflow. |
| Optional R4 | Dynamic credential leases, large file transfer, snapshots/restore, suspend, interactive terminals, and resource resizing. Each requires a separate scope decision and live qualification. |
| Recovery and operations | Host reboot, general helper crashes, interrupted model-run resumption, existing host-project migration, backup/restore, upgrades, rollback, operator runbooks, and deployment qualification. |

The next planned build is one external-host connection with the existing native EZHarness flow. No remote connection details or secrets should be assumed. Do not expand into the optional features without a new scope decision.
