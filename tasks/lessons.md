# Lessons

- Describe a raw entrypoint subprocess as a process, not an installed immutable release.
- In asynchronous delivery tests, await an observed operation or use transport ordering. Do not use a fixed sleep as proof of completion.
- When proving that asynchronous work did not happen, capture and await every operation started by the trigger. Waiting only for the expected positive callback cannot prove the denied phase is complete.
- A denied-path test needs a controlled fault that removes the protection and makes the test fail.

## Validation discipline

- Select gpt-5.6-sol explicitly with fresh bounded briefs when the user requests a Sol team. Use distinct ownership and worktrees.
- Match each new team to the model requested for that task; a previous Sol request does not override a later Terra request.
- Read exact lifecycle and CI commands before selecting tests. A passing subset does not prove a full lane.
- Match pinned Bun and required Node versions. First-install proof requires a new worktree with no dependencies.
- Inspect screenshots and test assertions, not only pass counts or artifact existence.
- Wait for builds to finish before starting another process that writes generated output. Serialize heavy commands with the shared lock.
- Use follow-up tasks to wake an idle agent. A message alone does not resume completed work.
- Reopen only affected validation when the base or source changes, and keep exact revision receipts.
- Preserve live-event E2E transitions when adding saved-state hydration coverage.
- Capture each tested command's exit. A later successful shell command must not mask failure.
- Fetch the base before completion and compare hosted results to the actual PR head.
- Check whether incoming commits track ignored local task files before merging. Preserve both local and incoming lessons.
- When screenshot evidence covers navigation removal, assert both the navigation item and the displayed page change. A hidden tab does not prove stale content was removed.
- When invalidation makes an active route unavailable, reuse its existing reload and error path. Automatic fallback navigation adds empty-list and unmount races unless the product requires it.
- Put the pinned Bun directory first in PATH for commit hooks as well as tests. A hook warning under the system Bun is not authoritative evidence.
- Validate production-image dependencies by importing them inside the built container. Source-string assertions mirror implementation and do not prove runtime packaging.
- Fully qualify every external Dockerfile image reference so unattended Podman builds cannot stop at a short-name prompt.
- Prefix an explicit Bun test path with `./`; without it, Bun treats a nested path as a name filter and runs nothing.
- Calculate the complete private Unix-socket path used by a subprocess. A test-owned socket root must stay short even when a coverage wrapper exports a nested `TMPDIR`.
- A seccomp probe must use the production sandbox context and the expected filter file descriptor. Decode the compiled filter and inspect rule counts before inferring which syscall action caused a process exit.
- In zsh, do not assign to the special `path` array. Use a task-specific variable name so commands remain available through `PATH`.
- Match the required image format before certifying a production build. Inspect build warnings and the resulting health-check configuration; a successful boot verifier does not prove packaging preserved it.
- A gated security test must run the production context and descriptor plumbing, and assert child exit and observed effect before checking audit records. Opening a filter file proves neither attachment nor enforcement.
- Verify parser cursor claims with actual compiled output before changing production code. An expected denied call must agree with the declared profile; a permitted call cannot prove a deny boundary.
- A package-level test wrapper must delegate to the canonical test-set selector. Duplicating filename suffix rules lets the two entrypoints drift and can run Vitest APIs under Bun.
- When a focused coverage command uses `set -u` in a login shell, the system logout hook can replace a successful test exit. Avoid the login shell or capture and return the command status outside that hook.
- Check an agent’s live state before assigning the next check. A message to a completed agent does not restart work; use a follow-up task and verify that it is running.
- Run the pinned secret scan after final evidence edits. Name commit-hash fields explicitly; an ambiguous API field can trigger a false positive. Correct the metadata instead of adding a scanner exception.
- Check all user triggers before calling a flow absent. A missing dedicated button does not rule out chat mentions, direct actions, or another supported path.
- A visible input marker is not proof of extension execution. Assert a transformed result in the output area and verify the real invocation succeeds.
- Before adding a test-only status endpoint, check whether an existing idempotent operation already returns the required terminal state.
- Do not amend a commit after another worktree has reviewed or merged its SHA. Add a new commit so integration history stays stable.
- An HTTP 200 lifecycle response can contain a failed operation. Check the operation state and diagnostics before reading installation state.
- Verify both a floating panel and its trigger against the viewport bounds. Document scroll width does not detect clipped overlays or overflowing toolbar controls.
- Inspect final screenshots before building the final image. A green browser test can miss a visible layout defect.
- Do not release a retained extension name to make a fresh installation pass. Check name-keyed secrets, hooks, and permissions, and distinguish a new installation from an explicit restore operation.
- Generated extension tests must exercise actual code. A placeholder assertion is not valid build evidence.
- Wait for the resulting UI state, not a fixed number of resolved promises or an element that was already present before the action.
- When changing a client request contract, search every browser fixture that overrides the old endpoint. Run the canonical visual selection as well as the standard mock lane; their test sets differ.
- A fake-timer heartbeat test proves enqueue timing, not the life of a real HTTP stream. Reproduce connection errors through the built server and browser, and verify the repair against the production image.
- Inspect the server adapter's exposed platform API before changing global server settings. Long-lived authenticated streams should use the available per-request timeout control.
- Click the exposed part of a backdrop as a user would. A forced click at its center can hit the panel it surrounds and produce a false drawer failure.
- Compare request-start and event times before calling a response stale. A fresh response with old fixture data is a mock persistence defect; it must not justify weakening authoritative replacement.
- Order live client updates with a local sequence. Server timestamps cannot safely define a browser request boundary.
- Store archive filenames and their SHA-256 values in separate named fields. Auth-related filenames used as JSON keys can make the secret scanner misread checksum values as credentials.

