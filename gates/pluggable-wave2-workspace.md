# Gates: workspace routing wave 2

- [x] W1: A checked inventory covers Git, PR, preview, attachments, workflows, child agents and project MCP.
- [x] W2: Implemented project-bound paths carry the exact workspace target across process boundaries.
- [x] W3: Missing or failed sandbox routing cannot read, write or execute against the AMD checkout.
- [x] W4: Local-project compatibility and focused production-path tests pass.

Inventory: `docs/plans/2026-09-22-workspace-routing-inventory.md`.

Implemented in this wave:

- Live turn, workflow, nested workflow, assignment, code-agent, and child-agent
  propagation keeps the exact `WorkspaceTarget`.
- Assignment reverse RPC carries the explicit host target. A caller-supplied
  parent run ID cannot select another run's target.
- Built-in workspace tools and code-agent providers use the sandbox backend.
- Project Git uses the sandbox shell backend. Open-PR and project MCP paths
  fail closed because this wave has no valid guest placement for them.
- Durable PR review proposals store the serializable target reference. Observe
  compares it with the caller target and authorizes the stored scope. A
  sandbox proposal is rejected before any local project access.
- Local targets retain their prior host-root behavior.

Inventoried for later waves:

- Controller/provider target construction and durable run target rehydration.
- Guest preview process, port, and static-file transport.
- Attachment storage placement and transfer.
- File mentions, feature scans, extension filesystem routes, import/install
  roots, and arbitrary subprocess project-root metadata.

Verification with Bun 1.3.14:

- `bun test --timeout 30000 ./src/runtime/workspaces/target.test.ts ./src/runtime/workspaces/propagation.test.ts ./src/extensions/__tests__/project-git-broker.test.ts ./src/extensions/__tests__/project-pr-broker.test.ts ./src/extensions/__tests__/project-pull-request-broker.test.ts ./src/extensions/__tests__/tool-executor.project-root-meta.test.ts ./src/__tests__/workflow-tool-step.test.ts ./src/__tests__/run-workflow-wired-into-setup.test.ts ./src/__tests__/start-assignment-plumbing.test.ts ./src/__tests__/orchestration-host.test.ts`
  passed: 214 tests, 0 failures, 789 expectations. This includes exact host
  target forwarding, forged parent-run isolation, durable proposal target
  matching, and all existing assignment-cycle regressions.
- `bun run typecheck` passed after the shared `ToolExecutor.setWorkspaceTarget`
  seam was implemented: backend, web, backend tests, and web E2E types are
  clean.
- Direct Biome checks passed for all changed workspace, runtime, broker, and
  test files. `git diff --check` passed.
