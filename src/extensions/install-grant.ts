/**
 * Local-install permission grant construction.
 *
 * Extracted from `src/cli.ts` (B2 fix). The old inline `buildFullPermissions`
 * copied ONLY `network`/`filesystem`/`shell`/`env` from the manifest, silently
 * DROPPING every other declared capability — `storage`, `spawnAgents`,
 * `eventSubscriptions`, `schedule`, `taskEvents`, `agentConfig`, and the
 * Phase-51 capability surfaces. A local (`is_bundled=false`) install therefore
 * came up half-granted (dashboard render failed "Storage permission not
 * granted"; `init_gate` failed "ezcorp:events:subscribe capability missing"),
 * while BUNDLED installs — which pass a hand-written FULL `ExtensionPermissions`
 * object through `intersectPermissions` — worked.
 *
 * This module makes a local "grant all requested permissions" install persist
 * EVERY manifest-declared capability, matching the bundled path. It leans on
 * the canonical `clampExtensionPermissions` for the classic + Phase-51 surfaces
 * (so the numeric clamps / kill-switch stay in one place) and then re-attaches
 * `eventSubscriptions` from the manifest verbatim — see the note on
 * `applyDeclaredEventSubscriptions` for why the clamp alone is insufficient.
 */
import { clampExtensionPermissions } from "./clamp-permissions";
import { capabilityToolsDisabled } from "./capability-flags";
import { getRequiredPermissions } from "./permissions";
import type { ExtensionManifestV2, ExtensionPermissions } from "./types";
import { askLine } from "../ui/prompt";

/** The permission keys carried on an `ExtensionPermissions` grant (everything
 *  except the `grantedAt` timestamp map). Kept explicit so `stampGrantedAt`
 *  never accidentally stamps `grantedAt` itself. */
const GRANT_PERMISSION_KEYS = [
  "network",
  "filesystem",
  "shell",
  "env",
  "storage",
  "taskEvents",
  "spawnAgents",
  "agentConfig",
  "eventSubscriptions",
  "llm",
  "memory",
  "lessons",
  "schedule",
  "search",
  "acceptsCallerCaps",
  "escalateChildCaps",
] as const satisfies readonly (keyof Omit<ExtensionPermissions, "grantedAt">)[];

/** Stamp `grantedAt[key] = now` for every permission field present on the
 *  grant. `search` is a valid grant even when `false`, so presence is tested
 *  with `!== undefined` rather than truthiness. */
export function stampGrantedAt(granted: ExtensionPermissions, now: number): void {
  for (const key of GRANT_PERMISSION_KEYS) {
    if (granted[key] !== undefined) granted.grantedAt[key] = now;
  }
}

/** Normalize a manifest `eventSubscriptions` declaration (array form OR the
 *  Phase-51.4 `{events, includeFullPayload}` object form) to a plain
 *  `string[]`. Mirrors the private helper in `clamp-permissions.ts`. */
function normalizeDeclaredEvents(
  field: ExtensionManifestV2["permissions"]["eventSubscriptions"],
): string[] | undefined {
  if (Array.isArray(field)) return field;
  if (field && typeof field === "object" && Array.isArray(field.events)) return field.events;
  return undefined;
}

/**
 * Re-attach the manifest's declared `eventSubscriptions` to a grant.
 *
 * WHY this is separate from `clampExtensionPermissions`: that clamp filters
 * `eventSubscriptions` down to the `DIRECT_CARRIER_EVENT_TYPES` allow-list — a
 * fixed set of PLATFORM runtime events (e.g. `run:complete`,
 * `task:assignment_update`). An extension's OWN custom event names
 * (`ez-code-factory:push-received`, `kokoro-tts:speak`, …) are NOT in that set,
 * so the clamp DROPS them entirely — which is exactly the missing
 * `ezcorp:events:subscribe` capability that broke `init_gate`. Those custom
 * names are validated by `validateManifestV2` at install time AND
 * re-validated per-namespace by the event dispatcher at `registerExtension`
 * (an event whose namespace ≠ the extension's own name is refused there), so
 * granting them verbatim is safe and matches the bundled install path, which
 * uses `intersectPermissions` (no direct-carrier filter).
 *
 * Fail-closed on the capability kill-switch: when capability tools are
 * disabled, no event subscription is granted.
 */
