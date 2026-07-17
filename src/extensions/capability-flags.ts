/**
 * Kill-switch for the capability-tool tier (Phase 2+).
 *
 * When `EZCORP_DISABLE_CAPABILITY_TOOLS=1`, the capability
 * permissions (`taskEvents`, `loopEvents`, `spawnAgents`, `agentConfig`)
 * are ALWAYS treated as if the manifest didn't declare them. `clampToManifest`
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
  "loopEvents",
  "spawnAgents",
  "agentConfig",
  "eventSubscriptions",
  "webhooks",
] as const;

export type CapabilityPermissionField = typeof CAPABILITY_PERMISSION_FIELDS[number];

/**
 * The brokered-capability POLICY field names — each is a per-extension
 * policy object (`{quota, maxResults, providers, …}` for search;
 * analogous shapes for the others) whose before→after value is audited
 * via `CAPABILITY_POLICY_WRITE`. Distinct from
 * `CAPABILITY_PERMISSION_FIELDS` (the boolean-ish capability-tool tier):
 * these are the §3.1 three-state policy overrides
 * (`"inherit" | {…} | false`). `search` ships first; the rest are listed
 * so the audit + UI wiring is generic and they join with no rework.
 */
export const CAPABILITY_POLICY_FIELDS = [
  "search",
  "memory",
  "llm",
  "lessons",
  "schedule",
] as const;

export type CapabilityPolicyField = typeof CAPABILITY_POLICY_FIELDS[number];

/** True for the brokered-capability policy fields (search / memory / …). */
export function isCapabilityPolicyField(name: string): boolean {
  return (CAPABILITY_POLICY_FIELDS as readonly string[]).includes(name);
}
