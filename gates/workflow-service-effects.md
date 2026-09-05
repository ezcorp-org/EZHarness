# Service workflow effects

- [x] Reproduce approved service workflow tool dispatch through the real workflow executor, tool executor and SQL state.
- [x] Preserve a distinct service principal; never replace it with the consenting user.
- [x] Prove valid tool and agent effects, and deny wrong or revoked delegation authority.
- [ ] Run actual rootless service workflow and focused regression tests.

## Checkpoint

`/tmp/lifecycle-service-effects-red.log` reproduces the missing service identity through actual WorkflowExecutor, ToolExecutor, ReleaseProcess and SQL. The runner is not started: the service call is misclassified as ownerless. `/tmp/ez-service-release-real-tool-red.log` independently reproduces the same error through authenticated HTTP and a rootless worker.

The first implementation adds only host-issued branded service proof and transport. The proof retains a null human identity, checks the persisted run and current sealed delegation, and expires at workflow cleanup. Direct proof tests exercise JSON forgery, wrong run/service/delegation/project, revocation, and cleanup while an admission is pending. The module has 100% line coverage. Downstream capability ceilings, agent scope plumbing and actual rootless success remain separate required gates; this checkpoint is not a complete service-effect authorization claim.

Independent review found that initial issuance checks alone did not deny a later durable run cancellation. `/tmp/lifecycle-service-run-revocation-red.log` proves that failure. The corrected proof intrinsically checks the exact execution hash and persisted running identity on every admission, using `FOR SHARE` in the supplied effect transaction and a second read after asynchronous checks outside a transaction. `/tmp/lifecycle-service-run-guard.log`: 12 SQL tests, 44 assertions, 100% proof-module line coverage. TypeScript and scoped lint pass. These tests also deny changed hashes, service/user/delegation identities, and terminalization while a guard is pending.

## Coherent service checkpoint

The proof now derives its source from the canonical verified delegation origin, not from an assumed extension stamp on the executing workflow. This permits a host workflow or resumed host child without inventing a human principal. Every admission verifies that the origin remains unchanged. Service worker tokens must also carry the host's exact forward capability guard; ReleaseProcess applies it even when no caller option supplies a guard.

`/tmp/lifecycle-service-coherent.log`: 50 tests and 204 assertions pass across service proof, actual workflow tool/agent dispatch, canonical delegation authority and the service capability broker. The resumed YAML child executes its first step, then refuses the next step after parent revocation. Positive tool/agent tests use real SQL and PermissionEngine, require exactly one controlled worker and a nonempty policy trace, and inspect the live null-human service token. The proof module retains 100% line coverage. `/tmp/lifecycle-service-coherent-types.log` is empty; scoped lint passes. Final external PostgreSQL revocation ordering and rootless storage/filesystem checks are still required after the shared source is merged.
