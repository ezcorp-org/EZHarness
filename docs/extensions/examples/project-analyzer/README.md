# project-analyzer Extension

A tool extension that reads and lists project files. This example demonstrates **filesystem permissions**, **shell access**, and **lifecycle scripts**.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/project-analyzer
```

## Manifest Walkthrough

### `permissions.filesystem`

```json
"filesystem": ["$CWD"]
```

The extension can only read files within the user's current working directory. `$CWD` is a platform variable that resolves at runtime. Any attempt to access files outside this directory is blocked.

### `permissions.shell`

```json
"shell": true
```

The extension uses `Bun.$` to run shell commands (like `ls`) for listing files. Shell permission must be explicitly declared and granted at install time.

### `scripts.postinstall`

```json
"scripts": { "postinstall": "./scripts/postinstall.ts" }
```

The `postinstall` script runs once after installation. In this example it creates a default `.project-analyzer-config` file. Lifecycle scripts are useful for first-time setup, cache warming, or migration tasks.

### Tools

- **listFiles** - Lists files matching an optional glob pattern using shell commands
- **readFile** - Reads a file's contents, with path validation to ensure it stays within the project directory

## Path Validation

The `readFile` tool resolves and normalizes the requested path, then checks that it falls under `$CWD`. This prevents directory traversal attacks (e.g., `../../etc/passwd`).

## Testing

```bash
bun test docs/extensions/examples/project-analyzer/index.test.ts
```

Tests verify path validation logic, manifest structure, tool schemas, and that the postinstall script exists.
