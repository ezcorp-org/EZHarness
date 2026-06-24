# Slash Commands

> _Reusable prompt templates addressable from any chat with `/name`: discovered from eight filesystem roots plus a per-user DB table, with `$ARGUMENTS`/`$N` substituted server-side into a body the LLM sees while the raw token is persisted._

## Intent

Slash commands let a user expand a saved prompt template inline by typing `/name`. EZCorp is wire-compatible with Claude Code's `.claude/commands/`, Codex CLI's `.codex/prompts/`, and a plain `agents/` convention, so an existing command library is picked up with no migration. Commands keep the chat composer terse (one token instead of a paragraph) while the substitution happens at stream time — the persisted message stays faithful to what the user typed, and the LLM sees the rendered body. Expansion is deliberately **literal**: a command body is never re-scanned for other mention sigils, which closes an indirect prompt-injection hole.

## How it works

The lifecycle splits into discovery (in the composer popover) and expansion (in the send pipeline). The two never share code beyond the `CommandRegistry` lookup and the `STRUCTURED_NAME_CHAR_CLASS` name grammar.

**Discovery / registry**

1. `createCommandRegistry` (`src/runtime/commands/registry.ts`) is built once at boot in `web/src/lib/server/context.ts` with `homePath: homedir()`, `scanHome` from `EZCORP_SCAN_GLOBAL_COMMANDS` (default on), and a `dbLister` that pulls `listUserCommands(userId)`.
2. `discoverProjectCommands` / `discoverHomeCommands` (`src/runtime/commands/discovery.ts`) walk eight roots — four project-scoped (`.claude/commands`, `.claude/agents`, `.codex/prompts`, `agents`) and four home-scoped (same four under `~`). Each root is one `CommandSource`. The home four are only scanned when `scanHome` is true.
3. The scanner reads `*.md` files, parses YAML-lite frontmatter via `parseCommandFile` (`src/runtime/commands/parser.ts`), and derives the command `name` from the filename stem (`review.md` → `review`). Per-user DB rows from the `user_commands` table become a ninth source, `user:db`.
4. Results are cached per `(userId, projectId)` with a 2 s TTL. `listCommands` returns **every** source (collisions stay visible, namespaced); `findCommand(name)` returns the first match in `PRECEDENCE` order (project sources beat home, home beats DB).
5. The composer popover hits `GET /api/mentions/search?type=cmd&q=…` (`web/src/routes/api/mentions/search/+server.ts`), which calls `registry.listCommands(...)`, fuzzy-ranks by name/description, and prepends the built-in `/goal` autopilot entry when `EZCORP_GOAL_ENABLED` is on. Selecting a registry command inserts a `/[cmd:name]` token; selecting `/goal` inserts literal `/goal ` text instead.

**Expansion**

6. On send, the message text is persisted with the raw `/[cmd:name]` token intact. `web/src/routes/api/conversations/[id]/messages/+server.ts` (and the team `agent-chat/+server.ts`) build a resolver via `buildCommandResolver(user.id, conv.projectId)` (`web/src/lib/server/command-resolver.ts`) and pass it as `commandResolver` into `executor.streamChat`.
7. Inside the prompt build (`src/runtime/stream-chat/build-prompt.ts`), after `![EZ:]` tokens are stripped, `applyCommandExpansion` (`src/runtime/mention-wiring.ts`) runs `parseMentions` on the **literal** text, replaces each `/[cmd:name]` token with the resolved body, and substitutes `$ARGUMENTS`/`$1..$N` from the free text following the token. Unknown commands are left verbatim and surfaced as a system note. A failure throws into a `try/catch` and is non-fatal — the original text is sent.
8. The rendered body is **never** re-parsed: any `![ext:…]`, `@[file:…]`, etc. inside a command body or inside user-supplied `$ARGUMENTS` stays literal text downstream (the anti-injection invariant).

## Usage

**Authoring on disk** — drop a markdown file under any scanned root, e.g. `<project>/.claude/commands/review.md`:

```markdown
---
description: Review staged changes
argument-hint: [area or file]
agent: code-reviewer
---
Review the following for bugs, style, and security: $ARGUMENTS
```

New / edited files are reflected within ~2 s (the registry TTL); no restart.

