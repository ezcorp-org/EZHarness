/**
 * Phase 51 — clamp helpers for the new capability-surface permissions
 * (`llm`, `memory`, `lessons`, `schedule`). Both the
 * `web/src/routes/api/extensions/[id]/permissions/+server.ts` and
 * `activate/+server.ts` routes can call these directly so the clamp
 * logic stays in one place per the sec-C4 convention.
 *
 * Why a shared module now (vs. the test-reimpl pattern from Phase 2):
 * the LLM clamp has nontrivial numeric clamps + glob validation that's
 * far too easy to drift between two route copies. The Phase 2c-style
 * "no shared helper" rule was for trivial intersections; LLM/memory/
 * lessons/schedule have real validation logic.
 *
 * The classic five (`network`, `filesystem`, `shell`, `env`, `storage`)
 * remain inline at the route level — no behavior change.
 */
import type { ExtensionManifestV2, ExtensionPermissions } from "./types";

/** Pi-AI provider allowlist. Manifest cannot grant any provider not
 *  in this set; clamp drops unknown providers silently. */
export const KNOWN_LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
] as const;

const KNOWN_PROVIDER_SET = new Set<string>(KNOWN_LLM_PROVIDERS);

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Validate a model glob: no `..`, no leading `/`. Empty / non-string
 *  globs are dropped silently. */
function isValidModelGlob(glob: unknown): glob is string {
  if (typeof glob !== "string") return false;
  if (glob.length === 0) return false;
  if (glob.startsWith("/")) return false;
  if (glob.includes("..")) return false;
  return true;
}

/**
 * Clamp an LLM permission grant to its manifest declaration. Returns
 * `undefined` if the manifest doesn't declare LLM (extension cannot
 * grant itself a permission the manifest didn't request).
 */
export function clampLlmPermission(
  submitted: NonNullable<ExtensionPermissions["llm"]> | undefined,
  manifest: NonNullable<ExtensionManifestV2["permissions"]["llm"]> | undefined,
): ExtensionPermissions["llm"] {
  if (!manifest) return undefined;
  // Treat the submitted grant as a fully-qualified ExtensionPermissions
  // shape — the optional fields default to undefined and the clamp
  // logic below reads them through `clampNumber` which already
  // handles undefined.
  const sub: NonNullable<ExtensionPermissions["llm"]> =
    submitted ?? { providers: [], maxCallsPerHour: 0, maxCallsPerDay: 0 };

  // Provider intersection: submitted ∩ manifest ∩ KNOWN_LLM_PROVIDERS.
  const manifestProviders = new Set(manifest.providers ?? []);
  const providers = (sub.providers ?? []).filter(
    (p) => typeof p === "string" && manifestProviders.has(p) && KNOWN_PROVIDER_SET.has(p),
  );
  if (providers.length === 0) return undefined;

  const out: NonNullable<ExtensionPermissions["llm"]> = {
    providers,
    maxCallsPerHour: Math.min(
      clampNumber(sub.maxCallsPerHour, 1, 1000, 60),
      clampNumber(manifest.maxCallsPerHour, 1, 1000, 60),
    ),
    maxCallsPerDay: Math.min(
      clampNumber(sub.maxCallsPerDay, 1, 5000, 500),
      clampNumber(manifest.maxCallsPerDay, 1, 5000, 500),
    ),
  };

  if (manifest.maxTokensPerCall !== undefined || sub.maxTokensPerCall !== undefined) {
    out.maxTokensPerCall = Math.min(
      clampNumber(sub.maxTokensPerCall, 1, 16384, 4096),
      clampNumber(manifest.maxTokensPerCall, 1, 16384, 4096),
    );
  }
  if (manifest.maxTokensPerDay !== undefined || sub.maxTokensPerDay !== undefined) {
    out.maxTokensPerDay = Math.min(
      clampNumber(sub.maxTokensPerDay, 1, Number.MAX_SAFE_INTEGER, 1_000_000),
      clampNumber(manifest.maxTokensPerDay, 1, Number.MAX_SAFE_INTEGER, 1_000_000),
    );
  }
  if (manifest.maxTimeoutMs !== undefined || sub.maxTimeoutMs !== undefined) {
    out.maxTimeoutMs = Math.min(
      clampNumber(sub.maxTimeoutMs, 1000, 300_000, 60_000),
      clampNumber(manifest.maxTimeoutMs, 1000, 300_000, 60_000),
    );
  }
  if (manifest.maxCostCentsPerDay !== undefined || sub.maxCostCentsPerDay !== undefined) {
    out.maxCostCentsPerDay = Math.min(
      clampNumber(sub.maxCostCentsPerDay, 1, Number.MAX_SAFE_INTEGER, 10_000),
      clampNumber(manifest.maxCostCentsPerDay, 1, Number.MAX_SAFE_INTEGER, 10_000),
    );
  }

  // allowedModels: manifest is source of truth. Drop entries outside
  // granted providers and entries with invalid globs.
  if (manifest.allowedModels) {
    const allowed: Record<string, string[]> = {};
    for (const provider of providers) {
      const globs = manifest.allowedModels[provider];
      if (!Array.isArray(globs)) continue;
      const valid = globs.filter(isValidModelGlob);
      if (valid.length > 0) allowed[provider] = valid;
    }
    if (Object.keys(allowed).length > 0) out.allowedModels = allowed;
  }

  return out;
}

