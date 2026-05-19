# multi-agent-orchestrator Extension

A manifest-only extension that documents the intended shape for multi-agent orchestration. This example demonstrates **sub-agent definitions**, **explicit tool scoping per sub-agent**, and **pipeline-based delegation**.

> **Note:** Runtime support for sub-agent orchestration is coming in a future release. This example documents the intended manifest shape.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/multi-agent-orchestrator
```

## Manifest Walkthrough

### Agent Definition

The top-level `agent` defines the orchestrator -- the coordinating agent that delegates work to sub-agents.

### `subAgents`

```json
"subAgents": [
  {
    "name": "planner",
    "prompt": "Break down complex tasks into ordered steps...",
    "tools": ["project-analyzer.listFiles"]
  },
  {
    "name": "executor",
    "prompt": "Execute implementation steps precisely...",
    "tools": ["code-quality.analyzeFile", "project-analyzer.readFile"]
  }
]
```

Each sub-agent has:
- **name** - Unique identifier within this extension
- **prompt** - System prompt defining the sub-agent's role
- **tools** - Explicitly scoped list of tools this sub-agent can access (fully qualified as `package.tool`)

### Pipeline vs Tool-Based Delegation

This manifest uses a **pipeline** pattern: the planner analyzes first, then the executor implements. Each sub-agent has access only to the tools it needs -- the planner can list files but not modify them, while the executor can read and analyze but relies on the planner's output for direction.

This is different from tool-based delegation where a single agent has access to all tools. Explicit tool scoping per sub-agent enforces separation of concerns at the manifest level.

### No Entrypoint

This extension has no `entrypoint` field. The orchestrator and sub-agents are defined entirely in the manifest -- the platform handles spawning, routing, and tool access at runtime.

## Testing

```bash
bun test docs/extensions/examples/multi-agent-orchestrator/index.test.ts
```

Tests validate the manifest structure: schema version, agent/subAgents fields, tool scoping per sub-agent.