- For a binary kernel interface, verify the producer framing before writing a loader; do not infer a header from a byte dump. In single-quoted shell heredocs, use C `\n` only when it must become one backslash-n escape in source.
- Bound each owned VM command with an explicit timeout and kill grace. For a no-row control, await every delegated persistence promise before the database assertion; a fixed delay is not proof.
- When a parent explicitly says to hold a heavyweight validation run pending a source change, re-check messages immediately before launch. If the run has already started, terminate only its process group and mark its receipt as non-evidence.
- A deferred callback test must assert that its controlled callback ran with the expected arguments. A downstream state count can stay unchanged when the callback is never invoked.
- Before stopping a queued command, verify its exact current command and absence of children. Do not identify a process from a remembered PID or queue position.

- A terminal operation is not proof of a successful effect. For a file move, assert the successful state, exact destination bytes, and source removal; a failed or blocked proposal must fail the success case.
- A recovered target build does not prove restart health. Inspect every bundled bootstrap operation after restart and require eventual verification; transient runner capacity errors must not leave permanent failed installs.

- Do not use Bun.file(directory).exists() to prove a directory is absent. Assert lstat returns ENOENT; otherwise an existing directory can satisfy the alleged absence check.

- A fake permission engine can hide a host/worker path mismatch and an unanswerable consent prompt. Exercise the actual v4 grant, live projection, and consent branch before calling a filesystem repair complete.

- Store historical container-only TypeScript probes as `.ts.txt` in evidence. A documentation path can still be included by the host TypeScript configuration; check the final curated tree before reporting static checks green.

- Record the actual receipt directory from the launched command. A planned timestamp is not the command’s output path. Do not modify a test file while any active controller can load it; use the shared lock for controlled source faults and restore exact bytes before releasing it.

- One captured request does not prove two failure events belong to the same request. Compare actual trace identities and start times before suppressing a duplicate. A request outside the capture window may still fail later.

- In `lsof` output for the shared lock, `3rW` identifies the holder and `3r` identifies a waiter. Verify the mode, current children, and actual receipt before claiming a run started or changing queue order. A persistent tool session can still be waiting for the lock.

- A nonempty snapshot file can still be writing. Wait for an explicit completion marker after the awaited write, validate its byte count, and retain the test exit separately from snapshot collection.
- A planned duration is not observed duration. Record the selected mode and configuration before launch, then reject a final receipt that does not meet the required elapsed time.

- Label byte measurements exactly: use decimal MB only for `/1_000_000` and MiB only for `/1_048_576`; retain the original byte value in evidence.
- A hash receipt proves identity only if the matching input bytes are retained. Do not describe a baseline source as preserved when only its hash, result, or snapshot remains.
- With `set -u`, never reference a variable in the same `local` declaration that initializes it. Declare dependent locals first, then assign them on separate lines; run `bash -n` and inspect the function before handing off a controller.

- A sourced validation guard that returns nonzero does not stop a shell with only `set -uo pipefail`. Explicitly propagate its failure and prove the whole wrapper stops before launching tools; testing the helper alone is insufficient.
- `set -u` does not stop a failed command. Stage controllers that rely on a guard must use `set -e` or explicitly propagate the guard status, and test rejection before any runtime command can execute.
- A rejection probe that supports a delivery claim is evidence. Keep its logs and exit records in a named private receipt; do not clean it before the parent can inspect the path.

