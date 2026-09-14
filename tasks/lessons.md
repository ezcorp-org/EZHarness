# Lessons

- Seal every persisted field that controls a protected decision, including its scope, revision, and approving authority. Recompute the canonical seal before acceptance and before a later effect claim; a semantic source digest alone cannot detect authority or policy-row tampering.

- Keep definition list rows bounded. Persist compact semantic and resource metadata when a bounded source is saved; do not load or compile up to 200 full 16 MiB sources for one list request. Snapshot mutable request input before an authorization await.

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
- A fixed oldest-first pending page can starve healthy work when a corrupt row remains pending. Persist each failed attempt and order unattempted work before the least-recently-attempted retry; prove the `runs: 1` case across repeated drains.
- A resolver that expands a large immutable artifact into JSON can exceed durable request and workflow-history limits. Keep oversized inputs as verified opaque references through the start and activity contracts, and bind media type plus storage version with the digest and byte count.
- Snapshot every public artifact-load identity, reference, and allowed-kind list before the transaction starts. A caller can mutate values while the database waits for a transaction.
- A lazy artifact reader must derive its reference from the durable run parameter by name and compare the caller value exactly. A valid project artifact alone must not become an input substitution capability.
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

## 2026-09-13 — Factory merged SDK validation

- After merging Factory SDK sources, rebuild the pinned root and web dependencies and run the Factory SDK build before interpreting TypeScript export errors. A stale package `dist` can look like a missing source export.
- A live `flock` wrapper with an empty test log is queued, not a hung producer. Mark the log only after lock acquisition and inspect the child PID before terminating a check.

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
- A leading underscore is not a cleanup for a dead declaration. Remove pure unused helpers and constants with their unused imports; retain only bindings that still have a side effect or a structural use.

## 2026-09-10 — Picker component timing proof

- Use fake timers to cross a known dismissal deadline in a component test. Do not use a fixed wall-clock delay when the timer is the behavior under test.
- Describe dispatched component events accurately. Reserve “native interaction” for browser-engine evidence that performs the physical click path.

- Explicitly pass empty storage state and assert no cookies for anonymous browser contexts. A new context can inherit the runner's configured storage state. Do not call a loaded admin page an anonymous access leak before that control passes.
- A mock HTML copy is not application coverage. Render the actual component with controlled loader data, and use a real empty database to test server redirects.
- When adding audit detail, preserve the existing burst volume bound. An allowed capability kind must not accidentally introduce one audit key per file path. Keep deny evidence complete.
## 2026-09-10 — Shared-style coverage

- Do not duplicate a shared style constant to satisfy V8 coverage. A source-mapped branch from Svelte's defensive generated `?? ''` fallback is not an executable product branch when the imported constant is typed and defined. Keep the import, test real event payloads, and report the generated mapping to the coverage owner.


## 2026-09-10 — Completed browser write journeys

- A captured write request proves only dispatch. For every browser write journey, wait for its response, prove the control returns to its completed state, then reload or refresh and assert the persisted user-visible value.

- Before freezing coverage source, check every new source against its actual canonical producer. A web Bun test in the orphan pass/fail set does not emit LCOV. New server helpers with coverage floors must have their test in the shared host list (both coverage and pass/fail), with a file-set regression check. A standalone coverage proof does not establish full-run membership.

## 2026-09-10 — Initial hydration and native composer tests

- Do not hold a conversation’s first authoritative tool-history response while waiting for native composer entry. ChatThread keeps the composer disabled until that response completes. Release and assert the known initial snapshot first; hold only later refreshes when testing live-event reconciliation.

## 2026-09-10 — Live-event stale history races

- A delayed first-load response is not a valid live-event race if it prevents native input. Complete initial hydration, then start a separate stale history read before the event. Release it after the live event and assert the live surface remains; test the later persisted row as a separate refresh.

## 2026-09-10 — Isolated stale-response races

- Count the exact authoritative reads in a stale-response browser race before and after release. Without that count, an unexpected later persisted read can make the visible state pass while the intended stale overlap was never isolated.

## 2026-09-10 — Full producer and native focus review

- Reproduce test environments with the exact temporary-directory ancestry. Keep fixtures that assert no Git ancestor outside every checkout; preserve nested path length when diagnosing Unix sockets.
- A failed startup has not acquired ownership of a public socket. Prove a rejected duplicate leaves the original service reachable before changing cleanup.
- Assert modal focus after evidence capture and deferred frame callbacks. Initial focus alone can miss later composer autofocus.
- Verify a visual evidence case is selected by the mandatory evidence lane, not merely tagged.
- Recompute performance from the live final test inventory. Keep modeled time separate from measured hosted runtime.
- Distinguish a passing direct test from a coverage producer. Verify each source's direct suite contributes a trusted receipt before adding replacement tests.
# Testing coverage review rules

- Check the visible result after an asynchronous response. A request call or cleared field alone does not prove success.
- Wait for loaded records before clicking their controls. Static headings can appear before the data.
- Restore global mocks, prototype descriptors, timers, and module mock state after each test.
- Put Svelte test hosts under `__tests__` so product coverage does not count fixtures as shipped code.
- Run the actual web type check for browser test fixtures; backend/E2E type checks do not cover that surface.
- Match both quote styles when a temporary review tool selects tests. Verify its actual file list and counts.

- Run every coverage gate as an early diagnostic before another full browser freeze. A passing per-file floor check cannot detect a changed file that has no record; the patch gate can.
- When a canonical source inventory changes, update positive receipt fixtures from that shared inventory and retain a negative missing-source control.
- Keep native runtime cleanup failures separate from assertion failures. Retain initial errors, reproduce under the exact runtime and temporary-directory shape, and do not claim that a passing retry proves a root-cause fix.

- Scope repeated conversation titles to their actual UI surface. A page-wide exact-text locator can pass before hydration and fail after the same title appears in a header. Reproduce the fully loaded state, then use the named conversation navigation and its accessible row buttons.

- Check Git's actual diff separately from text-search binary detection. A NUL byte beyond Git's initial sample can affect search output while Git still renders the full diff. Do not report a hidden Git diff without reproducing that result.

## 2026-09-10 — Browser build artifacts

- A Vite preview artifact needs SvelteKit's hidden `web/.svelte-kit/output/server` as well as `web/build` and client source maps. Test the exact upload/download root by restoring it into a clean consumer and starting preview; file-presence checks alone do not prove the server starts.

## 2026-09-10 — Native drag activation

- A drag ghost proves that the pointer crossed the library threshold, but not that the destination received a `consider` event. For a native drag across a long row, first cross the activation threshold, await the ghost, then move to the target and assert the live order before release. Do not replace that state check with a longer timeout or retry.

