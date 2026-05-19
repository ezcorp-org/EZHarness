# @ezcorp/ai-kit

One package that teaches any LLM how to drive the EZCorp backend — start chats, orchestrate agents and teams, fan out to multiple chats in parallel — with four surfaces sharing one source of truth:

| Surface | For | Entry |
|---|---|---|
| **MCP server** | Claude Code, Cursor, Zed, Windsurf, any MCP client | `bunx @ezcorp/ai-kit mcp` (stdio) or `/api/mcp` (HTTP) |
| **Claude Code skills** | Claude Code users who want copy-paste recipes | `skills/ezcorp-*/SKILL.md` |
| **EZCorp extension** | In-app agents orchestrating sibling chats | `ezcorp.config.ts` (schemaVersion 2) |
| **Docs (`llms.txt` + OpenAPI)** | Any LLM given static context | `docs/` |

## Install

```sh
# Claude Code (MCP server + skills) — user-scoped
bunx @ezcorp/ai-kit install claude-code

# Cursor / Zed / Windsurf (MCP server)
bunx @ezcorp/ai-kit install cursor

# EZCorp (load as an extension in a project)
bunx @ezcorp/ai-kit install ezcorp --project <path>

# Verify everything
bunx @ezcorp/ai-kit doctor
```

## What it exposes

Seven capability groups — see `docs/OVERVIEW.md` for the conceptual model.

- **Discover** projects, agents, extensions, models.
- **Start a chat** (any project, incl. `global`).
- **Send messages** with `!`/`@`/`/` mentions.
- **Stream** run events (tokens, tool calls, agent spawns).
- **Author agents** (direct create or the multi-turn `generate` wizard).
- **Fan out from one chat** — parallel `![agent:…]`, `![team:…]`, task assignments, or batch `spawn_chats` for root-level independent chats.
- **Mention autocomplete**.

## Auth

Set `EZCORP_BASE_URL` (default `http://localhost:5173`) and `EZCORP_API_KEY` (from EZCorp → Settings → Developer). The MCP server and extension read both from env.

## Entity links in tool responses

Every tool that produces or touches a user-visible entity — `start_chat`,
`send_message`, `create_agent`, `spawn_chats`, `start_assignment`, etc. —
returns a clickable `url` (and a pre-formatted `markdownLink`) alongside the
raw IDs. An LLM that simply echoes a tool result into chat therefore gives
the user a one-click jump to the new conversation, agent, or run.

URLs are built from a separate `publicUrl`, resolved in order:

1. `publicUrl` option on `new EzcorpClient({ publicUrl: "…" })`
2. `EZCORP_PUBLIC_URL` env var
3. `EZCORP_BASE_URL` (fallback — suitable only for local dev)

For cross-domain hosting (e.g. the MCP subprocess talks to the API on
`http://localhost:5173` but users live on `https://ezcorp.example.com`),
set `EZCORP_PUBLIC_URL=https://ezcorp.example.com` on the server once —
the bundled ai-kit MCP picks it up automatically for every tool call.

## Layout

```
packages/@ezcorp/ai-kit/
  docs/            # Tier 1 — llms.txt discovery, openapi.yaml, overview, mentions, events
  skills/          # Tier 2 — Claude Code SKILL.md per capability
  src/
    client.ts      # Shared HTTP + SSE client
    types.ts       # zod schemas mirroring web/src/routes/api/**
    mcp/           # Tier 3 — stdio + HTTP MCP server, tool implementations
    cli/           # install + doctor
  ezcorp.config.ts # Tier 4 — EZCorp extension manifest
  test/            # unit / integration / e2e (100% coverage gate)
```

Single source of truth: `test/shape.test.ts` enforces that every capability appears in the OpenAPI spec, a skill, an MCP tool, and the extension manifest — drift fails the build.
