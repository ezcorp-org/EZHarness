// Legacy host-side shim — re-exports types from the SDK.
// Kept so in-tree host code that already imports from `./sdk/types` keeps
// resolving while we migrate callers to `@ezcorp/sdk` directly.
export type * from "@ezcorp/sdk";