## 2026-09-10 — Pagination controls and observers

- Do not call an off-screen pagination button deterministic when scrolling it into view activates the same observer path first. Test the manual control with observer callbacks held inert, and test automatic loading with a native scroll. Keep both user-visible window and anchor assertions.

## 2026-09-10 — Browser transport diagnosis

- Do not state a transport root cause from a failed browser trace alone. First compare the exact server and browser paths, retain the failed asset response evidence, and describe any transport explanation as an inference until a matching red-to-green control proves it.

## 2026-09-10 — Clean coverage runners and failed Git commands

- Check the import graph of each no-install CI command. Shared text parsers must not load the AST package required by another job.
- A failed Git diff is an error, never an empty set of changes. Test invalid base revisions through the real coverage commands.
- Assign container tests to a lane that installs and checks the exact runner image. Validate collection as well as the test result.

- Distinguish an import-graph concern from a reproduced runtime failure. Pinned Bun can resolve a stub differently from Node; report the actual clean-runner command result before calling a dependency a blocker.

## 2026-09-10 — Loop dashboard integration fixtures

- Inject the loop-log page seam before defining a dashboard loop. Loop event spies do not intercept `pushDashboard`; a live page seam creates the production channel and can allocate Bun stdout state during coverage. Capture registration and publish calls through one test-barrel helper, restore it after each test, and assert both calls in the real loop flow.
- Pass an explicit `./` prefix when Bun test receives a nested path. Without it, Bun can treat the path as a name filter and run no test file.

## 2026-09-10 — Drawer backdrop tests

- A full-screen backdrop can be covered by its drawer panel. Do not force-click its locator centre: verify an exposed point with `elementFromPoint`, then perform a normal native click. Reuse that contract for each SwipeDrawer test.

- When raising a popover trigger above its backdrop, keep it below the modal layer and verify the actual pointer target. A Playwright interception alone does not prove a user-visible failure; a coordinate click may already dismiss through the backdrop.
- For canonical browser coverage, unit V8 coverage is supplementary. Exercise both changed placement branches in the real browser and inspect remapped line hits.

## 2026-09-10 — Shared coverage runners

- When a parent asks for a process status before any stop, report the exact process chain and wait for the response. Do not infer approval to terminate a shared coverage run. Use the shared heavy-run lock for every broad producer.
- When reviewing a child process runtime, inspect the exact parent command and inherited PATH before using the ambient shell binary as evidence.

## 2026-09-10 — Picker geometry and approval payloads

- Wait until the startup overlay is removed before a native coordinate click. Measure the anchor again after opening when selected chips can change the control's height; an old rectangle can produce a false placement failure.
- Prove timing changes with the corrected browser test. The tick-only control passed all 55 picker/team cases, so the extra animation-frame wait was removed.
- Measure a constrained list at its natural height on each filter/open. Measuring its previous cap can remove that cap on the next update; retain a real short-window regression.
- Validate the complete serialized permission payload in bytes. A valid canonical route permission can exceed an arbitrary per-string character limit; preserve exact grants and human approval rather than splitting or dropping capabilities.
- Read the API result contract before writing a control script: activation returns an operation; inspect durable installation state separately. Keep script-shape errors separate from product failures.

## 2026-09-10 — Async layout and browser-engine checks

- Assert related asynchronous layout values in the same wait. Control deferred preferences so both the initial and updated menu layouts are proved.
- Read operation state and ID from the operation heading. Diagnostic content can use the same inline elements.
- Before a Nix WebKit run, check whether its launcher replaces LD_LIBRARY_PATH. Use a task-owned launcher copy for local compatibility; do not alter the shared browser cache. Keep Chromium-only coverage disabled for other engines and assign an unused task port.

- Run gate integrity before every commit that changes tests, even after a passing suite. Its AST check does not follow local assertion helpers; keep a meaningful visible-result assertion in the test body.

## 2026-09-10 — Standard coverage manifest

- A focused coverage include does not prove the CI producer measures that source. Register every canonical source in the standard manifest and assert registry completeness. Use the actual standard launcher for the final coverage diagnostic. Do not let a manual include mask a missing producer registration.

## 2026-09-10 — Production startup and idle baselines

- When first-admin setup begins real background work, resource and recovery proofs must observe verified bootstrap completion before requiring an idle runner. Keep setup HTTP pools outside the measured process and retain the startup receipt.
- Bounded container polling needs a pacing interval. A fast fixed-count loop can exhaust all observations before an asynchronously created container appears. Keep native pause/recovery and zero-resource assertions intact.

## 2026-09-10 — Shutdown subprocess ownership

- A passing shard can hide a first-attempt failure. Audit raw failed-test summaries and the actual `Retry sweep` / `isolated plain re-run` messages before accepting CI.
- A readiness timeout must kill and reap the owned child. Drain stdout and stderr from spawn, bound exit after the signal, and retain diagnostics on early exit. Use the current executable rather than an ambient `bun` binary.
- Shutdown tests need a real writable database, not repeated catalog creation inside the signal handshake. Build a closed empty catalog once, give each child a private copy, and keep writes and data-survival checks in the real child/reopen path. Verify the unchanged deadline under the same load that reproduced the failure.

## Factory test infrastructure

- When the user identifies a local GPU, inspect DRM, KFD, PCI and container device access. A missing NVIDIA tool or device does not prove that the host has no GPU.
- Check local Compose services before asking for remote test infrastructure. Use the user's current test scale and report its limits separately from launch capacity claims.
# Announced commits are immutable

- After I send a commit SHA to another agent, I must not amend or rewrite that commit.
- Any correction, generated artifact update, or coverage fix must be a new follow-up commit so active consumers can cherry-pick safely.

## 2026-09-13 — Artifact partition identities

- Never map an unbounded partition identity to a signed database slot with a lossy hash. Prove both numeric range and collision behavior on PostgreSQL before using an identity as a unique key.

## 2026-09-13 — Portable real-service proofs

- A real-service test must obtain endpoint and secret-reference paths from the explicit test environment. Do not hardcode one user's runtime directory or loopback port.
## 2026-09-12 — Ambiguous delivery reconciliation

- A high-water inbox sequence cannot prove that a specific event was applied. Reconcile an uncertain delivery only from the exact event ID and hash in the live inbox or an immutable product tombstone; otherwise retain `outcome_unknown`.

## Factory compiler output invariants