- In fault-injection drivers, attempt cleanup and evidence capture after the primary failure, then report all failures. Never throw from `finally` and hide the event that caused the failure.

- Before calling a validation interrupted, re-read its terminal exit files and current log tail after the process ends. A missing old PID or earlier partial output is not a failure verdict. Record UTC times and preserve actual terminal files; never rerun a completed passing suite based only on a stale process observation.

- Before force-staging ignored evidence, inspect its publication scope and recursively scan nested archives. Raw browser reports can contain live test tokens in traces or inline attachments. Keep those reports private and publish safe logs, images, and identity metadata. Check remote history before claiming that a scan caught data before publication.

- A web-only check does not cover backend test types. For a new backend test, run the canonical command and verify all four type-check sections.
- Do not call a reconstructed evidence script the exact executed source. Check syntax, replay into a separate owned directory, and compare every output before making a provenance claim.

- `git rev-list --objects BASE..HEAD` retains blobs reachable from commits in the range even when a later commit deletes their paths. Use explicit diff-tree path mapping for provenance; do not claim the object walk necessarily misses deleted blobs.
- A function invoked in a conditional can continue after a failed intermediate command despite `set -e`. Return after each cleanup observation, and use a controlled leftover-resource case to prove the terminal predicate fails.
- Before a helper writes a receipt, create its required receipt directory explicitly. Treat temporary snapshot creation and blob materialization as preflight steps with explicit failure propagation; do not rely on later scan failures to expose them.

- Measure actual archive expansion before choosing a scan bound. Coverage bundles can contain many large repeated members and hardlinks despite small compressed sizes. Validate hardlinks within the same archive and reject a byte-limit breach before copying.
- A streaming archive reader must consume the producer before requiring its successful exit. Returning after one member can close the pipe early and cause SIGPIPE; collect the result, drain the stream, then check the process exit.

- When merging a large main change, compare resolved exports and test-lane membership against both parents. Removing conflict markers does not prove that v4 permissions, browser engines or blocking checks survived. Apply the incoming delta from the common base instead of replacing a branch-owned registry with main’s older whole file.

- When merging browser configuration, preserve shutdown signals as well as test selection. A passing browser run can still lose fixture cleanup when the runner replaces graceful termination with SIGKILL. Verify temporary roots after each direct engine run.

- A successful app-log collection command does not prove clean app logs. Parse the collected file and make its health result a separate blocking receipt; inspect plain dependency warnings as well as structured error levels.
- Do not infer a cache backend from a generic dependency warning. Check runtime flags, trace the actual request, and compare default options with per-call options before changing global configuration.
- Validate embedded languages with their actual parser. `bash -n` does not catch an invalid AWK program. Test valid, missing, duplicate, malformed and nonzero records before launching a long controller.

- For host-side /proc descriptor checks, match both app and verifier user/group credentials. Follow CI’s dynamic id -g contract; a hard-coded group can fail ptrace access even when the user IDs match. Keep cache-ownership proof and descriptor-observer identities explicit.

- Treat a complete persisted resource series and its console projection as separate artifacts. Check every sample from the complete file, compare any observed prefix exactly, and retain an unexplained output limit without inventing a cause. Test that a bad unprinted sample still fails review.

- Check archive signatures as well as filenames when scanning evidence. Keep classification reads bounded, reject unsupported compression, and prove the actual scanner detects a synthetic token in the expanded member. Treat exact raw log whitespace separately from authored source.

- Retain the first pooled test failure before any recovery or retry. A successful retry cannot establish the cause of discarded assertion output.
- Test child readiness through the required executable identity, and wait for actual child close when cleanup must drain its streams. Attach rejection handlers when waits start, before another awaited operation can fail.
- A pull-request image can carry GitHub’s synthetic merge commit. Verify its parents and exact tree against the PR head before treating different commit labels as different source.

- Capture the entire PIPESTATUS array in one assignment immediately after a pipeline. Reading one element first resets the array. Prove producer failure, collector failure, and combined failure before using the wrapper for evidence.

- When validation finds a tool failure, bound diagnosis and compare one supported repair early. Do not spend repeated cycles on symbols, receipt curation, or unchanged broad suites. Reuse source-matched passing evidence and give the user a clear next decision.

- State explicitly when E2E checks use the Playwright test runner. Keep the actual user journey visible in updates; browser-engine and CI diagnosis must not obscure which product flows were exercised.

- Parallelize independent reviews and hosted CI jobs. Schedule local builds, browser runs, coverage, and scans under one shared lock; check available RAM and swap activity before increasing local concurrency. More agents must not mean more heavy local processes.

