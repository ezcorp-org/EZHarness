# Simple in-app pull requests from a private sandbox

Status: implementation plan, 2026-09-22. No product code changes. Read with the [personal GitHub connection plan](2026-09-22-user-github-connections-for-prs.md).

## Decision and scope

A user connects GitHub once at **Settings → GitHub**. A run in that user's private sandbox can prepare a draft pull request for a selected GitHub repository and base. The user reviews the frozen changes in chat and confirms publication. The trusted host uses only that user's connection for the exact operation. Other users, including application admins and project members, cannot use the connection or read, change, export, or publish the private sandbox. A host operator who controls the host and encryption key remains inside the trusted boundary.

V1 supports one approved repository and base per private sandbox work unit, host-brokered import into an empty sandbox, a bounded immutable export, and one draft PR. A work unit has one owner and one conversation. Its later runs may build on earlier edits in that conversation; a snapshot at the latest completed run contains the cumulative change from the imported base. A different conversation cannot use the work unit. Account authorization and repository installation are separate. A connected account may still need repository access. The connection gives no general authenticated `git`, `gh`, or HTTP inside the sandbox. No reusable GitHub token enters the sandbox, model, or browser. A local host workspace or shared project workspace does not qualify.

Personal PRs have their own publication guarantees. Factory's release branch and actor rules remain separate. Reuse one host publisher with explicit personal and Factory authorization adapters. Ship the personal path against its own verified policy; keep Factory's stronger contract until separately proven.

## End-user journey

1. The user opens a private sandbox, selects an approved GitHub repository and base, and starts a run. If needed, the card takes the user through **Connect GitHub**, repository installation or organization approval, then returns to the same run.
2. The host imports that exact base into the owner's empty sandbox through a reviewed provider operation. The run edits and checks it.
3. At run completion, the host freezes a verified export. Chat shows **PR ready**, file count, check result, and **Review & create draft PR**. No GitHub write has occurred.
4. The existing Diff summary panel shows the exact frozen files, repository, base, checks, and editable title and body. The user selects **Create draft PR**.
5. The host rechecks ownership, connection generation, repository access, base, and snapshot identity, then publishes once. The card becomes **PR #123 created** and keeps the URL after reload.

Render the card from durable run state. An optional built-in `prepare_pull_request` tool accepts only title and body and can request the same card; model prose is never evidence that a run is eligible. No branch name, patch file, token, or shell command is required from the user. Keep advanced fields behind **More options**; v1 always creates a draft.

## Current code and the gap

- Normal chat has `edit_file` and `shell`, but no built-in PR action. The chat header has a Diff summary action.
- `src/extensions/project-open-pr.ts` expects a local `projectRoot`, copies its full tracked diff and untracked files, then commits, pushes, and calls `gh pr create`. `src/extensions/project-pr-broker.ts` gets a project credential. These cannot serve a personal sandbox run as written and can include another run's files.
- `src/runtime/sandbox/controller/controller.ts` creates an empty sandbox and rejects `sourceProjectId`. It records `sandbox_provider_bindings.owner_id`, but its status gate checks project membership. Method admission checks conversation ownership when provided, and native workspace execution checks conversation ownership plus binding revision. Project membership does not make a workspace private.
- `src/runtime/workspace/target.ts` gives sandbox targets a binding ID, project ID, and revision, **no host filesystem root**. The current provider file methods are bounded per call, not an atomic whole-tree export.
- `src/extensions/project-pull-request-broker.ts` has proposal digest, expiry, recheck, and durable decision patterns. Its existing proposal table is extension-specific.

Do not attach a PR button to the current shared checkout or infer a host path from `/workspace`.

## Required boundaries

### Private workspace and repository import

Require the same stored EZHarness user ID for connection owner, initiating run owner, conversation owner, sandbox binding owner, proposal owner, and confirming session. Pin the work unit to its first owner conversation before admitting a write run; subsequent reads, writes, exports, and proposals require that conversation. Check owner identity on **every** private workspace read, write, status, lifecycle, method admission, execution, import, export, proposal read, and publish route. An application admin, project owner, service principal, or other project member gets no override. Keep project membership as an additional condition. Derive identity from session and stored records, never a request-supplied owner ID. Bind operations to the current project workspace binding ID and revision, provider installation/release/generation, sandbox resource row and provider resource ID. A replaced binding or recreated resource invalidates the work unit.

