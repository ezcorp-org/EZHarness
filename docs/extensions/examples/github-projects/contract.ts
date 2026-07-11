// github-projects — the jail-readable slice of the FROZEN shared contract.
//
// WHY THIS FILE EXISTS (issue #60): the extension subprocess runs under the
// landlock/bwrap sandbox, which grants file-READ only to the extension's own
// dir (this dir), the preload dir, and `node_modules`/`packages` — the project
// root is TRAVERSE-only. A runtime-VALUE import from `src/**` (Bun can't elide
// it) therefore dies at module-load with `EACCES reading .../src/...`. So the
// constants + status type the SANDBOXED code needs live HERE, inside the
// extension's own (jailed-readable) dir.
//
// `src/integrations/github-projects/types.ts` RE-EXPORTS everything below, so
// every host/web/test importer of those symbols keeps working unchanged (the
// host runs UNJAILED — reading this dir is fine). Host-only interfaces stay in
// types.ts; only the ext-facing surface lives here.
//
// Keep this file free of any `src/**` import (that would reintroduce the bug).

/** Lifecycle of a proposal (the queue unit). */
export type GithubProposalStatus =
  | "pending"
  | "approved"
  | "spawned"
  | "running"
  | "done"
  | "failed"
  | "dismissed"
  | "cancelled";

/**
 * Reverse-RPC method-name prefix. The sandbox extension's ticket tools emit
 * `${GITHUB_PROJECTS_RPC_PREFIX}<verb>`; the host handler matches on it and
 * derives the board from the conversation (params NEVER carry a board id).
 */
export const GITHUB_PROJECTS_RPC_PREFIX = "ezcorp/github-projects." as const;

/** The single runtime event name registered in runtime-event-names.ts. */
export const GITHUB_PROJECTS_EVENT = "github-projects:proposal-update" as const;

/** Proposal statuses considered "active work" (Hub Active section). */
export const GITHUB_ACTIVE_STATUSES: readonly GithubProposalStatus[] = [
  "pending",
  "approved",
  "spawned",
  "running",
] as const;

/** Proposal statuses considered terminal (Hub History section). */
export const GITHUB_TERMINAL_STATUSES: readonly GithubProposalStatus[] = [
  "done",
  "failed",
  "dismissed",
  "cancelled",
] as const;
