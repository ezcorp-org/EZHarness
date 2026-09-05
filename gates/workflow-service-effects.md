# Service workflow effects

- [x] Reproduce approved service workflow tool dispatch through the real workflow executor, tool executor and SQL state.
- [ ] Preserve a distinct service principal; never replace it with the consenting user.
- [ ] Prove valid tool and agent effects, and deny wrong or revoked delegation authority.
- [ ] Run actual rootless service workflow and focused regression tests.

## Checkpoint

`/tmp/lifecycle-service-effects-red.log` reproduces the missing service identity through actual WorkflowExecutor, ToolExecutor, ReleaseProcess and SQL. The runner is not started: the service call is misclassified as ownerless. `/tmp/ez-service-release-real-tool-red.log` independently reproduces the same error through authenticated HTTP and a rootless worker.

The first implementation adds only host-issued branded service proof and transport. The proof retains a null human identity, checks the persisted run and current sealed delegation, and expires at workflow cleanup. Direct proof tests exercise JSON forgery, wrong run/service/delegation/project, revocation, and cleanup while an admission is pending. The module has 100% line coverage. Downstream capability ceilings, agent scope plumbing and actual rootless success remain separate required gates; this checkpoint is not a complete service-effect authorization claim.

Independent review found that initial issuance checks alone did not deny a later durable run cancellation. `/tmp/lifecycle-service-run-revocation-red.log` proves that failure. The corrected proof intrinsically checks the exact execution hash and persisted running identity on every admission, using `FOR SHARE` in the supplied effect transaction and a second read after asynchronous checks outside a transaction. `/tmp/lifecycle-service-run-guard.log`: 12 SQL tests, 44 assertions, 100% proof-module line coverage. TypeScript and scoped lint pass. These tests also deny changed hashes, service/user/delegation identities, and terminalization while a guard is pending.