- A compiler success must pass its own public compiled-artifact validator. Test materialized defaults against shorter enclosing bounds, including nested control graphs.
- Enforce size limits on the final canonical artifact as well as its source and pages. Derived indexes can duplicate enough source data to cross the compiled IR limit.
- API resource types must match the durable store's canonical metadata names and object model. Do not require extra content-addressed objects when one immutable compiled artifact already embeds the definition and lock.
- Keep digest namespaces explicit in shared contracts. Compiler definition digests use the `sha256:` prefix; blob and idempotency payload digests use raw lowercase hex. Build integration fixtures from real compiler and store outputs so format drift fails at the boundary.
- Define one canonical mutation-payload helper and use it for both digest creation and verification. Exclude only caller-selected idempotency keys and the digest claim itself; include trusted route identity, the expected revision, and the complete request body.
- Return a terminal workflow result before evaluating continuation thresholds. A partition that crosses the threshold on its final event must close; continuing a terminal kernel state can produce an invalid history action and a stuck result handle.
- Apply all C08 byte limits to audit activities too. Canonicalize a transition once, stage bounded immutable pages, finalize their manifest, and commit only the compact event identity and artifact reference before effects.
- Derive root and partition Temporal workflow IDs with one shared helper. Keep the stored root workflow identity separate from the explicit target interpreter so delivery and reconciliation address the same child.
- Restrict partition repair traversal to nodes present in the active kernel state. A full compiled successor index includes foreign partitions; a non-null assertion can turn a valid source repair into a workflow failure.
- Snapshot caller-owned principals, resource keys, and mutation bodies before the first asynchronous authorization step. A caller can otherwise change the authority check, idempotency hash, or eventual write target while the operation waits.
- Register shared authorization wrappers in the scope-enforcement scan when routes delegate their complete gate. A shared gate is safe only when the guard test recognizes and verifies its use.

- An artifact staging callback must accept the caller's transaction and run after the scoped run row is inserted. A separate storage transaction can violate foreign keys or deadlock an enclosing transaction; prove composition with real PostgreSQL and S3.
- Permission tables can contain alternative authorities. Test a run-only initiator separately from an owner who also holds operate permission, and recheck authority when returning a cached cancellation result.
- Compare each modeled foreign key's exact columns, target and delete rule with the PostgreSQL catalog. Counting keys alone can miss a wrong relationship.

## 2026-09-13 assurance review

- Bind an acceptance decision to the full run, node, candidate generation, and lifecycle fence. Do not use a project-wide decision ID as release authority.
- Recompute every protected evidence digest from all persisted fields before a claim. A stored digest alone does not prove a mutable row still has its approved facts.
- Use `Set.has` before `Set.add`; `Set.add` always returns the set and cannot detect duplicates.
- Snapshot untrusted inputs before the first await and test the exact digest object in both creation and consumption paths.

## 2026-09-13 — Shared heavy validation

- Check the shared heavy-validation lock before starting a broad test or coverage pool. When another producer holds it, run only focused leaf checks and leave the canonical regression run to the queued owner.

## 2026-09-13 — Scoped artifact keys

- Every durable artifact key and foreign key must carry tenant/project scope. An opaque object ID alone is not a sufficient product primary key.

## 2026-09-13 — Drizzle foreign-key parity

- When a raw factory migration defines a scoped foreign key, model the same source columns, target columns, and delete rule in Drizzle. Schema table/primary-key parity alone is incomplete.

## 2026-09-13 — Factory C06 validation correction

- Do not report a factory leaf complete from focused Bun tests and lint. Record all four canonical typechecks, owned-source and patch LCOV producers, real Node runtime proof, and real local-S3 proof.
- Rebuild `@ezcorp/factory-sdk` before Node orchestrator checks that consume generated `dist` declarations.

- After changing kernel state retention or control expansion, run every SDK test file, including expansion and recovery. Focused kernel, partition and simulator proofs do not cover all repair behavior.

- Run each production client against its real server across process boundaries. A raw HTTP client and a separate mock-server client suite can both pass while they disagree on empty responses or receipt shapes.

## 2026-09-13 — Stored command lookup review

- Snapshot every trusted command-reference coordinate before its first await, then use only that snapshot for lookup and verification.
- A stable command ID with identical canonical bytes may recur in a later transition. Retain its first committed audit pointer; reject only a digest change.
### 2026-09-13 — Verify exact test paths before sending replay commands

- Search the repository for the test file and copy its actual path into the replay command. Do not infer a path from the route name.
- A browser coverage fixture name must also come from the current tree. In this project it is `web/e2e/fixtures/hydration.ts`.

### 2026-09-13 — Preserve durable service authority

- Persist the complete public service credential identity with a durable request. Reconstructing only the service account ID loses the credential revision and revocation fence during later authorization.
- Audit every adapter that reconstructs a principal from that durable request. Lifecycle and journal authorization must both carry the credential fence into the current grant check.

### 2026-09-13 — Verify nested route imports

- Count a SvelteKit route's directory levels from its actual file and run the focused server test before treating a shared-handler import as correct.
## 2026-09-13 — Release authority fact scope

- A current-candidate reader must include the exact node instance. A run can contain several candidate-producing nodes, so run scope alone cannot select release authority.
- A real PostgreSQL proof must use the shared per-test database helper and `FACTORY_TEST_POSTGRES_URL`. Never point a release test at the shared application `DATABASE_URL`.
- Candidate authority must originate from an authenticated terminal journal fact and verified stored output bytes. Do not derive it from a caller digest, a latest acceptance row, or an allow-all reader.
- A candidate artifact slot needs its own node-instance and generation columns. Do not reuse interpreter identity or transition sequence fields for candidate identity.

- In tool orchestration, check each shell exit code before dependent staging or commit calls. A failed conflict-resolution script must stop the sequence.
- Validate the current protected row before advancing any authority revision or epoch. A correct expected counter must never launder a damaged prior seal.
- A successful terminal fact must close the attempt's effect journal. Preserve exact terminal replay through its own verified path, and reject every later prepare or dispatch.

- A PostgreSQL restart test must call the production migration adapter and lock, not a raw Drizzle connection whose execute result has a different shape. Reuse one fixture migration function for setup and restart.

## 2026-09-13 — Release mutation receipts

- For a mutation with post-commit immutable archive work, cache a stable product locator first. On retry, reauthorize, resolve the current product row, and resume only the missing archive phase.
- Put reconciliation proof, archive publication, product state, audit, and the cached response under one receipt transaction. This prevents a cached retry from repeating external proof or creating another reconciliation fact.
- Map each factory release route to the C01 authentication table before declaring a shared session gate. Release preparation and reads can use scoped service principals; reconciliation uses write routing while its store still requires a human session. Contract, approval, policy, and trust remain session-only.
## 2026-09-13 — Pool admission retries

