# markdown-utils Extension

A multi-component extension with formatting tools, a style guide skill, and a writing assistant agent. This example demonstrates the **multi-component pattern** (tools + skill + agent in one package) and the **persistent** flag.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/markdown-utils
```

## Manifest Walkthrough

### Multi-Component Pattern

This single extension provides three types of components:

1. **Tools** (`format-table`, `extract-headings`) - callable functions for markdown formatting
2. **Skill** (`markdown-style`) - a style guide that agents can reference
3. **Agent** - a markdown editing assistant that uses the tools and follows the skill guidelines

Bundling related components in one package means they share a single installation, permissions scope, and version.

### `persistent: true`

```json
"persistent": true
```

The extension process stays alive between tool calls instead of being spawned and terminated each time. Use persistent mode when:

- Tool calls are frequent and startup cost matters
- The extension maintains in-memory state (caches, indexes)
- The extension opens connections that are expensive to establish

For markdown-utils, persistence avoids repeated process startup when formatting multiple tables in a row.

### Tools

- **format-table** - Takes headers and rows arrays, outputs a properly aligned markdown table with padded columns
- **extract-headings** - Parses markdown text line-by-line and returns the heading hierarchy with levels, text, and line numbers

### Skill

The `markdown-style` skill provides inline content (no external files) with formatting guidelines. Agents in the system can reference this skill to produce consistent markdown output.

### Agent

The writing assistant agent uses the system prompt to help users restructure and improve markdown documents. It references the `markdown-style` skill guidelines.

## Testing

```bash
bun test docs/extensions/examples/markdown-utils/index.test.ts
```

Tests verify table formatting (alignment, empty rows, varying widths), heading extraction (all levels, empty input), and manifest structure validation.