- Releasing a stream reader lock does not cancel its pipe. Preserve an explicit byte-overflow flag, confirm an exact-limit read against EOF, and cancel overflow before awaiting the child exit.

- Reproduce each CI failure with the smallest matching local check before another push. Run affected tests and types first; reuse passing evidence for unchanged source. Use hosted CI to confirm the repair, and do not wait for unrelated jobs to diagnose a known failure.

- A failed policy check still needs a concrete repair analysis. Check whether test locations, lost assertions and coverage obligations can be repaired before treating every finding as an approval-only outcome. Never substitute a bypass or artificial assertions for restored coverage.

- A test move needs an inventory of original test bodies and all explicit coverage producers. Passing glob discovery does not prove that a named coverage leg follows the move. Preserve each authority and rejection branch before removing the old file.
- On Linux, matching /proc/<pid>/exe does not prove that cmdline is populated. A live process with an empty readable cmdline is indeterminate during exec; keep the database guard conservative and wait for arguments before asserting a non-runtime PID is stale.
- Store private authentication review metadata under the existing masked agent directory. A metadata filename can match a credential-path guard even when the JSON contains no credential. Keep the guard unchanged.

## Extension activation regression

- A healthy server and sign-in page do not prove extension activation. After a deployment or container change, open an existing persisted installation and verify its immutable source and release files are readable through the real review/enable journey.

- Verify a fresh dev image through Vite: Bun source exports alone do not satisfy the standard import exports. Build the trusted workspace packages in the image, then test a container replacement with persisted extension records.

- Validate coverage with the actual merged producer reports and unchanged gate. A focused V8 report can omit a catch line that a Bun producer measures as zero, so a passing focused hit count alone does not prove patch coverage. Cover the behavior in the producing suite and replay the merge locally.

## 2026-09-09 — Test review build isolation

- Run production builds, `bun run typecheck`, and `web` checks in sequence within one checkout. Both type-check commands run SvelteKit sync and write `.svelte-kit`. Overlap can give the browser different server and client build identifiers. Read command side effects before parallel execution.

## Test gap planning isolation — 2026-09-09

- Check whether planning files are tracked before creating task records. This repository has historical root PLAN.md and GATES.md files. Keep new task plans under tasks/testing-gaps/ and use explicit gate-file arguments so old task gates are neither overwritten nor treated as current requirements.
- Removing a typecheck exclusion list is incomplete if the gate still accepts its former baseline. Make the committed exclusion arrays required-empty and prove a former valid entry fails before the compiler starts.

- When editing from a shell call, set its working directory to the repository root. Use a separate call for web commands; do not mix root-relative edit paths with a web working directory.
- Keep a required E2E spec at its manifest path when replacing a skipped body. The lane manifest is a tested contract; move the real body into the existing file instead of creating a second path.

## 2026-09-09 — Provider-error coverage

- A failover test that writes context state directly does not cover the event bridge that supplies it. For each newly persisted bridge field, emit the real terminal event in a direct bridge test and assert the field before relying on end-to-end coverage.
- A transport isolation probe must fail closed. Its spy may count an unexpected call, but must never forward it to the original transport.

## 2026-09-09 — Coverage receipt accuracy

- Read pass, failure, and skip counts from the complete runner summary. Do not infer passes by subtracting failures from collected tests: skipped tests are separate.
- Keyboard model selection follows visible group order, not fixture insertion order. Assert the selected label and choose a reasoning model explicitly before testing its thinking control.
- Cancelling Playwright can leave its preview child bound to the private port. Check the listener and working directory, stop only that owned process, then rerun. A port collision is not a product failure.

## 2026-09-09 — Coverage record integrity

- An LCOV `SF:` header is not evidence. A source producer guard must require at least one syntactically valid `DA:<positive-line>,<nonnegative-hit>` record before it treats a source as measured. Test empty, malformed, and valid records separately.
- Do not infer executable source coverage from a generated source-map point alone. Validate mapping semantics against the established V8-to-Istanbul path or retain a negative control that makes a mapped but unexecuted source line remain `DA:0`.
- When a test passes a fetch implementation as `typeof fetch`, preserve Bun's `preconnect` member with an exact helper; a plain async function type-checks too weakly even when it runs correctly.
- For adapter-copied browser assets, resolve Vite map `sources` against `.svelte-kit/output/client`, not the adapter's `build/client` copy path.

## 2026-09-10 — Coverage worker limits
- `scripts/test-coverage.sh` default host pool can exceed the authorized backend worker cap. Record its actual concurrency as evidence, and pass `PARALLEL=3` for every later focused/backend coverage run unless the coordinator explicitly changes the limit.

