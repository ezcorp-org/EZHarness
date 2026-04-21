---
name: ezcorp-projects
description: Use when listing EZCorp projects, creating a project, choosing between the global project and a named project, or any time a projectId is needed. Explains the "global" literal idiom.
---

# EZCorp Projects

Projects scope conversations and file-mention paths. The `"global"` literal is a special first-class project that is always available without a UUID.

## When to use

- You need a `projectId` to start a chat.
- You want to know which projects exist.
- You are unsure whether to use `"global"` or a real project UUID.
- You want to create a new project.

## Prereqs

```sh
export EZCORP_BASE_URL="http://localhost:5173"
export EZCORP_API_KEY="ezk_..."
```

MCP server registered: `bunx @ezcorp/ai-kit install claude-code`

## Recipes

### List all projects

```json
{
  "tool": "list_projects",
  "arguments": {}
}
```

Returns: `Array<{ id: string, name: string, path: string, icon?: string }>`.

```sh
# curl fallback
curl -s -H "Authorization: Bearer $EZCORP_API_KEY" \
  "$EZCORP_BASE_URL/api/projects" | jq '[.[] | {id, name}]'
```

### Use the global project

`"global"` is a string literal, not a UUID. Pass it directly wherever `projectId` is accepted:

```json
{
  "tool": "start_chat",
  "arguments": {
    "projectId": "global"
  }
}
```

The global project has no backing filesystem path, so `@[file:…]` and `@[dir:…]` mentions are unavailable in it.

### Create a project

```sh
curl -s -X POST \
  -H "Authorization: Bearer $EZCORP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-project","path":"/home/user/code/my-project"}' \
  "$EZCORP_BASE_URL/api/projects" | jq '{id, name}'
```

(No MCP tool for project creation — use curl or the EZCorp UI. After creation, `list_projects` returns the new UUID.)

## Global vs real project

| Criterion | `"global"` | Named project (UUID) |
|---|---|---|
| Always available | Yes | Must be created first |
| File/dir mentions | No | Yes (`@[file:…]`, `@[dir:…]`) |
| Best for | Quick chats, agent testing, cross-project tasks | Codebase-scoped work |

## Gotchas

- `projectId: "global"` is a literal string, not a UUID placeholder. Do not substitute a UUID for it.
- Passing an invalid UUID as `projectId` returns 400. Use `list_projects` to get valid IDs.
- Projects returned by `list_projects` include a `path` field. This path gates `@`-mention access: only files under `path` can be mentioned in conversations in that project.