- Validate and snapshot the full pool request before writing its grant binding. An invalid resource vector must not reserve an id.
- Converge concurrent identical first requests with conflict-safe insertion and an exact durable reread. A select followed by a plain insert is not retry-safe.
- Authorize a reconciliation operator before loading protected operation details or resolving a provider. Keep the store's transactional authorization as the final current-authority fence.
- Deep-snapshot public request bodies before the first await. A response or provider call must never observe mutations to the caller's nested objects while durable work is pending.
- Live Temporal workflows use shared server/task-queue state. Acquire `/tmp/ezcorp-validation-heavy.lock` before every Temporal producer, write START only after acquisition, and await fixture teardown before another launch. SDK builds must run before any workflow bundle that imports a changed runtime SDK export.
## Producer source freeze

- Do not queue a coverage or integration producer until all source, tests, registration, and gate edits are complete. If the source changes while my own producer waits for the shared heavy lock, cancel only my queued producer and restart it from the final source snapshot.
## 2026-09-13 — Durable input validation

- A durable artifact descriptor cannot be validated through a placeholder JSON value. Validate its immutable host facts separately, and validate only inline parameters against workflow port schemas until a recorded bounded read resolves an artifact field.

## 2026-09-13 — Command reply identity
- Keep response event identity in the agreed command-derived form when retries and records already use it; do not substitute a new hash only for defensive length concerns.

## 2026-09-13 — Async partition test liveness
- For a cross-partition Temporal assertion, wait for the recorded delivery activity to finish before querying the target state. Polling a target before the source effect is scheduled tests host timing, not invalidation behavior.

## 2026-09-13 — Child authority and delegation

- A child run can be independently durable without becoming independently authorized. Recheck every live ancestor binding and fence before each child task, child, or approval admission; an old child receipt may recover only its exact prior result.
- A child budget uses a sealed parent portion, not a fresh copy of parent limits. Lock parent before child, reserve the parent sub-envelope with child creation, and settle only measured child spending after every child hold resolves.

## 2026-09-13 — Child workflow scheduling identity

- One logical child run has one scheduling authority. A child launched through `executeChild` must use its durable child logical ID and must never also enqueue a root `start_run` command.

## 2026-09-13 — Compute admission execution fences

- Persist and compare only execution authority fields in a compute admission fence. Public projection revisions and status can advance from queued to running without changing execution authority.
- Test canonical zero-based candidate generations at every writer and reader boundary. A terminal reader must accept generation zero when the kernel defines it as the first generation.

## 2026-09-13 — Child start clocks

- A child has no root `start_run` outbox, so it must persist the original root clock inside its sealed binding. Never infer it from row creation time or use a zero default for legacy rows.
- A reader of that clock must verify the entire binding digest, not only a timestamp and a digest-shaped string. A legacy populated binding without the fact must stop migration for explicit backfill.

## 2026-09-13 — Child ancestor liveness

- A sealed child binding pins the parent command and its attempt, not the parent audit head. Recheck that exact command against the latest verified parent state; unrelated timers, sibling results, and approvals may advance the head while the child remains valid.
- Idempotent settlement must reread the binding after budget locks. A concurrent winner can change open to settled while the loser waits; return its same durable receipt instead of reporting a conflict.

## 2026-09-13 — Runner boundary scope

- `FactoryRunnerSupervisor.invoke` is a single-tool journal adapter. Never present it as a complete `TrustedFactoryRunner.run` implementation or use it to prove full C02 request execution.
- Package preparation may prove exact v4 build and artifact hydration. The durable dispatcher remains responsible for claim, token minting, and complete request execution.

## 2026-09-13 — Schema migration parity

- For every migration default, model the same default in `schema.ts`. Run the canonical schema parity test; focused feature tests do not detect a missing ORM default.
- When `exec_command` returns a session ID, the producer is still active. Poll it to completion before editing any source that belongs to its manifest.
- Before importing a support commit into an older isolated worktree, compare its parent ancestry with the worktree base. If the support commit depends on intermediate modules, merge the validated descendant that contains the full ancestry instead of cherry-picking the leaf alone.

- A repair of an active candidate stops that attempt before it creates the replacement. Its retained prior-candidate status is therefore `cancelled`, even when the repair signal first observed it as `running`.
# Generic approval currentness (2026-09-13)

- Do not equate an approval command's creation transition with the interpreter head. Validate the stored command against the latest committed runtime attempt. Unrelated committed progress can advance the head while that approval remains current.
- Notification visibility and decision authority must use the same current-command reader. A projection-only head equality check can hide a decision that the store still accepts.

## 2026-09-13 — Partition command batches

- Do not use the simultaneous-activity limit as a persisted command-batch limit. A valid partition can emit more commands than it executes at once. Test real published partition transitions through product storage, not only an in-memory Temporal activity fixture.

## 2026-09-13 — Preparation receipts need durable authority

- Do not populate an in-memory readiness cache until the enclosing database transaction has committed. Return only immutable snapshots; a rollback must not expose a receipt.
- A claimed two-phase operation needs a durable intent before external work. Read checks alone are not an intent.
- Do not reuse one project-wide package lock for a graph with several pinned runner references. Each prepared reference needs its own revocable trust fact and readiness check.
- Keep comments aligned with the accepted transport seam. Dispatcher readiness runs after durable claim and before token minting.
# Package trust identity — 2026-09-13

- When a public reference accepts optional identity fields, every database key and foreign key must use the canonical complete reference. A seal alone does not prevent row collisions.
## Command authority extension on moving integration bases

- Before extending a shared authority module, compare it with the current integration head. Reuse its stored command entry, source sequence, command digest, and ancestor validation. Do not reconstruct an origin query that the integrated module already supplies.
- A partition command must bind the requested interpreter ID to its declared source partition, in addition to validating the loaded state partition and compiled edge.

## 2026-09-13 — Package authority parent review

- A sealed historical revision does not prove current authority. Validate mutable current pointers against the latest immutable revision before dispatch or mutation.
- Bind an extension installation's project scope at every catalog read; a project grant does not grant access to another project's package.
- A concurrent preparation may observe the other worker's completed intent. Verify its facts and receipt, then return the same receipt. Do not reject completion solely because its phase changed.
- Reused preparation receipts need the same current release/evidence checks as dispatch readiness.
- Model every migration foreign key, including references to pre-existing v4 tables. Run the canonical PostgreSQL schema proof before calling an integration complete.
## 2026-09-13: Preserve optional quorum evidence and subfactory provenance

