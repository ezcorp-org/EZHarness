---
name: ezcorp-auth
description: Use when authenticating with EZCorp, getting an API key, setting up credentials, or troubleshooting "unauthorized" errors. Covers session cookies vs API keys and scope semantics.
---

# EZCorp Auth

Two credential types exist: session cookies (browser-only) and API keys (all programmatic access). The MCP server and extension always use API keys.

## When to use

- You need to set up `EZCORP_BASE_URL` / `EZCORP_API_KEY` for the first time.
- You are hitting 401 / 403 responses from the API.
- You need to understand which scopes (`read`, `write`, `chat`, `extensions`, `admin`) to request.

## Prereqs

```sh
export EZCORP_BASE_URL="http://localhost:5173"   # or your deployed instance
export EZCORP_API_KEY="ezk_..."                  # generated below
```

MCP server registered:
```sh
bunx @ezcorp/ai-kit install claude-code
```

## Generating an API key

1. Open EZCorp in a browser and sign in.
2. Navigate to **Settings → Developer → API Keys → New Key**.
3. Choose scopes. **They are FLAT — none includes another.** Pick every scope
   you need; holding one grants nothing about the rest:
   - `read` — list and fetch projects, agents, memories, messages. Never modifies.
   - `write` — create, update and DELETE your memories, projects, lessons,
     contexts and knowledge-base files.
   - `chat` — start conversations, send messages, run workflows and EZ actions.
   - `extensions` — wire extensions to a conversation and invoke their tools.
   - `admin` — instance settings, users/teams, MCP servers, extension
     lifecycle. Also needs an admin-ROLE key (`--role admin`); the scope alone
     is refused.

   A key that both reads and manages your own data needs `read,write`. The CLI
   mints `read,write,chat` when `--scopes` is omitted.
4. Copy the key immediately (shown once). Prefix is `ezk_`.

## Recipes

### Verify credentials with MCP

```json
{
  "tool": "list_projects",
  "arguments": {}
}
```

Expected: array of `{ id, name, path }` objects. A 401 means the key is wrong or expired. A 403 means the key's scope is too narrow for the operation you attempted.

### Verify with curl

```sh
curl -s -H "Authorization: Bearer $EZCORP_API_KEY" \
  "$EZCORP_BASE_URL/api/projects" | jq '.[].name'
```

## Gotchas

- API keys are bearer tokens sent in the `Authorization: Bearer <key>` header. The MCP server injects this automatically from `EZCORP_API_KEY`.
- Session cookies work in the browser only; they cannot be used with the MCP server or CLI.
- **Scopes do not nest.** A `chat`-only key gets 403 on `list_projects` — `chat`
  does not include `read`. Likewise `admin` grants none of the others. Ask for
  each scope you need, explicitly.
- `read`-scoped keys will succeed on `list_projects` and `list_agents` but return 403 on `start_chat` or `send_message`. Request `chat` scope for any conversational use.
- Creating a project, saving a memory, or deleting a lesson needs `write`.
  Until 2026-08 these took `read`, so a key described as read-only could delete
  the owner's data; existing keys were granted `write` automatically by a
  migration, so nothing had to be re-issued.
- `admin` scope covers instance settings, users/teams and extension lifecycle —
  NOT project creation (that is `write`) and not agent authoring alone. An
  `admin` scope must be paired with an admin-ROLE key to reach those routes.
- Rotating a key invalidates the old one immediately. Update `EZCORP_API_KEY` in your shell and in any MCP config files after rotation.
