# Lessons

- Describe a raw entrypoint subprocess as a process, not an installed immutable release.
- In asynchronous delivery tests, await an observed operation or use transport ordering. Do not use a fixed sleep as proof of completion.
- When proving that asynchronous work did not happen, capture and await every operation started by the trigger. Waiting only for the expected positive callback cannot prove the denied phase is complete.
- A denied-path test needs a controlled fault that removes the protection and makes the test fail.

## Validation discipline

- Select gpt-5.6-sol explicitly with fresh bounded briefs when the user requests a Sol team. Use distinct ownership and worktrees.
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

- Match the required image format before certifying a production build. Inspect build warnings and the resulting health-check configuration; a successful boot verifier does not prove packaging preserved it.

- A gated security test must run the production context and descriptor plumbing, and assert child exit and observed effect before checking audit records. Opening a filter file proves neither attachment nor enforcement.
- Verify parser cursor claims with actual compiled output before changing production code. An expected denied call must agree with the declared profile; a permitted call cannot prove a deny boundary.