- A claim referenced by a quorum group is protected evidence even when `required` is false. Register and validate every group claim. Apply `required` only as an individual gate; apply the group threshold separately.
- A subfactory result is not the parent task's terminal result. Bind a sealed alias to the exact current parent attempt, child binding, child acceptance decision, and child artifact. Recheck both parent and child lifecycle fences before reuse.
- A mutable current pointer must equal the maximum immutable revision in its scope. Validate that invariant while the pointer is locked so a rollback cannot reactivate revoked trust.

## 2026-09-13 — Provider receipt proof

- A structurally matching operator-supplied receipt is not proof of an external effect. Resolve the configured provider and verify the exact immutable version before success or archival settlement.
- Use the same bounded, abortable proof boundary for receipt attachment and absence reconciliation. Timeouts preserve uncertainty.
## Repository test commands

- Read the root package scripts before invoking a focused web test. This repository has no `test:web` script; run `test:component` from `web` and pass paths relative to that working directory.
- When light checks run in parallel, wait for every producer to close before applying even a small lint fix. Rerun every check whose source snapshot changed.
- A change to a shared verifier (JWT `iss`/`aud`) must be proven with the canonical web Vitest pool, not only focused factory suites. A legacy test that hand-signs tokens must mint them through the production signer so the test exercises the enforced envelope instead of bypassing it.
- In zsh, `set -- $var` and unquoted `$var` do not word-split. Run multi-field loops through `bash -c` or `read a b <<< "$line"`; check that every iteration ran before trusting a batch.
- A hook can require `git worktree add ./.worktrees/<name>`; create agent worktrees from the integration worktree root with that exact prefix.
- Before merging an agent branch, run its full component suite on both the branch and the integration baseline. A branch note that cites one passing case does not show whether the branch broke a neighbouring existing test.

- `podman ps` can report a container `Up` from stale state. When the systemd user session dies, podman cannot reach the user bus, `crun` fails with `sd-bus call: Access denied`, and the reported status keeps describing a process that no longer exists. Check `State.Pid` against the process table and probe the port before trusting a service container, and read a `Connection closed` from a client as a possible dead server rather than a client defect.

- Adding a wildcard threshold key without registering its producer in the canonical pipeline reds every local coverage run through the whole-tree dropout signal. A new runtime's coverage registration is not complete until the producer runs in `scripts/test-coverage.sh` as well as in CI; check which of the three modes should carry it, because a leg that needs a toolchain CI installs in one job must stay out of legs-only.

- Derive a registration requirement from the artifacts on disk, not from a written list. Five PostgreSQL suites and thirty-four C13 reuse edges were missing precisely because both inventories were hand-kept; a check that re-derives them fails closed on the next omission instead of waiting for the next audit.

## 2026-09-13 — Auxiliary artifact materials

- An additive unique index is part of a table's contract. Before giving an existing table a new
  row kind, check every unique index over it: a kind that fills none of the existing identity
  slots collides with every other row of that kind and needs its own bounded dimension.
- A repeat-safe migration must also be safe against later steps. A migration that drops and
  re-adds a narrower CHECK on every boot rejects rows a later widening already admitted. Install
  a narrowing constraint only when the database has not reached the later widening.
- When one module must both own a shared validator and reuse another module's denial funnel, move
  the funnel to the shared leaf and re-export it. A runtime import cycle is not the alternative to
  a small move; it is a worse version of it.
- Build the rejection list as thunks, not as an array of started promises. Awaiting them one at a
  time afterwards leaves every rejection unhandled first, which in bun:test wedges the whole file
  rather than failing one case.
- Read a limit from its source text when a Node strip-only test cannot import the module that
  defines it. A changed limit still fails the test, and no constant is duplicated.
- Raising an envelope also raises the cost of how the body is buffered. Rejoining the whole
  connection buffer on every packet is invisible at 1 MiB and quadratic at 8 MiB.
- A per-test timeout inside a test's own signature is not raised by the runner's `--timeout`. When
  such a test fails only under coverage on a loaded box, give it its own invocation rather than a
  bigger budget.
- Check a shared container's PID, not `podman ps`. Podman reported a dead PostgreSQL container as
  up for ninety minutes while its PID was gone, `podman exec` failed, and its port refused.
- Never reach for `git stash` to answer a question. A lint baseline is a `git show`/`git diff`
  question; stashing touches a stack other sessions own.

- An operation that is retried must return its first handle, not repeat its write. Composing
  idempotent primitives does not make the composition idempotent: begin was idempotent and
  writeChunk correctly refused a sealed material, so the replay failed until the composition
  checked for the sealed record itself.
- A generated JSON Schema with `additionalProperties: false` rejects a hand-built fixture that
  carries one extra field. Copy the shape from the package's own valid fixture rather than
  assembling it from the type.
- A package that adds a `tests/postgres/*.test.ts` suite must register it in the `db-postgres.yml` producer list in the same change. Two branches can each pass alone and fail together: the registration gate arrived with W18 while the unregistered suite arrived with W04. Run the combined tree's registration gates at integration, not only each branch's.
- Check host memory and other sessions' heavy processes before starting parallel producers on a shared box. A 30 GB host reached kernel OOM when an external 20 GB mutation run overlapped three workers; it killed the per-user systemd manager and the PostgreSQL proof container, which then falsely reported `Up` while refusing connections. Verify `pg_isready` inside the container, not the `podman ps` status.

## 2026-09-13 — Independent archive writer

- A gateway role can be added without editing the file that composes it. The release store already
  took a `FactoryReleaseArchive`, so the archive-writer role became that interface and did the rest
  of C04 step 1 inside the material write. Widening a union or restructuring `releases.ts` would
  have been a change to another owner's file for no behaviour the seam did not already allow.
- Order the writes so the observable marker is last. Members, then the manifest, then the material
  object; the shared store sets `archive_ready` only after that call returns, so every crash
  boundary leaves publication pending with nothing to undo.
- A manifest that embeds storage metadata is only stable if the store's conditional create is.
  The first memory fixture handed out a new version on every write, so a retried archive produced a
  second manifest and the idempotence assertion failed. The fixture was wrong, not the code — but a
  fixture that is more permissive than the real store hides exactly this class of defect.
- Do not construct another module's key layout to read it back. Derive the prefix by stripping the
  known `<name>/<digest>` suffix from a reference the operation already holds. The layout then has
  one owner, and a restore that has only the archive can still list the operation.
- Separate credentials and separate volumes on one host prove credential separation and nothing
  else. Put the verdict in a field (`failureDomain`, `deployedIndependenceProven`,
  `unmetCriteria`), not in a sentence, and make the classifier refuse to return the good verdict
  without an operator's replication statement. A record that cannot overclaim is worth more than a
  caveat a reader may skip.
