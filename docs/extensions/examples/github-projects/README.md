# github-projects

A bundled EZCorp extension that connects **one or more GitHub Projects v2
boards per project** and lets an agent plan & execute their tickets, with a
live Hub dashboard for the board-triggered proposal queue and connection
health.

## Security model

All GitHub network I/O is **host-side**. The sandboxed subprocess:

- never holds a GitHub token,
- never sees a board / project id, and
- has **no** `network` / `shell` / `env` permission.

Every LLM-callable tool emits a **reverse-RPC intent** that carries only its own
params (a title, a body, an `itemNodeId`, …). The host handler
(`src/extensions/github-projects-handler.ts`):

1. derives the `projectId` from the **calling conversation** (never from
   params — the confused-deputy fix),
2. resolves WHICH board from the project's `github_projects_links` rows (a
   project may link many boards): the proposal that spawned the conversation
   pins its board; otherwise the project's sole board is used; multiple
   boards with no spawning proposal are **refused as ambiguous**,
3. resolves the host-only GitHub token (decrypted PAT or `gh auth token`), and
4. calls the host GitHub client.

The handler is **bundled-only**: it allowlists this extension by **name**
(`BUNDLED_GITHUB_PROJECTS_ALLOWLIST`), independent of any manifest a
user-installed look-alike might declare.

## Tools (thin intents)

| Tool | Reverse-RPC verb | Notes |
|---|---|---|
| `list_tickets` | `ezcorp/github-projects.list` | filter by Status column |
| `create_ticket` | `ezcorp/github-projects.create` | creates a board **draft** (url may be null) |
| `update_ticket` | `ezcorp/github-projects.update` | edit title/body |
| `move_ticket` | `ezcorp/github-projects.move` | change Status column |
| `archive_ticket` | `ezcorp/github-projects.archive` | remove from active board |
| `add_comment` | `ezcorp/github-projects.comment` | real issues only |

## Hub dashboard

The **GitHub Projects** Hub tab (`/hub/ext:github-projects:dashboard`) shows the
viewing user's:

- **Active work** — `pending` / `approved` / `spawned` / `running` proposals,
  with **Approve** / **Dismiss** on pending rows and conversation links on
  running ones,
- **History** — terminal (`done` / `failed` / `dismissed` / `cancelled`)
  proposals, each with a **Re-run** button, and
- **Connection health** — per board: state + last poll + last error, with a
  **Pause** / **Resume** toggle and a **Reconnect** hint.

It refreshes live via `pushPage` on the daemon's `github-projects:proposal-update`
event and on `task:assignment_update` / `run:complete`.

## Proposal lifecycle

- **Re-triggering.** A card triggers a proposal when it enters a mapped Status
  column. The guard is **one active proposal per card**, not once-ever: a partial
  unique index (`idx_gh_proposals_active_item` over `(link_id, item_node_id)`
  WHERE status is active) means a card with a `pending` / `approved` / `spawned` /
  `running` proposal can never gain a second (even by moving to a different mapped
  column mid-run), while a card whose proposal reached a **terminal** state is
  free to re-trigger if it re-enters a mapped column. `dedupe_key` is retained as
  a provenance column only.
- **Re-run.** The **Re-run** button on a terminal History row creates a fresh
  `pending` proposal for the same card via the normal approval gate (auto-spawn
  columns still auto-spawn). It is refused if the card already has an active
  proposal (the single-active guard) and requires the `approve-runs` RBAC scope.
- **Boot reconciliation.** Run-lifecycle listeners are in-memory, so a process
  restart mid-run would strand a proposal in `spawned` / `running` forever
  (permanently consuming a concurrency-cap slot). At startup — before the daemon
  begins polling — `reconcileOrphanedProposals` flips every `spawned` / `running`
  proposal to `failed` (`error: "Interrupted by restart"`), posts a best-effort
  ticket comment pointing at **Re-run**, and leaves `pending` rows untouched. The
  user then decides: **Re-run** the ticket, or open the linked chat to continue.

## Permissions (RBAC)

Board actions are gated by per-project, per-extension RBAC scopes (admins hold all
implicitly): `use` (view the Hub, poll-now), `configure` (connect / edit boards),
`secrets` (store the PAT), `approve-runs` (Approve / Dismiss / Re-run), and the
custom `write-tickets` scope for the agent's ticket-mutation tools. Grants are
managed at **Settings → Permissions**. See
[[rbac-and-permission-modes]].

See [`knowledge/playbook.md`](./knowledge/playbook.md) for the agent playbook.
