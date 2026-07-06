# GitHub Projects playbook

This bundled extension links **one** GitHub Projects v2 board to the active
EZCorp project and lets an agent plan & execute its tickets. All GitHub network
I/O happens **host-side** — the sandboxed subprocess never holds a token, a
board id, or a GitHub host.

## One board per project

There is exactly one board per EZCorp project (the `github_projects_links` row
is `UNIQUE(project_id)`). Every tool — `list_tickets`, `create_ticket`,
`update_ticket`, `move_ticket`, `archive_ticket`, `add_comment` — operates on
*that* board automatically. The tools intentionally take **no** board id; the
host derives it from the conversation's project. You cannot reach another
project's board from a chat.

## Ticket identity

`list_tickets` returns each card's `itemNodeId` (an opaque GitHub Projects v2
node id, e.g. `PVTI_…`). Pass that exact value back to `update_ticket`,
`move_ticket`, `archive_ticket`, and `add_comment`. Never invent or guess a
node id.

## Drafts vs. real issues

`create_ticket` adds a **draft** card to the board (v1). A draft has no
repository issue, so:

- its `url` may be `null` until someone converts it to a real issue, and
- `add_comment` cannot comment on it (there is no issue to comment on).

When you create a ticket, tell the user it is a board draft, not a tracked
repository issue.

## Columns → plan / execute proposals

The board owner can wire individual **Status columns** to an action:

- `plan` — when a card enters the column, the system proposes a planning run.
- `execute` — proposes an execution run.

By default a column produces a **pending proposal** that the user approves on
the **GitHub Projects** Hub tab; a board may opt a column into auto-spawn.
`move_ticket` can therefore *queue* work rather than do it inline — surface that
to the user instead of assuming the move ran the work.

## The Hub dashboard

The **GitHub Projects** Hub tab shows, for the viewing user:

- **Active Work** — proposals in `pending` / `approved` / `spawned` / `running`,
  each with **Approve** / **Dismiss** buttons (pending only) and a link to the
  spawned conversation.
- **History** — terminal proposals (`done` / `failed` / `dismissed` /
  `cancelled`).
- **Connection Health** — per board: title, last poll, last error → a
  **Reconnect** hint, and a **Pause** / **Resume** toggle.

The page refreshes live as the host daemon polls the board and emits
`github-projects:proposal-update`.