function applyDeclaredEventSubscriptions(
  grant: ExtensionPermissions,
  manifest: ExtensionManifestV2,
  now: number,
): void {
  if (capabilityToolsDisabled()) {
    delete grant.eventSubscriptions;
    delete grant.grantedAt.eventSubscriptions;
    return;
  }
  const events = normalizeDeclaredEvents(manifest.permissions?.eventSubscriptions);
  if (events && events.length > 0) {
    grant.eventSubscriptions = [...events];
    grant.grantedAt.eventSubscriptions = now;
  }
}

/**
 * Build the FULL granted-permission set for an auto-approved / "grant all"
 * local install: grant every capability the manifest declares, clamped to the
 * manifest ceiling (the same clamp the `/api/extensions/[id]/permissions`
 * endpoint uses), plus the extension's own custom `eventSubscriptions`. Each
 * surviving grant is stamped with `now`.
 */
export function buildFullGrantFromManifest(
  manifest: ExtensionManifestV2,
  now: number = Date.now(),
): ExtensionPermissions {
  const requested = manifestRequestedGrant(manifest);
  const grant = clampExtensionPermissions(requested, manifest.permissions ?? {}, manifest);
  applyDeclaredEventSubscriptions(grant, manifest, now);
  stampGrantedAt(grant, now);
  return grant;
}

/**
 * Reinterpret a manifest's `permissions` declaration (plus the two top-level
 * deputy flags) as a "request everything declared" `Partial<ExtensionPermissions>`
 * to feed `clampExtensionPermissions`. The clamp re-validates every field
 * against the manifest ceiling, so this is defensive by construction.
 */
export function manifestRequestedGrant(
  manifest: ExtensionManifestV2,
): Partial<ExtensionPermissions> {
  const p = manifest.permissions ?? {};
  const requested: Partial<ExtensionPermissions> = {};
  if (p.network) requested.network = p.network;
  if (p.filesystem) requested.filesystem = p.filesystem;
  if (p.shell !== undefined) requested.shell = p.shell;
  if (p.env) requested.env = p.env;
  if (p.storage !== undefined) requested.storage = p.storage;
  if (p.taskEvents !== undefined) requested.taskEvents = p.taskEvents;
  if (p.spawnAgents) requested.spawnAgents = p.spawnAgents;
  if (p.agentConfig) requested.agentConfig = p.agentConfig;
  if (p.eventSubscriptions !== undefined) {
    requested.eventSubscriptions =
      p.eventSubscriptions as ExtensionPermissions["eventSubscriptions"];
  }
  if (p.llm !== undefined) requested.llm = p.llm as ExtensionPermissions["llm"];
  if (p.memory !== undefined) requested.memory = p.memory as ExtensionPermissions["memory"];
  if (p.lessons !== undefined) requested.lessons = p.lessons as ExtensionPermissions["lessons"];
  if (p.schedule !== undefined) requested.schedule = p.schedule as ExtensionPermissions["schedule"];
  if (p.search !== undefined) requested.search = p.search as ExtensionPermissions["search"];
  if (manifest.acceptsCallerCaps === true) requested.acceptsCallerCaps = true;
  if (manifest.escalateChildCaps === true) requested.escalateChildCaps = true;
  return requested;
}

// ── CLI permission prompting (moved from src/cli.ts) ──────────────────

/**
 * Prompt an operator to approve an extension's manifest-declared permissions
 * during a local `ext install`. `autoApprove` (the `--yes` flag) grants the
 * full declared set without prompting.
 */
export async function promptForPermissions(
  manifest: ExtensionManifestV2,
  autoApprove: boolean,
): Promise<ExtensionPermissions> {
  const now = Date.now();

  // Auto-approve: grant all requested permissions.
  if (autoApprove) {
    return buildFullGrantFromManifest(manifest, now);
  }

  // Non-interactive without --yes: refuse rather than silently deny.
  if (!process.stdin.isTTY) {
    throw new Error(
      "Interactive terminal required for permission prompting. Use --yes to auto-approve.",
    );
  }

  const items = getRequiredPermissions(manifest);
  if (items.length === 0) {
    return { grantedAt: {} }; // no permissions requested
  }

  printRequestedPermissions(manifest);

  const answer = await askLine("Approve all permissions? [y/N/select] ");
  const choice = answer.trim().toLowerCase();

  if (choice === "y" || choice === "yes") {
    return buildFullGrantFromManifest(manifest, now);
  }

  if (choice === "s" || choice === "select") {
    return promptPerCategory(manifest, now);
  }

  // Default: deny all.
  return { grantedAt: {} };
}