Implement a host-brokered **Import approved repository** operation. Its input is the authenticated user's selected repository ID and base ref from a server-approved destination. Resolve the exact base commit on GitHub with that user's connection. Verify both user permission and App installation access. The host fetches only that repository/base into private staging with bounded bytes, files, time, and output. Admit a provider import into a newly created or verified empty owner resource, with a manifest of relative paths, modes, sizes, and content hashes. This is one controlled operation, not guest `git clone`; do not pass credentials, credential helper configuration, or an authenticated remote into the guest. Persist repository ID, base ref and SHA, import digest, sandbox identity, and run ID before editing. If import is uncertain or partial, mark the resource unavailable until reconciliation or disposal; never call a partial tree ready.

The provider must apply the import atomically or prove rollback. Reject symlinks, submodules, `.git`, `.ezcorp`, device files, path traversal, duplicate or case-colliding paths, unsupported modes, and oversized or unsupported repositories in v1, with a clear UI result. Empty repositories or unresolved bases cannot start a PR run. Import must not copy from another member's project. Host staging stays private and short lived.

### Freeze an exact run snapshot

At run completion, stop new writes to that run's workspace, settle active writer leases and processes, and request one reviewed **Export snapshot** provider operation. The provider returns a bounded archive or content-addressed stream plus manifest, not a path for the host to open. Bind request and receipt to owner, run, project, workspace binding and revision, provider generation, resource incarnation, repository ID, base SHA, and operation ID. The host enforces total bytes, file count, path length, per-file bytes, time, and decompression limits while streaming. It independently parses the archive, canonicalizes and hashes the whole tree, verifies every manifest entry and byte count, and rejects duplicate names, traversal, links, special files, `.git`, `.ezcorp`, and unexpected metadata. Provider hashes alone are insufficient.

Compare the validated tree with the imported base on the host. Store immutable content or a private content-addressed artifact with canonical tree digest, changed paths/statuses, blob hashes, line counts, and check receipts. Include additions, modifications, and deletions, including edits from earlier runs in the same conversation. Support renames only when the resulting tree is proved. Include binary files only when bytes and review display are bounded. No-change and unsupported-file cases get explicit states. Later sandbox edits require a **new** snapshot and proposal; they cannot alter the reviewed artifact. Do not re-export on confirmation.

The provider boundary is an implementation prerequisite: current per-file methods and process shell are not a whole-tree snapshot. Add a reviewed import/export capability and receipt with a stable resource incarnation, or prove an equivalent atomic provider operation. A sequence of `listFiles`/`readFile` calls without a frozen tree is insufficient.

### Review and bind the proposal

Use one durable state machine for API and UI: `working → ready → reviewing → creating → created`, with `no_changes`, `blocked`, `stale`, and `failed` recovery states. `blocked` explains connection, repository installation or organization approval, permission, unsupported repository, or unavailable private sandbox. `stale` means an identity, permission, base, snapshot, or proposal field changed. `failed` includes an uncertain external result and a recovery action. Reopening chat restores state.

The proposal is host-created and immutable except for an explicit new review revision when the user edits title or body. Bind its digest to tenant, owner, conversation, run, project, sandbox binding, workspace revision, provider generation, resource incarnation, repository ID, base ref and SHA, import digest, frozen tree digest and artifact ID, check receipts, title/body digest, and **connection authorization generation**. Ordinary token refresh does not change that generation; disconnect, replacement, or reconnect does. A proposal from before reconnect cannot be reused, even for the same GitHub account. Expire proposals after 24 hours and never revive one.

The Diff summary panel displays exact included files, checks and receipts, repository, base, and editable title/body. Keep **Create draft PR** as the only primary action. Do not add file checkboxes in v1. The server derives repository, base, paths, and artifact from the proposal; the browser submits only proposal ID, expected digest or revision, edited text if any, and idempotency key. The signed-in owner confirms the final digest. No GitHub write occurs during preparation or review.

### Publish and recover through one host service

Extract hardened Git checks and GitHub transport from `src/extensions/project-open-pr.ts` into a publisher that consumes a **validated immutable artifact**, approved repository and base, and explicit host-only credential resolver. The personal adapter resolves only the proposal owner's current connection; the Factory adapter retains separate approved tenant authority. Neither falls back to the other. The publisher stages the frozen tree against the recorded base commit in a private host workspace and verifies its digest again before commit. It never inspects mutable sandbox or shared checkout during publication. Preserve exact origin validation, local Git config rejection, disabled hooks, filters, credential helpers, redirects, and signing, bounded commands/output, safe branch names, and platform-path rejection.

Before each external effect, atomically claim the operation and recheck signed-in user and all ownership and identity bindings; current connection generation; current repository ID and App installation/user permissions; and recorded base. Reject an advanced base; the user must make a new import, run, and review. Coordinate the claim with disconnect durably: disconnect blocks effects not yet dispatched, but cannot recall a GitHub request already sent. Use the host-only token for the exact push and PR API calls. Verify endpoint permissions and branch policy with a disposable private GitHub repository before enabling v1.

