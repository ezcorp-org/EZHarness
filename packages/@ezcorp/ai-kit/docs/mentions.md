# Mention Grammar — Normative Specification

The chat composer supports three mention sigils. This document is the normative reference. The grammar table in [`/home/dev/work/ez-corp-ai/CLAUDE.md`](/home/dev/work/ez-corp-ai/CLAUDE.md) is the authoritative cross-project summary; this file expands on behaviour and constraints.

The authoritative parser lives at:
`/home/dev/work/ez-corp-ai/src/runtime/mention-wiring.ts`
`/home/dev/work/ez-corp-ai/web/src/lib/mention-logic.ts` (pure-logic module, no UI deps)

---

## Sigils and Token Forms

| Sigil | Kind(s) | Token format | Resolved by |
|---|---|---|---|
| `!` | `agent` | `![agent:Name]` | DB `agentConfigs` table, matched by `name` |
| `!` | `team` | `![team:Name]` | DB `agentConfigs` where `category = "team"` |
| `!` | `ext` | `![ext:Name]` | DB `extensions` table, matched by `name` |
| `@` | `file` | `@[file:rel/path.ts]` | Active project's filesystem (symlink-escape filtered) |
| `@` | `dir` | `@[dir:rel/path]` | Active project's filesystem |
| `/` | `cmd` | `/[cmd:name]` | `.claude/{commands,agents}`, `.codex/prompts`, `agents/` dirs + `user_commands` DB table |

---

## Token Format (Regex)

```
![agent:Name]   ![ext:Name]   ![team:Name]
@[file:relative/path.ts]
@[dir:relative/path]
/[cmd:name]
```

The master regex (from `mention-logic.ts`):

```
/!\[(agent|ext|team):([^\]]+)\]|@\[(file|dir):([^\]]+)\]|\/\[(cmd):([^\]]+)\]/g
```

Tokens are **case-sensitive** for kind labels (`agent`, `ext`, `team`, `file`, `dir`, `cmd`). The `name` portion is matched against the DB or filesystem case-insensitively where applicable.

---

## Persistence and Expansion

**Persisted** form: the raw token string (e.g. `/[cmd:daily-standup]`).

**LLM-visible** form: expanded. Slash commands are substituted with their body text before the LLM sees the message (see `applyCommandExpansion` in `mention-wiring.ts`). Agent and extension tokens are resolved server-side to wire tools; the LLM sees a system note, not the raw token.

**Expansion is literal**: the rendered command body is never re-parsed for further mention tokens. This prevents indirect prompt injection where a command body contains `![ext:evil]`.

---

## `!` Sigil — Logical Mentions

### `![agent:Name]`

Triggers `invoke_agent` for the named agent config. Spawns a sub-conversation with `parentConversationId` set to the caller's conversation. Multiple agent mentions in one message are dispatched concurrently.

The agent's configured extensions are automatically wired into the conversation when the mention is resolved.

### `![team:Name]`

Resolves the team config and its `references.members` list. If `references.autoSpinUp` is `true`, all member agents are spawned in parallel before the orchestrator's first LLM turn. If `false`, the orchestrator invokes members individually via tool calls.

### `![ext:Name]`

Wires the named extension's tools into the conversation for the duration of the thread. The extension does not get its own sub-conversation.

---

## `@` Sigil — Path Mentions

References a file or directory relative to the active project's `path`. Absolute paths (`/etc/…`) and path traversal (`../../…`) are rejected silently.

- `@[file:src/app.ts]` — agent should read the file.
- `@[dir:src/components]` — agent may list files in the directory or treat it as a target for new files.

Path mentions generate a system note prepended to the agent's context. The file content is not embedded automatically — the agent uses its `readFile`/`listFiles` tools to load on demand.

---

## `/` Sigil — Slash Commands

Slash-command discovery is gated by `EZCORP_SCAN_GLOBAL_COMMANDS` (default: on).

Sources scanned (in order, project then home):
1. `.claude/commands/` and `.claude/agents/`
2. `.codex/prompts/`
3. `agents/`
4. `user_commands` DB table

`$ARGUMENTS` and positional `$1`…`$N` in the command body are substituted from the text that follows the token in the message. Inter-token text that does not contain `$ARGUMENTS` is passed through untouched.

Unknown commands are left as literal text with a system note: `Unknown slash command: /name — token left as literal text.`

---

## Mention Search API

`GET /api/mentions/search?q=<query>&type=<kind>&projectId=<id>`

`type` values: `agent`, `team`, `ext`, `path` (returns both `file` and `dir` entries), `cmd`.

Returns an array of `{ kind, name, ... }` objects suitable for popover display.

---

## Autocomplete Trigger Detection

The composer fires autocomplete when the user types one of these patterns at a word boundary:

| Input | Popover opened |
|---|---|
| `!` | agent / ext / team picker |
| `!agent:` | agent-only picker |
| `!ext:` | extension-only picker |
| `!team:` | team-only picker |
| `@` | file + directory picker |
| `/` | slash-command picker |

Pressing space or Escape dismisses the popover without inserting a token.
