// @ezcorp/sdk — public barrel.
// Runtime helpers ship under `@ezcorp/sdk/runtime` (separate entry point).

export * from "./types";
export { defineExtension } from "./define";
// Pure extension scaffolder — used by the `bun run ext:init` CLI and the
// bundled `extension-author` extension. Returns a file map; callers
// write to disk (or to a draft dir) themselves.
export { scaffoldExtension, EXT_TYPES, type ExtType, type ScaffoldOptions, type ScaffoldResult } from "./scaffold";
