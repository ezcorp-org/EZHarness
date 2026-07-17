---
name: ezcorp-agents
description: Use when listing agents, creating a new agent, updating or deleting an agent, configuring team membership with autoSpinUp, or using the multi-turn generate_agent wizard.
---

# EZCorp Agents

Agents are named, prompt-configured LLM personas stored as `agentConfig` records. They can be mentioned in chat, assigned tasks, or composed into teams.

## When to use

- You need to list available agents to pick one for a mention or task.
- You want to create a new agent (directly or via the wizard).
- You want to configure a team agent with `references.members` + `autoSpinUp`.
- You want to update or delete an existing agent config.

## Prereqs

```sh
export EZCORP_BASE_URL="http://localhost:5173"
export EZCORP_API_KEY="ezk_..."   # must have admin scope
```

MCP server registered: `bunx @ezcorp/ai-kit install claude-code`

## Recipes

### Discover installed extensions

Before adding an extension to an agent's `extensions[]`, search what the server has available (substring match on name/description; omit `query` to list everything):

```json
{ "tool": "extension_search", "arguments": { "query": "kanban" } }
```

Returns matching extensions with a curated `tools` list (`{ name, description }` only) per extension. The older `list_extensions` tool (no filter, full payload) still works but is deprecated — prefer `extension_search`.

### List agents

```json
{
  "tool": "list_agents",
  "arguments": {}
}
```

Returns `Array<{ id, name, description, category, model, provider }>`.

```sh
# curl fallback
curl -s -H "Authorization: Bearer $EZCORP_API_KEY" \
  "$EZCORP_BASE_URL/api/agent-configs" | jq '[.[] | {id, name}]'
```

### Get a single agent

```json
{
  "tool": "get_agent",
  "arguments": {
    "agentConfigId": "<uuid>"
  }
}
```

### Create an agent directly

```json
{
  "tool": "create_agent",
  "arguments": {
    "name": "TypeScript Reviewer",
    "prompt": "You are an expert TypeScript code reviewer. Focus on type safety, DRY violations, and edge cases. Be concise.",
    "description": "Reviews TypeScript code for quality and correctness",
    "category": "review",
    "model": "claude-sonnet-4-5",
    "outputFormat": "text"
  }
}
```

All fields in the schema: `name` (required), `prompt` (required), `description`, `capabilities[]`, `category`, `provider`, `model`, `temperature`, `maxTokens`, `outputFormat` (`"text"` | `"json"`), `extensions[]`, `references`.

### Create an agent via the generate wizard

The wizard is multi-turn: send a natural-language description, receive a draft, refine it.

**Turn 1 — describe the agent:**

```json
{
  "tool": "generate_agent",
  "arguments": {
    "messages": [
      {
        "role": "user",
        "content": "I need an agent that reviews pull requests for security issues, checks for hardcoded secrets, and suggests OWASP mitigations."
      }
    ]
  }
}
```

The response contains a `text` field with a narrative and (once ready) a `config` object with `name`, `description`, `prompt`, and model fields.

**Turn 2 — refine:**

```json
{
  "tool": "generate_agent",
  "arguments": {
    "messages": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "<previous response text>" },
      { "role": "user", "content": "Make the prompt more concise and add 'sast' to the category." }
    ]
  }
}
```

When `config` is non-null, pass it to `create_agent` to persist.

### Team agent with autoSpinUp

A "team" agent is a regular `agentConfig` whose `references` field lists member agents. Setting `autoSpinUp: true` pre-spawns all members in parallel before the orchestrator's first LLM turn.

```json
{
  "tool": "create_agent",
  "arguments": {
    "name": "Review Team",
    "prompt": "Coordinate the review team. Delegate security concerns to the security reviewer and style concerns to the style reviewer. Synthesise their outputs.",
    "references": {
      "autoSpinUp": true,
      "members": [
        { "agentConfigId": "<security-reviewer-uuid>" },
        { "agentConfigId": "<style-reviewer-uuid>", "overrides": { "model": "claude-haiku-4-5" } }
      ]
    }
  }
}
```

`references.members[].overrides` accepts any `createAgentInput` fields to override per-member at spawn time.

## Gotchas

- `admin` scope is required to create, update, or delete agents. `read` scope is enough for `list_agents` and `get_agent`.
- Agent names are not unique by default. Use `list_agents` to check for duplicates before creating.
- `generate_agent` returns a config wrapped in the response's `config` field — it does not auto-save. You must call `create_agent` with the returned config to persist it.
- `references.autoSpinUp: true` only has effect when the agent is mentioned as `![team:name]` in a message. It has no effect when the agent is mentioned as `![agent:name]`.
- `outputFormat: "json"` instructs the agent to always respond with valid JSON. Only set this if your downstream code parses the response.
