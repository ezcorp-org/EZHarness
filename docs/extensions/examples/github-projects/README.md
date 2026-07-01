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
- **History** — terminal proposals, and
- **Connection health** — per board: state + last poll + last error, with a
  **Pause** / **Resume** toggle and a **Reconnect** hint.

It refreshes live via `pushPage` on the daemon's `github-projects:proposal-update`
event and on `task:assignment_update` / `run:complete`.

See [`knowledge/playbook.md`](./knowledge/playbook.md) for the agent playbook.