- Split "ready" from "publication grade". A same-host deployment can be operationally ready while
  still failing the criterion that gates a production claim; one boolean would have forced a choice
  between blocking local work and lying about the deployment.
- Prove a denial with the status, not just the absence of success. All 130 refusals here were HTTP
  403; a 404 would have been a weaker claim, because a missing object and a refused one look alike
  from the outside.
# C02 topology — 2026-09-13

- A native runner function is not an isolated runner. Keep the durable tenant launch intent in the gateway database, run the Bun and Python bridges inside the per-attempt guest, and keep the host to opaque process facts and physical-stop receipts.
- A physical-stop receipt digest identifies the canonical unsigned facts. Sign those same bytes with the configured RSA host key; do not digest a separate signed wrapper.
- A physical-stop proof needs the configured host principal as a signed required fact. Provider allocations without a stable host identity cannot use this stop-settlement path.
- A launch claim must identify its one winner. A `launching` row alone does not grant another caller permission to start or invoke a guest; after a recovery boundary, use a durable result or report uncertainty.
- Compare a prepared package receipt with the full canonical runner reference, including model and configuration fields. A stopped worker is physically absent only after a terminal runtime observation, never because an inspect call says `unknown`.
- A restart proof must use a fresh real supervisor, not a fake runner that implements attach. The real adapter must reconstruct a live framed connection and remove a surviving container after restart. GPU devices belong to the held per-attempt allocation; a global host runner device list cannot authorize every attempt on that host.

## 2026-09-13 — W01 durable runtime

- Making a readiness call lazy can remove more than the call. Changing `PodmanRunner.build()` from `initialize()` to `acquireLease()` to keep a recovery attach from sweeping orphans also removed store preparation and the fail-closed kernel isolation probe from every build. When narrowing a startup path, list what that path did and reintroduce each part deliberately; an `ENOENT` on an artifact rename was the visible symptom of a missing security control.
- Parameterize the destructive half, not the whole readiness step. `probeSecurity(cleanupOrphans)` already existed and nothing ever passed `false`; a dead parameter is a sign the intended seam was bypassed rather than used.
- A reverse capability that checks only the method name is unbound. The v4 guest SDK already sends the exact `InvocationContext` beside its input, so compare it byte for byte; without that, losing the controlling attachment does not stop another attachment's frames from being answered.
- Build a guest's start request once. A context whose deadline derives from `now()` cannot be recomputed later and still compare equal, so the started context and the invoked context silently diverge.
- A durable claim that a later check denies must be released when nothing physical has happened. Leaving the row in `launching` turns a transient trust failure into a permanently stuck attempt. Release only when no token was minted and no container exists; a denial against a live guest records uncertainty instead.
- Declare every migration CHECK constraint by name on both the fresh and the upgraded path. An unnamed table-level CHECK in `CREATE TABLE` gets a different generated name than an `ALTER TABLE ADD CONSTRAINT`, which is how a fresh database ends up with a constraint an upgraded one lacks.
- Pick one uniqueness mechanism per column. An inline `UNIQUE` on the fresh path plus a `CREATE UNIQUE INDEX` on the upgrade path leaves the two databases structurally different.
- Do not keep a TypeScript guard for a state a database CHECK already forbids. It is unreachable, it cannot be covered, and asserting the constraint name from the driver error proves the schema instead of the code.
- Before blaming a change for a container failure, check the per-user systemd manager. `crun: sd-bus call: Access denied ... requires interactive authentication` means `user@1001.service` is dead, not that the code regressed; `podman ps` can still report a container `Up` for hours after its processes were killed with that manager, so verify the recorded PID exists and the port answers.

## 2026-09-13 — W01 real-container corrections

- Never run a kernel probe on a recovery attach. It creates a container and costs seconds, and a guest whose control pipe died with its supervisor does not survive that window; the attach then fails with `worker_not_running` and the recovery it was performing is lost. Attach creates no sandbox, and the running guest already carries the namespaces, seccomp profile, and cgroup limits fixed when it was created, so the probe protects nothing there.
- Once execution is detached, the orphan sweep belongs only to explicit daemon startup. A container legitimately outlives the process that started it, so a fresh supervisor calling `build()` or `start()` must not sweep, or it destroys another attempt's surviving guest.
- Release a test-held exclusive lease in a `finally`. An assertion that fails before the release leaks the store lock and every later test in the file fails with an unrelated `runner_store_busy`, which hides the one real failure behind seven false ones.
- A readiness stub must answer with the exact receipt the dispatch carries. Returning a base fixture while the test dispatches a freshly built artifact makes a correct drift check look like a product failure.
- Model a jsonb column default as SQL, never as a JavaScript object. Real PostgreSQL schema parity stringifies a non-SQL default, so an object default compares as `[object Object]` against the engine's normalized JSON literal.
- A blocked producer is not a passing producer. Keep its receipt, label it blocked, and rerun it from the final source once the host recovers; two real defects in my own fix appeared only in that rerun.
- Hand a downstream seam every coordinate it needs. A checkpoint writer that receives only an operation ID has to parse its cursor back out of that string, and the SDK validator requires the cursor to equal the operation index exactly. Pass the index and the attempt authority instead.
- A declared interface never satisfies a `JsonValue`-style index signature, because declaration merging can widen it later. Only type aliases get that implicit signature. So a seam typed `Promise<JsonValue>` silently rejects any implementer returning an SDK interface, and the mismatch surfaces at integration rather than in either worker's own typecheck. Type the seam as the thing it actually returns, and convert once at the storage boundary.
- Verify a peer's "satisfies your interface structurally" claim with an assignability probe against their real signature. Reading the code is not the same check the compiler performs, and a fixture that returns an invented shape hides the mismatch from both sides.
- The consumer cannot run that probe. A worker who may not import the other branch's interface can only mirror it, and a mirror encodes their belief about the contract rather than its declaration, so it passes while the real assignment fails. The owner of the seam must pin it instead: commit a conformance test in the owning tree that assigns a writer returning the real downstream type to the real interface, and prove the guard by re-widening the seam and watching the typecheck break.
- A new file under a gitignored directory is silently skipped by `git add -A`, even when sibling files in that directory are tracked. Tracked files there still stage normally, so the omission is invisible: my gate file lived only in the worktree for eleven commits while `todo.md` and `lessons.md` committed fine. Force-add a new file under an ignored path and verify with `git ls-files`, never with `git status`.
- Treat "flaky test" as a hypothesis, not a diagnosis. Reproducing the supervisor-kill path faithfully showed the guest exits on its control pipe's EOF within 250 ms, so the test had been passing by winning a race against a real requirement violation. The recommended bounded retry would have converted an honest intermittent failure into permanent false confidence.
- A control channel whose transport is the container's stdin cannot survive its client. `podman attach` forwards its own end-of-input into the container, so any supervisor death kills the guest. A FIFO the guest holds `O_RDWR` does survive, because a FIFO reader sees end-of-file only when every writer closes and the guest is permanently one of them.
- Abstract a transport by extracting exactly the members the consumer already uses. `ChildProcessWithoutNullStreams` then satisfies the new interface structurally, so nine consuming files and a security-relevant frame policy stayed untouched while the underlying channel changed completely. Mirror the platform's overload shapes, since a single union-event signature will not match Node's overloaded `on`.
- Do not assert a container's exact podman status string. `stopped` and `exited` are both terminal and which one appears depends on how far teardown has progressed; key on `Running` and `ExitCode` as the product does.
- A bind mount is a two-way boundary. I added the guest's only read-write mount and widened its directory to 0o777 so the mapped uid could reach the FIFOs, which let the guest unlink an entry and plant a symlink the host then opened by name. Give the guest the narrowest inode modes it needs, never a writable directory, and mount read-only: a FIFO still opens read-write on a read-only mount because the kernel's EROFS check covers directory-entry changes and regular files, not passing data through a pipe.
- A host that reopens a path an untrusted party can reach must open with `O_NOFOLLOW` and then `fstat` the descriptor against the file type and the device and inode recorded when it created the file. Checking the path before opening it is a race; checking the descriptor after opening it is not. Keep those recorded identities outside anything the untrusted party can see.
- Share the exact flags between production and its security test. Exporting the mount builder and calling it from both means the test cannot quietly drift from what ships, which is the usual way a hardening regression stops testing the real configuration.
- A guard that rejects correctly can still report badly. `O_NOFOLLOW` raises the kernel's own ELOOP, and a directory raises EISDIR, before any identity check runs, so two of the refusals surfaced as raw filesystem errors while the rest were typed. Wrap the whole open so every refusal leaves one typed error with the underlying code preserved; a caller should never have to tell a rejected substitution apart from an incidental I/O failure.
- All worktrees share one `.git/config`. A `core.bare = true` written there (by any session) makes `git status`, `add`, and `commit` fail with "must be run in a work tree" in every checkout at once while `git log` still works. When workers stall without commits, check `git config --show-origin core.bare` before suspecting their code; never run `git config core.bare` or `git init --bare` in a worktree. With `extensions.worktreeConfig` enabled, `git config --worktree core.bare false` inside a worktree repairs that worktree without touching the shared file.
- Bound every command that holds the shared heavy lock with `timeout` (for example `flock <lock> timeout 1200 bun test ...`). A test process that spins at 100% CPU with no output held the lock for fifty minutes and stalled three other workers; a per-test `--timeout` does not stop a busy loop outside a test body.


