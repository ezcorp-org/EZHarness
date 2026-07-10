# code-quality Extension

A tool extension that performs static quality analysis on source files. Checks for complexity, long lines, and style problems. This example demonstrates **cross-extension composition** via `ezcorp/invoke`, **dependencies**, and **preuninstall lifecycle scripts**.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/code-quality
```

## Manifest Walkthrough

### Cross-Extension Composition

This extension depends on `project-analyzer` for file reading, invoking it via the `ezcorp/invoke` reverse RPC:

```typescript
const readRes = await invoke("project-analyzer.readFile", { path: filePath });
```

The `ezcorp/invoke` method routes the call through the platform to the target extension's subprocess. The caller never directly communicates with the dependency — the platform mediates all cross-extension calls.

### Dependencies

```json
"dependencies": {
  "project-analyzer": {
    "source": "github:ezcorp/project-analyzer",
    "version": "^1.0.0"
  }
}
```

Dependencies are auto-installed when this extension is installed. Cross-extension call depth is limited to 10 levels.

### Preuninstall Script

```json
"scripts": {
  "preuninstall": "./scripts/preuninstall.ts"
}
```

The `preuninstall` script runs before the extension is removed, allowing cleanup of cached data or external resources.

## Tools

- **analyzeFile** - Analyze a single source file for quality issues (complexity, style)
- **analyzeDirectory** - Analyze all source files in a directory and return an aggregate report

## Testing

```bash
bun test docs/extensions/examples/code-quality/index.test.ts
```