export function clampMemoryPermission(
  submitted: ExtensionPermissions["memory"] | undefined,
  manifest: ExtensionManifestV2["permissions"]["memory"] | undefined,
): ExtensionPermissions["memory"] {
  if (!manifest) return undefined;
  const sub: NonNullable<ExtensionPermissions["memory"]> =
    submitted ?? { access: manifest.access, maxWritesPerDay: 0, selfOnly: true };

  // Access tier: write implies read. Submitted cannot exceed manifest.
  let access: "read" | "write" = "read";
  if (manifest.access === "write" && sub.access === "write") access = "write";

  const out: NonNullable<ExtensionPermissions["memory"]> = {
    access,
    maxWritesPerDay: Math.min(
      clampNumber(sub.maxWritesPerDay, 1, 1000, 100),
      clampNumber(manifest.maxWritesPerDay, 1, 1000, 100),
    ),
    // selfOnly default: TRUE (locked decision). Extension cannot
    // unilaterally weaken this — only the manifest declaring
    // `selfOnly: false` (a wider grant) lets the user opt in.
    selfOnly: !(manifest.selfOnly === false && sub.selfOnly === false),
  };

  if (Array.isArray(manifest.categories)) {
    const validCategories = new Set([
      "preferences", "biographical", "technical", "decisions_goals",
    ]);
    const fromManifest = manifest.categories.filter((c) => validCategories.has(c));
    const filtered = Array.isArray(sub.categories)
      ? sub.categories.filter((c) => fromManifest.includes(c))
      : fromManifest;
    if (filtered.length > 0) out.categories = filtered;
  }

  return out;
}

export function clampLessonsPermission(
  submitted: ExtensionPermissions["lessons"] | undefined,
  manifest: ExtensionManifestV2["permissions"]["lessons"] | undefined,
): ExtensionPermissions["lessons"] {
  if (!manifest) return undefined;
  const sub: NonNullable<ExtensionPermissions["lessons"]> =
    submitted ?? { access: manifest.access, maxWritesPerDay: 0, maxVisibility: "user" };

  let access: "read" | "write" = "read";
  if (manifest.access === "write" && sub.access === "write") access = "write";

  // maxVisibility: clamp to user|project (no global). Locked decision.
  let maxVisibility: "user" | "project" = "user";
  if (manifest.maxVisibility === "project" && sub.maxVisibility === "project") {
    maxVisibility = "project";
  }

  return {
    access,
    maxWritesPerDay: Math.min(
      clampNumber(sub.maxWritesPerDay, 1, 500, 50),
      clampNumber(manifest.maxWritesPerDay, 1, 500, 50),
    ),
    maxVisibility,
  };
}

// Min 5-minute interval — reject `* * * * *`, `*\/1`, `*\/2`, `*\/3`, `*\/4`.
const SUB_5_MIN_PATTERNS = [
  /^\*\s+\*\s+\*\s+\*\s+\*\s*$/,
  /^\*\/[1-4]\s+\*\s+\*\s+\*\s+\*\s*$/,
];

