/**
 * Kill-switch for the capability-tool tier (Phase 2+).
 *
 * When `EZCORP_DISABLE_CAPABILITY_TOOLS=1`, the three capability
 * permissions (`taskEvents`, `spawnAgents`, `agentConfig`) are ALWAYS
 * treated as if the manifest didn't declare them. `clampToManifest`
 * drops them, bundled install refuses to grant them, and runtime
 * handlers (Phase 2b+) gate on this before doing anything else.
 *
 * Rationale: if any capability-tool handler regresses in production,
 * operators need a way to disable the tier without a code deploy or
 * schema change. The flag is ignored when unset so existing
 * deployments see no behavior change.
 *
 * The flag does NOT remove the permissions from the manifest schema —
 * a manifest can still declare them, they just won't be enforced.
 * This preserves install compatibility across deploys where the flag
 * is toggled.
 */
export function capabilityToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EZCORP_DISABLE_CAPABILITY_TOOLS"] === "1";
}

/** The capability-tier permission field names. */
export const CAPABILITY_PERMISSION_FIELDS = [
  "taskEvents",
  "spawnAgents",
  "agentConfig",
  "eventSubscriptions",
] as const;

export type CapabilityPermissionField = typeof CAPABILITY_PERMISSION_FIELDS[number];
