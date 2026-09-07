# multi-agent-orchestrator Extension

A manifest-only extension that declares a planning agent persona. It is useful
when an extension needs instructions and model requirements but has no tools or
subprocess entrypoint.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/multi-agent-orchestrator
```

## Manifest Walkthrough

### Agent Definition

The top-level `agent` defines the extension's planning persona. Its prompt,
category, capabilities, and model requirements guide the host when it selects
the extension for a conversation.

### No Entrypoint

This extension has no `entrypoint` field. The agent declaration is consumed by
the host; there is no extension subprocess to spawn.

## Testing

```bash
bun test docs/extensions/examples/multi-agent-orchestrator/index.test.ts
```

Tests validate the supported manifest structure: schema version, agent field,
empty permissions, and no entrypoint.