function isFiveFieldCron(expr: string): boolean {
  const trimmed = expr.trim();
  // Reject @every/@hourly etc and anything with seconds (6-field).
  if (trimmed.startsWith("@")) return false;
  const parts = trimmed.split(/\s+/);
  return parts.length === 5;
}

function passesMinIntervalGate(expr: string): boolean {
  for (const re of SUB_5_MIN_PATTERNS) {
    if (re.test(expr)) return false;
  }
  return true;
}

export function clampSchedulePermission(
  submitted: ExtensionPermissions["schedule"] | undefined,
  manifest: ExtensionManifestV2["permissions"]["schedule"] | undefined,
): ExtensionPermissions["schedule"] {
  if (!manifest) return undefined;
  // Use the submitted grant when present; otherwise default to the
  // manifest's own values so the clamp produces a coherent grant.
  const sub: NonNullable<ExtensionPermissions["schedule"]> = submitted ?? {
    crons: manifest.crons ?? [],
    maxRunsPerDay: manifest.maxRunsPerDay ?? 24,
    maxRunDurationMs: manifest.maxRunDurationMs ?? 300_000,
    missedRunPolicy: manifest.missedRunPolicy ?? "fire-once",
    maxRetries: manifest.maxRetries ?? 0,
  };

  // Manifest is source of truth for crons (extension cannot smuggle
  // in extra schedules at activate time).
  const crons = (manifest.crons ?? [])
    .filter((c) => typeof c === "string" && isFiveFieldCron(c) && passesMinIntervalGate(c))
    .slice(0, 8);
  if (crons.length === 0) return undefined;

  const policyChoices = new Set(["skip", "fire-once", "fire-all"]);
  const policy = policyChoices.has(manifest.missedRunPolicy ?? "")
    ? (manifest.missedRunPolicy as "skip" | "fire-once" | "fire-all")
    : "fire-once";

  return {
    crons,
    maxRunsPerDay: Math.min(
      clampNumber(sub.maxRunsPerDay, 1, 288, 24),
      clampNumber(manifest.maxRunsPerDay, 1, 288, 24),
    ),
    maxRunDurationMs: Math.min(
      clampNumber(sub.maxRunDurationMs, 1000, 1_800_000, 300_000),
      clampNumber(manifest.maxRunDurationMs, 1000, 1_800_000, 300_000),
    ),
    missedRunPolicy: policy,
    maxRetries: clampNumber(manifest.maxRetries, 0, 10, 0),
  };
}

// ── Env-key leak detection ──────────────────────────────────────

const ENV_KEY_LEAK_PATTERN = /(_API_KEY|TOKEN|SECRET)$/i;

/** Returns the subset of `permissions.env` whose names look like
 *  credentials. Used by the installer to emit `ext:env-key-leak-warning`
 *  audit rows (governance, soft warning; hard error in v1.4). */
export function detectEnvKeyLeaks(envNames: string[] | undefined): string[] {
  if (!Array.isArray(envNames)) return [];
  return envNames.filter(
    (n) => typeof n === "string" && ENV_KEY_LEAK_PATTERN.test(n),
  );
}

/**
 * Emit a `ext:env-key-leak-warning` audit row for each
 * credential-shaped env var the manifest declared. Soft warning today;
 * hard error in v1.4. Migration path: ctx.llm (host-brokered).
 *
 * Wrapped in try/catch — audit-write failure is non-fatal (per Pitfall
 * #2). The caller never awaits this for ordering — it's
 * fire-and-forget.
 */
export async function emitEnvKeyLeakWarnings(
  extensionId: string,
  envNames: string[] | undefined,
): Promise<void> {
  const leaks = detectEnvKeyLeaks(envNames);
  if (leaks.length === 0) return;
  try {
    const { insertAuditEntry } = await import("../db/queries/audit-log");
    const { EXT_AUDIT_ACTIONS } = await import("./audit-actions");
    for (const name of leaks) {
      await insertAuditEntry(
        null,
        EXT_AUDIT_ACTIONS.ENV_KEY_LEAK_WARNING,
        extensionId,
        {
          permission: "env",
          oldValue: undefined,
          newValue: name,
          actor: "system",
          reason: "Credential-shaped env name. Migrate to ctx.llm (host-brokered) — hard error in v1.4.",
        },
      );
    }
  } catch {
    // Audit failure is non-fatal.
  }
}
