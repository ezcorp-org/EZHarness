# Example Extensions

Working examples that demonstrate EZCorp extension capabilities, from simple tools to multi-agent orchestration. Each example is a complete, installable extension with tests and documentation.

> **Data storage convention:** every example that writes persistent data stores it under `<projectRoot>/.ezcorp/extension-data/<extension-name>/`. See [../data-storage.md](../data-storage.md) for the full guide.

## Learning Path

Start simple and build up to composition patterns:

1. **[github-stats](github-stats/)** -- Network permissions, environment variables, resource limits
2. **[project-analyzer](project-analyzer/)** -- Filesystem/shell access, postinstall lifecycle script
3. **[markdown-utils](markdown-utils/)** -- Multi-component package (tools + skill + agent), persistent process
4. **[research-agent](research-agent/)** -- Agent-only manifest, model requirements, example conversations
5. **[code-quality](code-quality/)** -- Cross-extension composition via ezcorp/invoke, dependencies, preuninstall script
6. **[code-review-delegator](code-review-delegator/)** -- Delegator pattern, multiple dependencies, combining results
7. **[multi-agent-orchestrator](multi-agent-orchestrator/)** -- Forward-looking sub-agent manifest shape (runtime pending)

### Additional Examples

These examples demonstrate advanced input schema features (combo boxes, tag inputs, date filters, file path pickers) and real-world tool patterns:

8. **[file-refactor](file-refactor/)** -- File rename previews with convention selection (combo-box, tag-input)
9. **[log-analyzer](log-analyzer/)** -- Log file search with level and date filters (search, combo-box, date)
10. **[todo-tracker](todo-tracker/)** -- Scan for TODO/FIXME/HACK comments with priority and tag filters
11. **[task-stack](task-stack/)** -- Comprehensive task management (25 tools, filesystem access)
12. **[kokoro-tts](kokoro-tts/)** -- `messageToolbar` contribution + `appendMessages` reverse-RPC for in-browser TTS

## Feature Matrix

| Example | Tools | Skills | Agent | Scripts | Network | FS/Shell | Env | Dependencies | Persistent | Resources | SubAgents |
|---------|:-----:|:------:|:-----:|:-------:|:-------:|:--------:|:---:|:------------:|:----------:|:---------:|:---------:|
| github-stats | 3 | -- | -- | -- | Y | -- | Y | -- | -- | Y | -- |
| project-analyzer | 2 | -- | -- | postinstall | -- | Y | -- | -- | -- | -- | -- |
| markdown-utils | 2 | 1 | Y | -- | -- | -- | -- | -- | Y | -- | -- |
| research-agent | -- | -- | Y | -- | -- | -- | -- | -- | -- | -- | -- |
| code-quality | 2 | -- | -- | preuninstall | -- | -- | -- | 1 | -- | -- | -- |
| code-review-delegator | 1 | -- | Y | -- | -- | -- | -- | 2 | -- | -- | -- |
| multi-agent-orchestrator | -- | -- | Y | -- | -- | -- | -- | -- | -- | -- | Y |
| file-refactor | 1 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| log-analyzer | 1 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| todo-tracker | 1 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| task-stack | 25 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |

## Shared Variables

Extension tool schemas can use `x-shared` to auto-populate fields with contextual values. Fields with `x-shared` are pre-filled in the inline tool form and auto-injected server-side for agent-run calls. Users can still edit the pre-filled values.

### Available Variables

| Variable | Value | Example |
|----------|-------|---------|
| `project.cwd` | Current working directory | `/home/user/my-project` |
| `project.name` | Project directory name | `my-project` |

### Usage

Add `"x-shared"` to any string property in your tool's `inputSchema`:

```ts
inputSchema: {
  type: "object",
  properties: {
    sourcePath: {
      type: "string",
      description: "File or directory to analyze",
      "x-shared": "project.cwd",
    },
  },
}
```

## Quick Install

Install any example locally:

```bash
ezcorp ext install ./docs/extensions/examples/<name>
```

Run tests for an example:

```bash
bun test ./docs/extensions/examples/<name>/index.test.ts
```