## 2026-09-10 — Canonical producer identity
- A blank LCOV `TN:` is not producer evidence. Canonical sources must require a unique producer tag and preserve it through both merge stages; prove blank and other trusted-producer tags cannot supply that source.

## 2026-09-10 — Execution receipts and bounded scheduling

- Confirm each selected test path exists before invoking a runner. A multi-file command can ignore an unmatched filter while its other files pass. Record the exact collected count; use `./` for Bun test paths outside its default search root.
- A `wait -n` scheduler must not count unregistered children. Include every child in its capacity accounting or run the independent child after the tracked pool drains.
- A preview reuse config starts a new preview from existing production assets. It needs a verified build, not an already running server. Use a private port and rebuild after application source changes.
- A browser test with no application scripts is a valid checkpoint. Retain and count it, but require the final same-build aggregate to contain real DA records for every expected route and canonical browser source.
## 2026-09-09 — Picker reopening

- When a picker closes on a delayed blur, test immediate native reopen with fake-timer advancement beyond the prior deadline. A browser assertion alone can miss a timing race or hide it behind a fixed wait.
- Clear delayed picker-close callbacks at unmount, and keep both the selection callback and native outside-close behavior in the regression.

## 2026-09-10 — Live source and process identity

- Read the current manifest and its CI consumer before requesting lane changes. Historical checkpoint summaries can describe removed lanes. Existing source is authoritative; do not add overlapping lanes to solve stale checkout findings.
- Do not stop only a flock wrapper to cancel a queued test: it can acquire the lock and start its child between inspection and termination. Serialize builds and preview runs in the same checkout from the start.

## 2026-09-10 — Gate-integrity assertions
- Do not add duplicate `expect` calls merely to satisfy a static gate. First inspect the called local helper. If it contains the behavior assertion, make the gate recognize only that local, assertionful call path and add opaque-helper and declaration-only negative controls. For a test-gutting finding, restore a distinct user action and its result.
- A local helper's assertion is evidence only inside its parsed lexical body and only along an invoked call path. Never approximate a body with the next declaration: statements after an empty helper, or a never-called nested function, must remain vacuous.
- File-scope assertion helpers must resolve through their actual lexical binding. A nested declaration or a parameter/local binding with the same name must never make another call assertionful.
- Check a shadow declaration before skipping its nested function body. Resolve enclosing suite scopes too; when a static scan cannot prove the binding, it must reject the helper path.
## 2026-09-10 — Session-history refresh fixtures

- A mocked message POST must retain the client `parentMessageId`. Otherwise a completion refetch can correctly render a new root branch while a test falsely calls it a full-thread refresh. Capture the actual POST response and run ID, persist that returned user message, and assert every earlier turn plus the new reply after reconciliation.
- Do not apply a lint auto-fix when it changes a constructible function into an arrow. Tests may instantiate it with `new`; keep a named constructor and run the affected browser flows. Do not narrow a public `Promise<T | void>` contract to satisfy a lint rule when existing `Promise<void>` implementations rely on it.

## 2026-09-10 — Browser Worker aliases

- Page-level CDP coverage does not prove code that runs only inside a browser Worker. For a literal Node-module alias, use a direct contract producer that asserts the public shape, stamp it with a unique TN, and require its own exact floor.

- Do not place Vitest fixtures in a `bun test` batch. Their hoisted mocks require Vitest, while canonical backend coverage isolates Bun test files because module mocks leak across a shared process.

## 2026-09-10 — Integration review and active runners

- Do not edit a script, fixture, or generated build while its runner is active. A shell can resume reading at an old offset after an edit and execute broken text. Commit and align each checkout before the run, then retain that exact source until it exits.
- Get the authoritative revision from the parent checkout. A peer worktree or old summary can contain already-fixed skips. Exclude comments when counting test skips, and inspect the actual executable call.
- For retry tests, assert a successful response and new visible data. A timed error toast is separate state; its continued display does not prove that the retry failed.
- Review every lint auto-fix, including all fake constructors, and remove unused pure declarations instead of hiding them with underscore names.
- Preserve parent-path order when adding audit annotations to chat. Sort or merge only independent annotations, deduplicate IDs, and test inverted timestamps and branch isolation.

- Large validation JSON files should remain linted. Use an exact-file size-limit override instead of excluding the files; measure the added lint cost. Keep historical skipped suite declarations unchanged when only documenting their executable replacements, so diff-scoped integrity checks do not misclassify them as new skips.