**Authoring in-app** — `GET/POST /api/user-commands` (list / create) and `GET/PATCH/DELETE /api/user-commands/[name]` (read / partial-update / delete) back a per-user DB source. The UI is at `web/src/routes/(app)/commands/` (`+page.svelte` list, `new/+page.svelte` create, `[name]/+page.svelte` edit) using `CommandForm.svelte`. `name` must match `^[a-z0-9][a-z0-9-_]{0,63}$`; `body` is capped at `COMMAND_BODY_MAX_BYTES` (64 KB → `413`); `frontmatter` is filtered to `{description, argument-hint, agent, model}`.

**Invoking** — type `/`, fuzzy-pick from the popover, then append arguments: `/review the auth middleware`. The composer stores `/[cmd:review]` on the wire and expands at stream time.

**Importing** — `POST /api/import/commit` can ingest discovered project commands into the per-user DB table (`createUserCommand`) via the import wizard.

**Substitution grammar** — `$ARGUMENTS` = the full inter-token args string (leading whitespace trimmed, trailing preserved); `$1..$N` = whitespace-split positional args (out-of-range → empty string). If the body references neither placeholder, the trailing args pass through as prose after the body (so `/a and /b` keeps the " and ").

**Env vars / settings**
- `EZCORP_SCAN_GLOBAL_COMMANDS` (default `"1"`, set `"0"` to disable) — gates home-dir (`~`) scanning. Multi-tenant deploys turn it off so one server process doesn't leak `~/.claude/` templates across users.
- `EZCORP_GOAL_ENABLED` (default on) — gates the built-in `/goal` popover entry (a separate text interceptor, not a registry command).

## Key files

- `src/runtime/commands/registry.ts` — `createCommandRegistry`: per-`(userId,projectId)` cache (2 s TTL), `listCommands` (all sources), `findCommand` (precedence-ordered), `invalidate`/`invalidateUser`.
- `src/runtime/commands/discovery.ts` — eight filesystem roots, `*.md` scan, realpath symlink-escape containment, `COMMAND_BODY_MAX_BYTES` (64 KB) + `COMMAND_COUNT_MAX` (500/scope) caps, `SKILL.md` exclusion.
- `src/runtime/commands/parser.ts` — `parseCommandFile`: hand-rolled YAML-lite frontmatter (flat string pairs); malformed input never throws (whole file → body).
- `src/runtime/mention-wiring.ts` — `applyCommandExpansion` / `expandCommandMentions` / `substituteArgs`: literal token expansion + `$ARGUMENTS`/`$N`; emits system notes for unknown commands and `agent:` routing hints.
- `src/runtime/stream-chat/build-prompt.ts` — calls `applyCommandExpansion` (post-EZ-strip) inside the prompt build; failure is non-fatal.
- `web/src/lib/server/command-resolver.ts` — `buildCommandResolver(userId, projectId)`: resolves project path, looks up the process-wide registry, adapts to `CommandResolver`.
- `web/src/lib/server/context.ts` — boot wiring of the registry (`scanHome`, `homePath`, `dbLister`); `getCommandRegistry` accessor.
- `web/src/routes/api/mentions/search/+server.ts` — `type=cmd` branch: registry list + fuzzy rank + built-in `/goal` injection.
- `web/src/routes/api/user-commands/+server.ts` — `GET`/`POST` DB-backed commands; byte cap; `invalidateUser` on create.
- `web/src/routes/api/user-commands/[name]/+server.ts` — `GET`/`PATCH`/`DELETE` one command (rename deferred); `invalidateUser` on mutation.
- `web/src/routes/api/user-commands/schema.ts` — `createUserCommandSchema`, `COMMAND_NAME_PATTERN`, `FRONTMATTER_KEYS`, `filterFrontmatter`.
- `web/src/lib/mention-logic.ts` — the `/` sigil parse (`cmd` kind) + `/[cmd:name]` tokenize used by the composer.
- `web/src/lib/components/CommandForm.svelte` + `web/src/routes/(app)/commands/**` — in-app CRUD UI.
- `web/src/routes/api/import/commit/+server.ts` — imports discovered project commands into `user_commands`.
- `src/db/schema.ts` — `userCommands` (`user_commands`) table: `name`, `description`, `body`, `frontmatter` JSONB, per-user (`on delete cascade`).

## Features it touches

