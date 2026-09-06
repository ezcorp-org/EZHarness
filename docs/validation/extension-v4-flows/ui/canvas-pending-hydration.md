# Canvas dock pending-hydration receipt

This receipt separates two cases found during the canvas-dock CI review.
The hosted failure refreshed tool history after the live completion; its mock
returned a static, non-persisting empty tool list. That is a fixture defect,
not evidence that a later authoritative response must retain an older call.

The controlled case below starts a tool-history request **before** the live
SSE events. Its held response has no live dock row. That ordering can happen
in the product and is the case covered by the revision boundary.

## Controlled red

- Provenance: red started at 14:11 EDT from the working tree before source
  commit `da1cc299` and test commit `cbaa5089`; those later commits are the
  closest recoverable source and test snapshots. The exact uncommitted tree
  and shell command were not retained, so this receipt does not assign either
  SHA as an exact red product snapshot or invent a shell exit code.
- Runner evidence: local Chromium with `playwright.config.ts`, one canvas
  test. The raw runner result is `1 failed`.
- Sequence: hold the first `messages?withToolCalls=true` response, emit
  `tool:start` and `tool:complete` for `tc-dock-live`, verify the dock, then
  release the empty pre-event response.
- Failed assertion: `Preview controls` was no longer visible after release.
  This proves the pre-event response replaced the completed live call.
- Raw log: [red](raw/canvas-pending-hydration-red-pre-da1cc299.log.gz),
  SHA-256 `b021894141b4061bf984d7c77a3f7bec0e35e96f48ff2b4aee77a896134c4fa6`.

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

The compressed logs contain no browser trace, session data, request bodies,
authorization headers, cookies, passwords, bearer tokens, or API-key labels.