Persist operation ID and generated branch before dispatch. After timeout, lost response, crash, or disconnect after dispatch, reconcile the exact branch and matching PR read-only. Resume only when remote head equals expected commit and the PR matches repository, base, head, actor mode, and operation record. A conflicting branch or unknown result stays blocked for review. Repeated confirmation and refresh return the same operation; never mint a second branch or PR through a blind retry. Store completed PR URL and provider receipt durably.

## Implementation seams and order

1. Enforce owner-only access in `src/runtime/sandbox/controller/controller.ts` and native workspace dispatch. Check status and all direct methods, not only publication. Mark private workspace policy in persisted bindings so shared workspaces cannot qualify.
2. Add host-brokered repository/base resolution and staged import, plus atomic or provably frozen provider import/export contract. Extend local Podman provider and controller only through reviewed operations with bounded receipts. Prove a private repository reaches an empty owner sandbox without a credential inside it.
3. Freeze and validate a run snapshot at the provider boundary. Persist immutable artifact and run linkage, with independent digest and run-scoped check receipts.
4. Extract one host publisher from `src/extensions/project-open-pr.ts`. Personal and extension/Factory adapters supply distinct authorization and credential resolution; share publication and reconciliation logic.
5. Add built-in durable proposal routes and `prepare_pull_request`, register each new `/api/*` route in `src/api-registry.ts`, then add PR card and Diff summary review. Keep normal chat proposals out of the extension-only decision table.
6. Wire Settings → GitHub recovery back to the same review and test the full journey. Show installation pending, repository not enabled, reconnect required, and insufficient user permission as distinct states.

The matching [connection plan](2026-09-22-user-github-connections-for-prs.md) owns OAuth, encrypted token storage, connection generation, and Settings. This plan owns private run import/export, snapshot, proposal, publisher, and chat review. Keep credential and publisher interfaces small so neither plan duplicates GitHub effect code.

## Required verification and acceptance

Start with the end-user failure in a real authenticated browser: ask the assistant to change a file and open a PR. Connect A's account once; select a private test repository/base; import it to A's empty sandbox; run a controlled edit and checks; review frozen diff; create a draft through a fake GitHub server; reload and see the same PR URL. Run a live disposable-repository proof of user-token branch creation and draft PR under chosen ruleset before enablement. GitHub documents separate [authorization and installation](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps); its [create-ref](https://docs.github.com/en/rest/git/refs) and [create-PR](https://docs.github.com/en/rest/pulls/pulls) endpoints document Contents write and Pull requests write respectively. Confirm the full endpoint set used by implementation at that time.

Automated acceptance must show:

- A and B share a project. B, an app admin, and a service principal cannot inspect A's private workspace/status, invoke methods against it, import/export it, view A's proposal, confirm it, or use A's connection. A can use one connection across two of A's private projects. Missing owner data denies access.
- Main-checkout tracked and untracked changes, another conversation, and another run's substituted archive cannot enter A's artifact. Later runs in the same pinned conversation intentionally build on earlier edits, but each completed run has a new snapshot and review. Replaced binding, new resource incarnation, changed provider generation, or stale workspace revision fails before review or publication.
- Import fails closed on partial or uncertain transfer and unsupported Git contents. Export fails closed on tampered manifest or bytes, archive bombs, duplicate/traversal/case-colliding names, symlinks, special files, `.git`, `.ezcorp`, oversized content, and write racing export. Test new, modified, deleted, renamed, and binary files within supported limits.
- No changes, missing installation, organization approval pending, insufficient permission, disconnected or reconnected account, changed base, expired proposal, changed title/body, and later sandbox edits show correct recoverable states. A late callback or refresh cannot resurrect a disconnected generation.
- Push followed by failed PR creation, lost response, concurrent confirmations, browser reload, and disconnect after dispatch produce at most one branch and one draft PR. Reconcile by exact remote commit; conflicting branch refuses automatic repair.
- UI works on desktop and mobile with keyboard focus, accessible names, long paths, and an `@evidence` Playwright spec that calls `captureEvidence(page, testInfo, label)`. New source and changed lines meet coverage gates. Run required typecheck, lint, backend/web tests, coverage, and relevant E2E lanes on implementation revision.

Acceptance is a draft PR whose exact frozen tree came from the confirming user's private sandbox run, with no reusable credential in the guest and no cross-user path to that workspace or connection.
