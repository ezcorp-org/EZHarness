# Canvas dock pending-hydration receipt

This receipt separates two cases found during the canvas-dock CI review.
The hosted failure refreshed tool history after the live completion; its mock
returned a static, non-persisting empty tool list. That is a fixture defect,
not evidence that a later authoritative response must retain an older call.

The controlled case below starts a tool-history request **before** the live
SSE events. Its held response has no live dock row. That ordering can happen
in the product and is the case covered by the revision boundary.

## Controlled red at the final integrated source

- Product source: `a4a4a9e1e60dc6456c7ab3267766121c7b24f340`.
- Source file SHA-256 before the fault:
  `dd16237d3195d4ccfda5cc14484e29c9bc34ecf0d56d45a0ef0be204176add82`.
  Test file SHA-256:
  `8e9410ce7b56e0dff5323733df48d6e6cf8ecefcb2c9df56ec85e858164486d5`.
- The locked Bash fault script replaced only the `newerLiveCalls` retention
  expression in `hydrateToolCalls` with an empty array. Its faulted source
  SHA-256 was
  `914c7ee8a4b945988ee6517bacc3264c778e9495b4649e34ca645c90ad9c02a4`.
  It left the loader and E2E test unchanged.
- Exact outer command:

  ```sh
  flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock /tmp/terra-ui-canvas-retention-fault.sh
  ```

  The script used pinned Bun `1.3.14` and Node `v22.22.2`, then ran:

  ```sh
  bunx playwright test --config playwright.config.ts --project=chromium e2e/canvas-dock-open-close.spec.ts --grep 'live SSE tool completion'
  ```

- Sequence: hold the first `messages?withToolCalls=true` response, emit
  `tool:start` and `tool:complete` for `tc-dock-live`, verify the dock,
  release the empty pre-event response, and first observe its visible orphan
  sentinel. The following `Preview controls` assertion failed because the
  fault removed the completed live call.
- The saved Playwright exit was `1`; the locked outer command also exited
  `1`. The exit trap restored the source to its original SHA-256 above before
  the script ended. The worktree has no deliberate fault change.
- Raw log: [fault red](raw/canvas-pending-hydration-fault-a4a4a9e1.log.gz),
  SHA-256 `73ea06d33940fa71a44a134010d7fe78fd4e23f692dc0c3fb88a6655a60afd0f`.

## Controlled green

- Product source: `169200cd0b4adffce3d311401d298d2672560998` adds a
  client-local live-update revision. The hydration request captures that
  revision before fetch; a response retains only absent same-conversation
  `agent-run` calls updated after that boundary. A later matching persisted
  row still replaces the streamed call.
- Test provenance: the uncommitted observation was committed unchanged as
  `701b64ed7b8912cfd28b95ad6407d7cc8ff1e6e0`, followed only by formatting
  commit `df156464ada7447cf1a0eccd19a1234d6cf5caf9`. Parent integrated the
  identical test as `16bcc363` and `a4a4a9e1`.
- Exact command:

  ```sh
  export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:/nix/store/vs03s8q30qg698zzpbszk08j4shb0gsl-nodejs-slim-22.22.2/bin:$PATH
  flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock bunx playwright test --config playwright.config.ts --project=chromium e2e/canvas-dock-open-close.spec.ts --grep 'live SSE tool completion' > /tmp/terra-ui-canvas-hydration-followup2-node22.log 2>&1
  ```

- Bun was `1.3.14`; Node was `v22.22.2`. Playwright reported `1 passed` in
  37.5 seconds. The outer tool wrapper did not retain a post-command exit
  marker, so this receipt claims the recorded Playwright result, not a shell
  exit code.
- Assertions first show that the held response applied through a visible
  orphan-tool sentinel, then require the live dock and desktop 640px padding
  to remain. A second, explicitly awaited `ez:agent_complete` refresh returns
  the matching persisted `tc-dock-live` row and another visible sentinel.
- Raw log: [green](raw/canvas-pending-hydration-green-169200cd.log.gz),
  SHA-256 `762b15bdaceacf7c70af113c9f548c34017489a0f5a78236400998b711dd0160`.

The focused green's source and test file hashes match the final `a4a4a9e1`
files listed above. Parent also ran the final visual mock lane at `a4a4a9e1`:
all 180 tests, including this live-dock test, passed.

The compressed logs contain no browser trace, session data, request bodies,
authorization headers, cookies, passwords, bearer tokens, or API-key labels.
