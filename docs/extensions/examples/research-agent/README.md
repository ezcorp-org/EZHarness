# research-agent Extension

An agent-only extension that defines an AI research assistant. This example demonstrates the **agent-only pattern** (no entrypoint), **modelRequirements**, **temperature tuning**, and **exampleConversations**.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/research-agent
```

## Manifest Walkthrough

### Agent-Only Pattern

This extension has no `entrypoint` and no `tools` array. It defines only an `agent` component. The platform uses the agent definition to configure an LLM-powered assistant -- no subprocess is spawned.

### `agent.prompt`

The system prompt tells the agent how to behave: break topics into sections, cite sources, distinguish facts from speculation, and suggest follow-up questions.

### `agent.modelRequirements`

```json
"modelRequirements": { "tier": "balanced", "contextWindow": 32000 }
```

- **tier** - Tells the platform what model capability level is needed. `"balanced"` requests a mid-range model (not the cheapest, not the most expensive).
- **contextWindow** - The minimum context window size in tokens. Research tasks often involve long outputs, so 32K is requested.

### `agent.temperature`

```json
"temperature": 0.3
```

Lower temperature (0.0-1.0) produces more focused, factual responses. For research, lower is better since accuracy matters more than creativity.

### `agent.exampleConversations`

Two example conversations show the agent's expected behavior:
1. A technology overview (WebAssembly adoption)
2. A comparative analysis (SQLite vs PostgreSQL)

Example conversations serve two purposes:
- They help users understand what the agent does before trying it
- The platform can use them for few-shot prompting to improve response quality

## Testing

```bash
bun test docs/extensions/examples/research-agent/index.test.ts
```

Tests validate the manifest structure: schema version, agent fields, model requirements, and that example conversations have proper user/assistant turn structure.