## 2026-09-13 — W03 stop, cancellation, and settlement

- A container's PID 1 gets no default signal action from the kernel, so a guest shim without an explicit `SIGTERM` handler silently discards every graceful stop. Measured against a real rootless Podman sandbox: the abort was delivered, 41 cleanup observations found the sandbox still running, and the full ten-second contract grace was paid before the kill. Forwarding the signal to the extension, which is not PID 1 and does take the default action, turned the same case into a clean exit in 6.4 s with no kill. A cleanup window that no signal can reach is not a cleanup window.
- Run the contract against the real runtime before believing the grace period works. The unit tests for the three phases were green while the abort reached nothing; only a real container showed it.
- A `jsonb` column reads back as an object on PGlite and as a string on the real engine's driver. `rowIntent` decoded only the object form, so every launch read failed on real PostgreSQL with a schema error while PGlite passed. One decode helper for both is the fix; a sibling reader in the same file already did it, which is the usual shape of this bug.
- A grace loop that polls under an injected clock must bound its own iterations. With a frozen `now()` the deadline never arrives, and a wait that does not advance the clock turns the loop into a busy spin that pins a core until the test timeout. Bound it by elapsed budget AND by poll count.
- `bun test ... | tail -12` can hide a red banner behind a zero exit code. Read the `N fail` line from the full log, never the exit status of a pipeline whose head was truncated.
- The stop path must not re-authorize forward dispatch. Reading the attempt through `readAuthorizedStoredInTransaction` dragged in the live-run authorizer, which refuses a cancelling run by design. Read the queue's sealed reference and the durable execution row and compare them; that is a stronger check and it does not borrow an authority meant for starting work.
- C02 needs a settlement-scoped run authority. `authorizeRunInTransaction` allowed only `queued|running|waiting`, so the moment an operator cancelled a run nothing could stop its attempt. Settlement continues after new dispatch stops, so the allowance has to exist; give it to the cancellation path only, and propagate it to ancestors or a nested cancellation still fails at its cancelling parent.
- Idempotency added to the wrong predicate weakens a gate. Making `confirmStopped` return true for an already-stopped row dropped the rest of the authority tuple from the answer, and an existing test caught it. Let the caller's own sealed record carry the idempotency instead.
- Order the cheap sealed check before the durable write. A late provider receipt with a changed amount was reaching the journal first, so the caller saw a journal error instead of the settlement conflict that actually applied. Read the existing settlement for that receipt first, return it on a replay, refuse a differing amount, and only then write the proof.
- `expect(...).rejects` never drives Bun's lazy `SQLQuery`, and on Bun 1.3.14 it then BUSY-SPINS rather than blocking: measured at state R, 100% CPU, with CPU time tracking wall time one for one and no output, while the adopted form `Promise.resolve(query).then(ok, err)` rejected in 6 ms. That is how one assertion held the shared heavy lock for fifty minutes. Adopt the query into a real promise, and guard it statically, because a hang cannot be caught by a runtime check that does not race a clock. PGlite returns a real promise and hides all of this.
- Killing a `flock` wrapper does not release the lock, because the child inherits the descriptor. An orphaned `bun test` held the shared heavy lock for about fifty minutes and starved every other agent. Kill the process group and verify with `ls -l /proc/<pid>/fd`. (From the pool work in this package.)
- `node --test --experimental-strip-types` cannot strip a TypeScript constructor parameter property; use an explicit field. `bun run typecheck` does not catch it. (From the pool work in this package.)
- Workspace packages resolve through their built `dist` types. After merging a branch that changes `packages/@ezcorp/factory-transport` (or the SDK or orchestrator), rebuild that package before typecheck; a stale `dist` reports a missing export that the source has.
- A probe that asserts the environment it happens to run in cannot be shipped as a test. The Python guest's own suite runs both on the host and, during the build, inside the isolated container; a case asserting "at least one escape succeeded" was true in one place and false in the other. Give the probe its own control instead: an action it is always allowed to take, whose success proves the probe can observe one, so an all-refused report is never vacuous wherever it runs.
- Name what a probe actually measures. Reading `/proc/1/environ` under a private PID namespace reads the guest's own init, not the host's, and spawning a process inside a sandbox is not an escape. Measure the spawned child's capabilities, no-new-privileges, seccomp mode and routes instead of whether the spawn succeeded.
- Verify a control from the runtime API in the shape that API reports. Podman expands `--cap-drop=ALL` into the explicit set it would otherwise have granted, so asserting the literal string `ALL` fails against a container that is correctly configured.
- A container's environment is not what the run command declares. The image's own `ENV` reaches every guest unless `--unsetenv-all` removes it, and two variables the OCI runtime writes after the spec is built cannot be unset at all. Measure the environment inside a real guest before recording an environment requirement as met.
- A file bind-mounted into a container must be readable by the container's mapped user. A worktree created with a restrictive umask leaves committed fixtures at 0600, which fails a proof for a reason that has nothing to do with what it proves. Stage a readable copy.
- `git add -A` silently skips a NEW file under a gitignored directory, even when sibling files in that same directory are tracked. `tasks/` is ignored while `tasks/lessons.md` and `tasks/todo.md` are tracked, so two commits that were meant to add `tasks/factory/<package>-GATES.md` updated the two tracked files and added nothing else, with no warning. After committing anything under `tasks/`, check `git ls-tree -r --name-only HEAD -- tasks/` names the file; `git add -f` is what lands it.
- PGlite and Bun's SQL driver disagree about JSONB, and only real PostgreSQL shows it. Bun types a string parameter as json, so an interpolated-text cast to jsonb is a no-op and the column stores a JSON *string scalar*: every server-side `->` path then reads NULL and every read decodes a string instead of an object. Cast through text first, decode through one shared helper, and assert `jsonb_typeof(column) = 'object'` in a real-PostgreSQL test. A feature whose only storage tests run on PGlite has not been tested.
- A concurrency test is not a coverage formality. The sequential cases for a `pg_advisory_xact_lock` fence all passed while the fence matched nothing at all; the `Promise.all` case on a real pool is what exposed it. When the plan asks for concurrent calls, the serial version is not a weaker form of the same evidence.
- Changing a CLI means grepping for its callers, not just its tests. Removing two argparse flags broke a test in a required CI lane that the changed-file list never mentioned, and the lane gate only checks that the workflow *declares* the producer, so it stayed green.