- [[mention-grammar]] — `/` is one of the five composer sigils; commands share `parseMentions` and `STRUCTURED_NAME_CHAR_CLASS` with the others.
- [[goal-autopilot]] — `/goal` rides the same popover but is a server-side text interceptor, not a registry command; it inserts literal text and is gated by `EZCORP_GOAL_ENABLED`.
- [[streaming-runtime]] — expansion happens inside `build-prompt.ts` during `executor.streamChat`; the LLM sees the substituted body.
- [[conversations]] — the send pipeline (`messages/+server.ts`) builds the resolver and persists the raw token.
- [[agents]] — a command's `agent:` frontmatter is surfaced as a routing-hint system note; `agents/` and `.claude/agents/` roots double as agent sources.
- [[teams]] — the team `agent-chat/+server.ts` path also wires `buildCommandResolver` so team turns expand commands.
- [[feature-index]] — `$[feature:…]` expansion is the sibling pass in `mention-wiring.ts` (also literal, also persisted-token semantics).
- [[lessons]] — `%[lesson:…]` expansion is the other sibling pass in the same module, with per-turn caps.
- [[ez-concierge-and-actions]] — `![EZ:]` tokens are stripped before command expansion runs in `build-prompt.ts`.
- [[import]] — the import wizard ingests discovered project commands into the per-user DB source.
- [[projects]] — project-scoped roots are only scanned when chatting inside that project; the resolver maps `projectId` → on-disk path.
- [[builtin-file-tools]] — discovery shares the realpath symlink-escape predicate (`realpathInsideRoot`) with the `@`-file scanner.

## Related docs

- [slash-commands](../../slash-commands.md) — the full user-facing spec (roots table, frontmatter fields, precedence, examples). This page is the architectural companion.
- [mention-grammar](../../../CLAUDE.md) — composer sigil overview (note: CLAUDE.md's table predates the `%` and `![EZ:]` additions; code is authoritative).

## Notes & gotchas

- **Expansion is literal — never re-parsed.** `expandCommandMentions` slices args as the raw inter-token text and does **not** scan the rendered body (or user-supplied `$ARGUMENTS`) for further mention sigils. This is the core anti-injection guard: a command body containing `![ext:evil]` stays inert text. Don't "fix" this by recursing.
- **Raw token persisted, body sent.** The `messages` row keeps `/[cmd:name]`; only the LLM-facing variant is expanded. Edit/replay stays stable because the stored text is the source of truth. The composer renders the token as a pill via `MentionChip.svelte`.
- **2 s cache TTL + `invalidateUser`.** The popover keys its cache by the *active chat's* `projectId`, not `"global"`, so DB mutations call `invalidateUser(userId)` (drop every projectId entry for that user) — a single-key `invalidate` would miss in-project popover entries and leave them stale for up to 2 s. Filesystem edits are picked up only on the next TTL expiry, never push-invalidated.
- **`/goal` is not a registry command.** It's injected into the `type=cmd` search results separately and inserts **literal** `/goal ` text (a `/[cmd:goal]` token would never match `isGoalCommand()` in the messages interceptor). It's gated by `EZCORP_GOAL_ENABLED`, the same kill-switch the interceptor honors.
- **`SKILL.md` is excluded.** A `SKILL.md` marks a Claude skill bundle (owned by the import wizard), so the command walk skips it — otherwise an imported skill would double-import as a junk command named `SKILL`.
- **Discovery containment is realpath-based.** Every scanned file is resolved through `realpath` and must stay inside its configured root (`realpathInsideRoot`); symlinks escaping the scope are dropped. Per-scope caps (`COMMAND_COUNT_MAX = 500`) and a 64 KB body cap defend against an adversarial directory. Note the asymmetry with built-in file-tool path validation, which is lexical (`validatePath`) — discovery uses the stricter realpath check.
- **Frontmatter is a flat YAML subset.** `parseCommandFile` handles `key: value` lines between `---` fences only — no nested YAML, no lists. Malformed/unclosed frontmatter is treated as body (fail-soft) so one bad file can't poison a scan. The DB path mirrors this by filtering to `{description, argument-hint, agent, model}`; unknown keys are silently dropped (no `400`).
- **Rename is not supported in-app.** `PATCH /api/user-commands/[name]` updates body/description/frontmatter only; renaming a DB command is deferred (the UI hides the input). Filesystem commands are renamed by renaming the file.
- **Home scanning leaks across tenants if left on.** With `EZCORP_SCAN_GLOBAL_COMMANDS=1` (default) under a shared multi-user server process, all users see the same `~/.claude/` / `~/.codex/` / `~/agents/` templates. Multi-tenant deploys must set it to `"0"`.
