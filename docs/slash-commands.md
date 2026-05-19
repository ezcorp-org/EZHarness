# Slash Commands

Reusable prompt templates addressable from any chat window with `/name`.
Compatible with Claude Code's `.claude/commands/`, Codex CLI's
`.codex/prompts/`, and a plain `agents/` convention — so if you've
already built up a slash-command library with another tool, EZCorp picks
it up automatically.

## Quick start

1. Drop a markdown file into `<project>/.claude/commands/review.md`:

   ```markdown
   ---
   description: Review staged changes
   argument-hint: [area or file]
   ---
   Review the following for bugs, style, and security: $ARGUMENTS
   ```

2. Open any chat, type `/rev`, pick **/review** from the popover.
3. Append arguments and hit Enter: `/review the auth middleware`.

No restart required — new files are picked up within ~2 seconds.

## Where commands live

EZCorp scans eight roots. The first four are **project-scoped** (shown
only when you're chatting inside that project); the last four are
**global** (available from every chat, including global-context chats).

| Root | Scope | Origin |
|---|---|---|
| `<project>/.claude/commands/` | Project | Claude Code |
| `<project>/.claude/agents/` | Project | Claude Code |
| `<project>/.codex/prompts/` | Project | OpenAI Codex CLI |
| `<project>/agents/` | Project | Generic |
| `~/.claude/commands/` | Global | Claude Code |
| `~/.claude/agents/` | Global | Claude Code |
| `~/.codex/prompts/` | Global | OpenAI Codex CLI |
| `~/agents/` | Global | Generic |

Plus a **per-user DB table** (`user_commands`) for commands you create
through the app — these show as `Global · Saved` in the popover.

Each row in the popover displays a pink **scope · folder** badge so you
can tell at a glance which file (or database) a command came from.
Commands with identical names in different roots coexist — the popover
shows both with distinct badges.

## File format

```markdown
---
description: Short one-line summary shown in the popover
argument-hint: [how to call this]        # optional
model: claude-opus-4-7                   # optional — hint only
agent: reviewer                          # optional — routing (see below)
---
The prompt body. Any text here gets expanded into the chat
message the LLM sees. Reference args with $ARGUMENTS or $1, $2, ...
```

All frontmatter keys except the opening/closing `---` lines are
optional. A body-only file with no frontmatter is valid too — the
description just won't appear in the popover row.

### Argument substitution

| Placeholder | Replaced with |
|---|---|
| `$ARGUMENTS` | All text between the command token and the next command / end of message, with leading whitespace trimmed |
| `$1`, `$2`, `$N` | The Nth whitespace-separated word of `$ARGUMENTS`. Missing positions render as empty string. |

Examples:

| You type | Body | LLM receives |
|---|---|---|
| `/commit fix the auth bug` on body `Commit: $ARGUMENTS` | ... | `Commit: fix the auth bug` |
| `/open src/app.ts 42` on body `Open $1 at line $2` | ... | `Open src/app.ts at line 42` |
| `/greet` on body `Hi $ARGUMENTS!` | ... | `Hi !` |

If the body uses neither `$ARGUMENTS` nor any `$N`, the text following
the command passes through as-is — so `/a and /b` with two arg-free
commands keeps the `" and "` between them intact.

### Frontmatter `agent:`

When set, a system note is prepended to the expanded prompt advising
the LLM which sub-agent the user wanted this command to run as. This
is advisory — it doesn't bypass your agent configuration.

## Grammar and tokens

Typing `/name` opens the popover with fuzzy type-ahead. Selecting a
command inserts a structured token:

```
/[cmd:review]
```

This mirrors the existing `!` mention grammar (for agents, extensions,
teams) and `@` mention grammar (for files and directories):

| Sigil | Purpose | Token example |
|---|---|---|
| `!` | Agent / extension / team | `![agent:reviewer]`, `![ext:formatter]`, `![team:qa]` |
| `@` | Project file / directory | `@[file:src/app.ts]`, `@[dir:src/]` |
| `/` | Slash command | `/[cmd:review]` |

The three sigils never conflict — a command, agent, and file can all
share the same name and the popover disambiguates them by section.

## Expansion semantics

**Persisted** conversation history stores the raw `/[cmd:name]` token,
so editing or re-running a message retains the original intent.

**Sent to the LLM**: the body is substituted once, as literal text.
EZCorp never re-parses the expanded text for other mention tokens, so
a command body containing `![ext:evil]` appears to the model as plain
characters and cannot wire an extension. This is deliberate — command
authors are trusted, but user-supplied `$ARGUMENTS` are not.

## Creating commands through the app

The per-user DB-backed source lets you create commands without
filesystem access. Commands created this way are scoped to your user
account and available across every project you visit.

Navigate to **/commands** (Build → Commands in the sidebar). The page
lists every personal command you've authored and offers:

- **+ New Command** to create one with the full-frontmatter editor
  (name, description, argument-hint, agent, model, body).
- **Edit** on each card to update body / description / frontmatter.
  Rename in place is deferred to v1.5 — delete + recreate to change
  the name.
- **Delete** with a confirm dialog. The command disappears from the
  list and from the `/` popover within ~2 s (registry cache TTL).

**Auto-suffix on name conflict.** Posting a name that's already taken
(by another of your saved commands) returns the same row saved as
`name-2`, `name-3`, … (smallest free suffix). The UI surfaces this as
a toast (`Saved as "review-2" — "review" already exists`) so you
always know the canonical name. Filesystem collisions are unchanged:
the registry shows them with separate source badges and the popover
disambiguates by `source` namespace.

### REST API

The same surface is exposed under `/api/user-commands`:

| Method | Path                          | Body                                    | Response                  |
| ------ | ----------------------------- | --------------------------------------- | ------------------------- |
| GET    | `/api/user-commands`          | —                                       | `200` row[]               |
| POST   | `/api/user-commands`          | `{ name, body, description?, frontmatter? }` | `201` row (may differ on rename) |
| GET    | `/api/user-commands/[name]`   | —                                       | `200` row / `404`         |
| PATCH  | `/api/user-commands/[name]`   | `{ body?, description?, frontmatter? }` | `200` row / `404`         |
| DELETE | `/api/user-commands/[name]`   | —                                       | `204` / `404`             |

Validation: `name` matches `/^[a-z0-9][a-z0-9-_]{0,63}$/`, `body` is
capped at `COMMAND_BODY_MAX_BYTES` (64 KB; over → `413`), and
`frontmatter` is filtered to the well-known keys `description`,
`argument-hint`, `agent`, `model` (unknown keys are silently
dropped). Every successful mutation invalidates the command registry
cache so the next `/` popover keystroke reflects the change.

## Hot reload

The command registry caches filesystem scans for 2 seconds per
`(userId, projectId)` pair. Dropping a new `.md` file makes it appear
within that window — no server restart.

For instant pickup during development, set the cache TTL to 0 in
`src/runtime/commands/registry.ts` (via the `cacheTtlMs` config
option) — at the cost of one filesystem walk per popover keystroke.

You can also force an invalidation from server code with
`registry.invalidate({ userId, projectId })`.

## Multi-tenant deployments

The global (`~/.*`) discovery scans the **server process's home
directory**, not individual users' homes. In a shared EZCorp instance
this means every user sees the same global commands, and anyone with
write access to that home can inject prompt templates into every
user's chats.

Disable global scanning for multi-tenant deploys:

```sh
EZCORP_SCAN_GLOBAL_COMMANDS=0
```

With the flag off, commands are discovered only from the active
project's folders and the per-user DB table.

## Sample fixtures

The repo ships a `TESTENV/` directory (gitignored) seeded with 10
commands exercising all four project roots plus every substitution
mode. Point a test project at `TESTENV/` to exercise the feature:

```
TESTENV/
├── .claude/
│   ├── commands/            # /review, /commit, /fix, /explain
│   └── agents/              # /reviewer, /planner
├── .codex/
│   └── prompts/             # /explain, /refactor, /tests
└── agents/                  # /summarize, /deploy
```

Two commands named `/explain` live in different roots so you can see
the collision preservation + source-badge behavior in the popover.

## Troubleshooting

**Commands don't appear in the popover:**
- Verify the file extension is `.md`.
- Confirm the folder matches one of the eight roots exactly (names are
  case-sensitive).
- Check for symlinks that escape the project root — those are
  rejected for safety.
- Files over 64 KB are skipped.
- Each root is capped at 500 entries.

**A command expands to the raw token instead of the body:**
- The command name couldn't be resolved — check the popover for
  typos, and confirm the file's stem matches what you typed.
- The system-note pre-amble will explain which command was unknown.

**Home-dir commands don't appear:**
- Check `EZCORP_SCAN_GLOBAL_COMMANDS` — if set to `0`, global
  discovery is disabled.
