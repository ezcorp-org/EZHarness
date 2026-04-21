# code-review-delegator Extension

A tool extension that produces comprehensive code reviews by delegating to `project-analyzer` and `code-quality` via cross-extension invocation. This example demonstrates the **delegator pattern**, **multiple dependencies**, and **combining results from multiple extensions**.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/code-review-delegator
```

## Manifest Walkthrough

### Multiple Dependencies

```json
"dependencies": {
  "project-analyzer": {
    "source": "github:ezcorp/project-analyzer",
    "version": "^1.0.0"
  },
  "code-quality": {
    "source": "github:ezcorp/code-quality",
    "version": "^1.0.0"
  }
}
```

This extension depends on two other extensions. The platform resolves and installs the full dependency tree automatically.

### Agent Definition

The manifest includes an `agent` field that gives the LLM context about this extension's purpose. The agent can then intelligently decide when to call `reviewFile` during conversations.

### The Delegator Pattern

The `reviewFile` tool orchestrates a multi-step review:

1. Invokes `project-analyzer.readFile` via `ezcorp/invoke` to get file content
2. Invokes `code-quality.analyzeFile` via `ezcorp/invoke` to get quality issues
3. Combines both results into a comprehensive review object with summary, quality analysis, and recommendations

Each `ezcorp/invoke` call is a reverse RPC request -- the extension writes a request to stdout, the platform routes it to the target extension, and sends the result back on stdin.

## Tools

- **reviewFile** - Produces a comprehensive review by delegating to `project-analyzer.readFile` and `code-quality.analyzeFile`

## Testing

```bash
bun test docs/extensions/examples/code-review-delegator/index.test.ts
```

Tests replicate the review-building logic to verify output shape and recommendation generation without requiring cross-extension communication.