- A `DO $$ ... $$` body accepts no bind parameter. Splice a fixed catalog definition into it with `sql.raw` and keep the literal in one named constant, so the guard and the statement it guards can never drift.
- Do not install a CHECK that no landed writer can satisfy. A constraint whose column is still written NULL by the current path fails every write from the moment it lands, and `NOT VALID` does not help because it still enforces on insert. Land the column and its format checks, and let the writer's own change add the completeness check.
- A migration that drops and re-adds a primary key on every boot churns its catalog entry and revalidates the table. Guard each reshaping step on the exact shape it produces, then assert constraint OIDs are unchanged across two boots; a definition-only comparison cannot see the churn.
- A CHECK line that names a category of commands instead of the commands is not a reproduction recipe. W05's coverage row said "focused `--coverage` runs over the producing files"; the two legs it silently omitted, the gate-script suites and the repo-rooted SDK invocation, are exactly the ones nobody would guess, and an independent validator could not rerun it. Write every leg, and note which legs exist for a reason that is not obvious.
- Coverage for a workspace package must be produced from the repository root. Run from inside the package and the emitted `SF:` paths are package-relative, so `merge-lcov.ts` cannot match them against a repo-relative changed-file list, and the patch gate reads a fully tested package as unmeasured.
- Disclose an ownership crossing even after you undo it. Taking another package's commit by cherry-pick can force you to carry a trimmed copy of files you do not own, which reads to a reviewer as an undeclared edit. Say so in the gate file, name the commits that bound the crossing, and show the diff against staging is empty once the merge repairs it.
- Two branches can each own a fixture identity in a shared unique index. W02's and W05's migration restart cases both used `restart-trust@example.test`, and the merged suite failed on `users_email_key` rather than on anything either branch tested. Give every restart fixture a package-scoped identity and an `ON CONFLICT DO NOTHING`.
- A `git diff --numstat` of `-` `-` does not prove your side is binary. It reports binary if EITHER blob is, so a file you repaired still shows dashes against the unrepaired parent. Check the blob itself for bytes below 32, or diff two copies of your own version.
- A source file with a raw NUL byte in a string literal reads as binary to `grep`, which then prints nothing and exits 1 instead of matching. `src/factory/archive-writer.ts:237` uses two literal NULs as a key separator, so every plain `grep` over it silently returns no hits and a reader concludes the symbol is absent. Use `grep -a`, and write the separator as `\0` so the file stays text.
- Probe the real object store before designing around what S3 "does". SeaweedFS returns a composite ETag and NO `ChecksumSHA256` at all for a multipart object, so neither is a content digest; it does honour `IfNoneMatch: "*"` on both a single put and a multipart completion, returns a `VersionId` from both, and lowercases user metadata keys. Three of those five facts changed the adapter's shape, and none of them is guessable.
- Pin a member's chunk count in the frozen request. `FactoryScopedArtifactReader` exposes `read` and `readChunk(index)` and nothing that reports how many chunks exist, so a consumer that streams must be told, or it discovers the end by provoking a denial.
- A test that drives a pinned request cannot vary the data behind it alone. Rewriting a reader's chunks to three while the request still pins two makes the provider read two and succeed, so the "overlong stream" case proved nothing until the request's own `chunkCount` moved with it.
- `merge-lcov.ts` globs from `process.cwd()`. An absolute pattern matches nothing and the script refuses to write rather than writing an empty report, which reads as a coverage failure. Copy the leg's lcov under the repo's gitignored `coverage/` and pass a relative glob.
- The local SeaweedFS stores have a fixed volume cap, and a SeaweedFS collection grows several volumes at a time. When uploads start failing with "failed to find writable volumes" while the host disk has space, check the master log for "only 0 volumes left" before suspecting the code; raise `-volume.max` in the compose profile and recreate the service (data volumes and credentials survive), and make S3 tests delete what they create.
- Never run destructive tooling against a shared test store (bulk deletes by time window across tenant buckets) without coordinator authorization, even to free capacity. Test cleanup deletes exactly the keys the test recorded creating; a validator found 212 versions deleted mid-validation by a window-based script.
