# Extension v4 contracts

This package owns data types and runtime validation. It does not import the host, database, or SDK. Legacy SDK types re-export these shared declarations.

`validateWire(kind, value)` checks the full data shape and rejects unknown fields. Use `validateManifest`, `validateWorkspaceFiles`, `validateResourceLimits`, and `validateInvocationContext` for their additional semantic checks. Validation does not grant permission or establish trust in build evidence. The host must compute and compare release digests itself.

`canonicalJson` and `sha256` provide one content digest format: sorted object keys, ordered arrays, and a lowercase SHA-256 hex string. Source maps are limited to 2,000 relative text files and 20 MiB of UTF-8 content. Empty workspaces are valid. Traversal, control characters, reserved keys, `.git`, and `node_modules` paths are forbidden.

Tool and runtime method schemas support object, array, string, number, boolean, and null types; required fields; bounds; enum/const; alternatives; and local named references. Schema size, depth, reference expansion, and alternatives are bounded. Recursive and remote references are rejected. Patterns use the linear-time RE2JS engine; backreferences and unsupported RE2 syntax are rejected. Input and output must be bounded JSON data. Schemas never coerce values or add defaults.

The checked `src/wire-schema.json` is generated from `src/types.ts`. Run `bun run schema:generate` after changing data types, then `bun run schema:check` and `bun run build`. CI must run the schema check.

Runner operations receive immutable file data and host-issued IDs, never host paths or raw container options. `RunnerExecution` uses bounded newline-delimited JSON-RPC. `extension/discover` returns metadata. `extension/invoke` accepts `{name,input,context}`; `extension/dispatch` accepts `{method,input,context}`. `extension/cancel` accepts `{invocationId}`. Reverse RPC carries `{context,input}`. The host must revalidate the context against its active invocation registry and approved release before every effect.
