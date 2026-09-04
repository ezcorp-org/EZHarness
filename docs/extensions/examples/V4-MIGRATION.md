# First-party extension migration

All 50 extension sources now use schema version 4 and the SDK control protocol.
This includes the 28 bundled sources, the other reference sources, and ai-kit.
Each source has an `extension.ts` entrypoint. Config modules run inside the
isolated build or runtime, not inside the host registry.

`scripts/migrate-extension-v4.ts` lists or snapshots these sources without
importing their configs. It rejects links, non-text files, ambiguous names,
and size limits. It does not install, approve, or activate an extension.
The lifecycle service must build each snapshot and request human approval.

The migrated metadata declares 194 tools, 10 pages, and 17 skills. Existing
registration APIs use an invocation-scoped SDK adapter. The migration removes
manual transport loops and all runtime imports of host implementation files.

## Intentional changes

- Extension authoring is now a host operation. The old extension exposes only
  `migration_status`; it cannot build, install, or approve code.
- The unused `subAgents` field in the multi-agent reference is now explicit
  agent prompt guidance. The old host did not implement that field.
- Markdown skills use `prompt`; the old `content` field was not consumed.
- Project analysis uses brokered filesystem access, not a shell process.
- Opening a pull request uses the scoped `ezcorp/project.openPr` host operation.
  The child receives neither host paths nor credentials.
- ai-kit uses exact-route host API grants and brokered event polling. It does
  not receive the host API key or access the host network directly.
- Loop and page registrations no longer register the same handler twice.

## Verification

The migration was checked with Bun 1.3.14. All 50 bundled artifacts completed
discovery in rootless Podman with no network, a read-only root, a non-root user,
no capabilities, and memory/process limits. All 160 first-party test files
passed when run separately. The 140 ai-kit unit tests passed. Source snapshot,
host pull request, and API bridge tests also passed.

`scripts/verify-first-party-v4.ts` repeats source collection, bundling, artifact
hashing, and isolated discovery. Set `EXTENSION_RUNNER_IMAGE` to a full local
image digest. This is a reviewed first-party verification command, not the
production build service. Never use it to compile untrusted submissions on the
host. Production builds must use the isolated lifecycle runner.

Discovery proves metadata and handler registration, not every external service
integration. Live GitHub pushes, paid API calls, human approvals, and all page
actions require separate integration coverage. No release is auto-approved.