/** Human-readable summary of every capability an install would grant. */
function printRequestedPermissions(manifest: ExtensionManifestV2): void {
  const perms = manifest.permissions ?? {};
  console.log(`\nExtension "${manifest.name}" requests the following permissions:\n`);

  if (perms.network?.length) {
    console.log("  Network access:");
    for (const d of perms.network) console.log(`    - ${d}`);
    console.log();
  }
  if (perms.filesystem?.length) {
    console.log("  Filesystem access:");
    for (const path of perms.filesystem) console.log(`    - ${path}`);
    console.log();
  }
  if (perms.shell) console.log("  Shell command execution\n");
  if (perms.env?.length) {
    console.log("  Environment variables:");
    for (const v of perms.env) console.log(`    - ${v}`);
    console.log();
  }
  if (perms.storage) console.log("  Persistent storage (self-scoped key/value)\n");
  if (perms.spawnAgents) {
    console.log(
      `  Spawn sub-agents (max ${perms.spawnAgents.maxPerHour}/hr, ` +
        `${perms.spawnAgents.maxConcurrent ?? 3} concurrent)\n`,
    );
  }
  const events = normalizeDeclaredEvents(perms.eventSubscriptions);
  if (events?.length) {
    console.log("  Event subscriptions:");
    for (const e of events) console.log(`    - ${e}`);
    console.log();
  }
  if (perms.schedule?.crons?.length) {
    console.log("  Scheduled background runs:");
    for (const c of perms.schedule.crons) console.log(`    - ${c}`);
    console.log();
  }
}

/**
 * Interactive per-category approval. Accumulates the operator's yes/no answers
 * into a requested grant, then clamps + stamps it through the SAME path as
 * `buildFullGrantFromManifest` so a granted capability is serialized
 * identically no matter how it was approved.
 */
export async function promptPerCategory(
  manifest: ExtensionManifestV2,
  now: number,
): Promise<ExtensionPermissions> {
  const perms = manifest.permissions ?? {};
  const requested: Partial<ExtensionPermissions> = {};
  let acceptsCallerCaps = false;
  let escalateChildCaps = false;

  const yes = async (q: string): Promise<boolean> =>
    (await askLine(q)).trim().toLowerCase() === "y";

  if (perms.network?.length) {
    if (await yes(`  Allow network access to ${perms.network.join(", ")}? [y/N] `)) {
      requested.network = perms.network;
    }
  }
  if (perms.filesystem?.length) {
    if (await yes(`  Allow filesystem access to ${perms.filesystem.join(", ")}? [y/N] `)) {
      requested.filesystem = perms.filesystem;
    }
  }
  if (perms.shell) {
    if (await yes("  Allow shell command execution? [y/N] ")) requested.shell = true;
  }
  if (perms.env?.length) {
    if (await yes(`  Allow reading env vars: ${perms.env.join(", ")}? [y/N] `)) {
      requested.env = perms.env;
    }
  }
  if (perms.storage) {
    if (await yes("  Allow persistent storage? [y/N] ")) requested.storage = true;
  }
  if (perms.spawnAgents) {
    if (await yes("  Allow spawning sub-agents? [y/N] ")) {
      requested.spawnAgents = perms.spawnAgents;
    }
  }
  const events = normalizeDeclaredEvents(perms.eventSubscriptions);
  if (events?.length) {
    if (await yes(`  Allow event subscriptions: ${events.join(", ")}? [y/N] `)) {
      requested.eventSubscriptions = perms.eventSubscriptions as ExtensionPermissions["eventSubscriptions"];
    }
  }
  if (perms.schedule?.crons?.length) {
    if (await yes(`  Allow scheduled runs (${perms.schedule.crons.join(", ")})? [y/N] `)) {
      requested.schedule = perms.schedule as ExtensionPermissions["schedule"];
    }
  }
  if (manifest.acceptsCallerCaps === true) {
    if (await yes("  Allow accepting caller capabilities? [y/N] ")) acceptsCallerCaps = true;
  }
  if (manifest.escalateChildCaps === true) {
    if (await yes("  Allow escalating child capabilities? [y/N] ")) escalateChildCaps = true;
  }

  if (acceptsCallerCaps) requested.acceptsCallerCaps = true;
  if (escalateChildCaps) requested.escalateChildCaps = true;

  const grant = clampExtensionPermissions(requested, perms, manifest);
  // Only re-attach declared events when the operator approved them (the clamp
  // would otherwise strip the extension's own custom event names).
  if (requested.eventSubscriptions !== undefined) {
    applyDeclaredEventSubscriptions(grant, manifest, now);
  } else {
    delete grant.eventSubscriptions;
    delete grant.grantedAt.eventSubscriptions;
  }
  stampGrantedAt(grant, now);
  return grant;
}
