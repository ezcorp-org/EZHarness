# Pluggable infrastructure execution

Resume guide: [current handoff](../docs/plans/pluggable-infrastructure-resume.md).

Base: origin/main `550b7c67e1116f78f0448f2133f8ad18201fed1d`. Source checkout preserved.

## Plan

- [x] Fetch base and create isolated integration, Sol, and Terra worktrees.
- [x] Complete independent plan audits and record corrections before code.
- [x] Establish initial decisions, shared interfaces, ownership, and checks.
- [x] Implement the local MVP subset: provider contract, persistent binding, actual local sandbox, seven tools, restart/log/cancel/cleanup, minimal user flow.
- [x] Verify full changed-source coverage and canonical build/test lanes.
- [x] Complete real local provider/security/recovery qualification and local evidence.
- External-host networking/deployment: later milestone by user direction.

## Local MVP progress

- [x] Shared v4 provider declarations and canonical sandbox wire contract.
- [x] Persisted routing with no local fallback and explicit conversation principal.
- [x] Reuse all seven native tools in a bounded guest helper; real offline Bun test passed.
- [x] Local provider source uses the normal reviewed extension lifecycle.
- [x] Initial durable lifecycle controller and API/panel implemented; focused tests passed.
- [x] Complete reviewed provider invocation and production startup wiring; focused authorization and startup checks pass.
- [x] Verify real rootless lifecycle cleanup and compiled supervisor process execution.
- [x] Finish file-provider wiring and the persisted native process controller loop; 20 controller cases pass with 350/350 executable lines covered.
- [x] Prove all native tools, cancellation, restart and explicit disposal through the live application.
- [x] Run all build/test/coverage gates and inspect desktop/mobile browser evidence.

## Original roadmap (deferred except MVP subset)

- [ ] P01: Establish the source of truth.
- [ ] P02: Approve scope and threat model.
- [ ] P03: Inventory deployment and access.
- [ ] P04: Set operating policy.
- [ ] C01: Define provider contributions once.
- [ ] C02: Specify sandbox wire semantics.
- [ ] C03: Specify secret wire semantics.
- [ ] C04: Register reviewed providers and connections.
- [ ] C05: Enforce drain and lifecycle rules.
- [ ] C06: Publish shared conformance fixtures.
- [ ] H01: Specify and review infrastructure transport.
- [ ] H02: Implement fresh authority for controller effects.
- [ ] H03: Implement the sensitive result path.
- [ ] H04: Implement protected connection I/O.
- [ ] H05: Close the boundary review.
- [ ] B01: Add durable data and migrations.
- [ ] B02: Implement authorized lifecycle transitions.
- [ ] B03: Implement reservations and queue admission.
- [ ] B04: Implement reconciliation and fencing.
- [ ] B05: Implement durable process control.
- [ ] B06: Implement the workspace writer lease.
- [ ] B07: Add controller health and bounded retry.
- [ ] I01: Provision the restricted backend.
- [ ] I02: Build the pinned guest recipe.
- [ ] I03: Build contained file operations.
- [ ] I04: Build durable guest supervision.
- [ ] I05: Prove actual resource controls.
- [ ] I06: Enforce network separation.
- [ ] I07: Ship the Incus extension.
- [ ] I08: Implement the Compose workload driver.
- [ ] W01: Inventory every project access path.
- [ ] W02: Inject one explicit workspace backend.
- [ ] W03: Route authenticated previews.
- [ ] W04: Bind runs, agents and MCP to the feature.
- [ ] W05: Complete validation and PR flow.
- [ ] W06: Prove disconnect and review workflow.
- [ ] S01: Preserve the existing encrypted store.
- [ ] S02: Add approved credential references.
- [ ] S03: Implement the Infisical static extension.
- [ ] S04: Deliver destination-bound HTTP credentials.
- [ ] S05: Implement approved guest delivery.
- [ ] S06: Reconcile credential cleanup.
- [ ] U01: Build connection/review/preflight UI.
- [ ] U02: Build environment selection and admission status.
- [ ] U03: Build persistent feature/run views.
- [ ] U04: Build cleanup and secret status views.
- [ ] U05: Validate the real UI.
- [ ] O01: Implement safe retention and disposal.
- [ ] O02: Implement backup and disaster recovery.
- [ ] O03: Write and test operator runbooks.
- [ ] O04: Define upgrades and rollback.
- [ ] V01: Build a real independent baseline adapter.
- [ ] V02: Run unchanged baseline consumer flows.
- [ ] V03: Close full Compose portability or obtain an explicit spec amendment.
- [ ] V04: Ship SDK scaffolding and author guide.
- Excluded by user: N01: Qualify Claude Code worker placement.
- Excluded by user: N02: Qualify Codex worker placement.
- [ ] N03: Qualify dynamic leases only with a real issuer.
- [ ] N04: Qualify large file transfer if selected.
- [ ] N05: Qualify snapshot/restore and suspend if selected.
- [ ] N06: Qualify PTY and resize if selected.
- [ ] N07: Track future backend requests without expanding v1.
- [ ] Q01: Build end-to-end qualification fixtures.
- [ ] Q02: Run the negative security suite.
- [ ] Q03: Run resource and concurrency qualification.
- [ ] Q04: Run the failure/recovery matrix.
- [ ] Q05: Run ten consecutive real feature lifecycles.
- [ ] Q06: Pass all repository gates.
- [ ] Q07: Publish the evidence and support matrix.
- [ ] Q08: Roll out and verify the selected release.

## Review

The local provider, reviewed dispatch, durable binding, native tools, process supervision, and minimal settings panel are implemented. The live browser journey passed all seven tools, an actual Bun test inside the sandbox, persisted files, browser disconnect, cancellation, recovery, and disposal. No owned containers or mounts remained.

That journey exposed and fixed provider grant comparison, project-list refresh, HTTP idle timeout, and returned tool-error reporting. Immediate shell and grep completion also revealed retained deadline timers; a shared cleanup helper and real subprocess regressions now prove prompt exit.

The earlier validation findings and repairs are retained here as history. The first complete backend run found 15 failures in five files: an outdated source count, old tool-loop fixtures, missing mock cleanup registration, and host-project policy fixtures. These were repaired without removing security assertions. The next canonical run passed 25,834 backend tests, 3,626 web Bun tests, and all 2,187 browser cases. The eighth live journey also proved graceful application restart, Start/Stop/Open chat, and desktop/mobile layouts. Screenshot review led to a shared disabled-button style fix. The full coverage test producers passed, but the receipt check rejected documentation edits made during the run. Restoring the clean worktree and rebuilding did not reproduce the same browser assets, so that receipt cannot be reused. The production build and gate-integrity check passed. A final audit found and repaired interrupted disposal: durable scoped cleanup records, idempotent filesystem removal, serialized final cleanup, and same-user controller retry now pass 22 driver/workspace tests and 23 controller tests. A real FUSE probe recovered all three partial-removal phases with no mounts or images left. The final live journey at 8ea169e05 passed. The last three coverage gaps were closed with persisted-policy and rejected-dispatch regressions plus the missing web collector entry. The immutable final run at 0d74fc441 passed every gate: 26,652 coverage tests, 7,450 web Vitest tests, 2,187 browser cases, all 32 new source files at 100% measured coverage, all changed executable lines across 52 files, static checks, production build, and gate integrity. Production sources exactly match the live-tested revision. The final report is docs/validation/pluggable-local-mvp.md.

External hosts, Infisical, all R4 features, Compose services, and Claude/Codex guest workers remain outside this MVP.

---
