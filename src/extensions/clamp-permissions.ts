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
import { parseCron, type CronInstance } from "./cron";

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

/** Known search providers. A grant cannot allowlist a provider outside
 *  this set; clamp drops unknown providers silently. Mirrors
 *  `KNOWN_LLM_PROVIDERS`. */
export const KNOWN_SEARCH_PROVIDERS = [
  "searxng",
  "duckduckgo",
  "tavily",
  "brave",
  "exa",
  "serpapi",
  "jina",
] as const;

const KNOWN_SEARCH_PROVIDER_SET = new Set<string>(KNOWN_SEARCH_PROVIDERS);

/**
 * Clamp a `search` permission grant to its manifest declaration.
 *
 * The grant is the §3.1 three-state shape (`"inherit" | {…} | false`):
 *   - `false` (disabled) and `"inherit"` (track instance defaults) pass
 *     through verbatim — neither can exceed any manifest bound, so
 *     there's nothing to clamp.
 *   - an object override is clamped: providers intersect with the
 *     manifest's declared providers ∩ the KNOWN set; numeric fields are
 *     clamped to `[manifest, hard-default]` minimums.
 *
 * Returns `undefined` when the manifest doesn't declare `search` — an
 * extension cannot grant itself a capability the manifest didn't request
 * (mirrors `clampLlmPermission`). The full instance↔extension field-level
 * RESOLVER lands in Phase 2; this is install/grant-time clamping only.
 */
export function clampSearchPermission(
  submitted: ExtensionPermissions["search"] | undefined,
  // Accepts EITHER the manifest declaration (object-only) OR a granted
  // `ExtensionPermissions["search"]` (the §3.1 three-state shape). The
  // reapprove/re-clamp path passes a prior GRANT as the ceiling, so the
  // param must tolerate `false` / `"inherit"`.
  manifest: ExtensionManifestV2["permissions"]["search"] | ExtensionPermissions["search"] | undefined,
): ExtensionPermissions["search"] {
  if (manifest === undefined) return undefined;
  // A `false` ceiling disables search regardless of what was submitted.
  if (manifest === false) return false;
  // Disabled / inherit are valid terminal states — nothing to clamp.
  if (submitted === false) return false;
  if (submitted === "inherit" || submitted === undefined) return "inherit";

  // Normalize an `"inherit"` ceiling to "no field bounds" (providers
  // unrestricted, numerics default-clamped).
  const manifestObj = manifest === "inherit" ? {} : manifest;

  const out: NonNullable<Exclude<ExtensionPermissions["search"], "inherit" | false>> = {};

  // Numeric ceilings: clamp to the narrower of submitted and manifest.
  if (manifestObj.quota !== undefined || submitted.quota !== undefined) {
    out.quota = Math.min(
      clampNumber(submitted.quota, 1, 100_000, 100),
      clampNumber(manifestObj.quota, 1, 100_000, 100),
    );
  }
  if (manifestObj.maxResults !== undefined || submitted.maxResults !== undefined) {
    out.maxResults = Math.min(
      clampNumber(submitted.maxResults, 1, 20, 5),
      clampNumber(manifestObj.maxResults, 1, 20, 5),
    );
  }

  // Providers: `"inherit"` passes through; an explicit list intersects
  // submitted ∩ manifest ∩ KNOWN. An empty intersection means "no
  // explicit provider allowlist" → omit (resolver falls back to default).
  const manifestProviders = manifestObj.providers;
  if (submitted.providers === "inherit") {
    out.providers = "inherit";
  } else if (Array.isArray(submitted.providers)) {
    const manifestSet =
      manifestProviders === "inherit" || manifestProviders === undefined
        ? KNOWN_SEARCH_PROVIDER_SET
        : new Set(manifestProviders);
    const providers = submitted.providers.filter(
      (p) => typeof p === "string" && manifestSet.has(p) && KNOWN_SEARCH_PROVIDER_SET.has(p),
    );
    if (providers.length > 0) out.providers = providers;
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

function isFiveFieldCron(expr: string): boolean {
  const trimmed = expr.trim();
  // Reject @every/@hourly etc and anything with seconds (6-field).
  if (trimmed.startsWith("@")) return false;
  const parts = trimmed.split(/\s+/);
  return parts.length === 5;
}

const MIN_INTERVAL_MS = 5 * 60_000;
// Number of consecutive fires to inspect. A sub-5-minute gap always
// shows up as adjacent fires, so a modest window is enough to surface
// any dense cluster (`0-59 * * * *`, `1,2,3 * * * *`, `0/1 * * * *`).
const MIN_INTERVAL_SAMPLES = 48;
// Fixed reference instant — NOT `Date.now()`, so the gate is
// deterministic and reproducible regardless of when it runs.
const MIN_INTERVAL_REFERENCE = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

/**
 * Enforce the 5-minute floor by WALKING actual fire times rather than
 * pattern-matching a handful of string forms. The old regex blocklist
 * (`* * * * *`, `*\/1..4`) let trivially-equivalent expressions through
 * — `0-59 * * * *`, `1,2,3 * * * *`, `0/1 * * * *` all fire at
 * minute resolution. Here we parse with the production cron engine and
 * require every consecutive gap to be >= 5 minutes.
 */
function passesMinIntervalGate(expr: string): boolean {
  let cron: CronInstance;
  try {
    cron = parseCron(expr, "UTC");
  } catch {
    // Unparseable → reject. (isFiveFieldCron already ran, so this is a
    // defensive backstop for range/step errors validateCron catches.)
    return false;
  }
  // Seed `prev` with the FIRST fire, not the reference instant — the
  // reference is arbitrary and almost never a fire time, so measuring
  // reference→first-fire would falsely reject e.g. `2 * * * *` (a 2-min
  // offset from midnight, but a real 60-min cadence). We only care about
  // the gap BETWEEN consecutive fires.
  let prev: Date;
  try {
    prev = cron.next(MIN_INTERVAL_REFERENCE);
  } catch {
    // No fire within the engine's 4-year horizon → impossible/sparse
    // schedule that can't violate the floor.
    return true;
  }
  for (let i = 0; i < MIN_INTERVAL_SAMPLES; i++) {
    let next: Date;
    try {
      next = cron.next(prev);
    } catch {
      return true;
    }
    if (next.getTime() - prev.getTime() < MIN_INTERVAL_MS) return false;
    prev = next;
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
  // Cap the candidate list BEFORE the per-cron interval walk — the walk
  // can be expensive for impossible expressions (a 4-year no-match
  // search), so bound how many we evaluate rather than walking an
  // unbounded manifest array.
  const crons = (manifest.crons ?? [])
    .filter((c) => typeof c === "string" && isFiveFieldCron(c))
    .slice(0, 8)
    .filter((c) => passesMinIntervalGate(c));
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

/**
 * v1.4 — typed install-gate failure. Thrown by `installFromLocal`
 * when an extension's `permissions.env` declares credential-shaped
 * names AND the install isn't a bundled extension with the
 * `envEscapeHatch: true` opt-in. The caller surfaces the error to
 * the operator (admin UI or CLI); the audit row is written
 * separately so a forensic trail exists alongside the throw.
 *
 * Migration path stays `ctx.llm` for LLM creds (already shipped) and
 * future `ctx.secrets` for third-party API creds (v1.5+).
 */
export class EnvKeyLeakInstallError extends Error {
  /** Credential-shaped env names that tripped the gate. */
  readonly leakedNames: readonly string[];
  constructor(leakedNames: string[]) {
    super(
      `Install refused: extension manifest declares credential-shaped env name(s) ` +
        `[${leakedNames.join(", ")}]. The deprecation has been live since Phase 51; ` +
        `v1.4 is the cliff. Migrate LLM credentials to ctx.llm (host-brokered) and ` +
        `third-party API creds to the upcoming ctx.secrets surface (v1.5+).`,
    );
    this.name = "EnvKeyLeakInstallError";
    this.leakedNames = Object.freeze([...leakedNames]);
  }
}

/**
 * v1.4 — install-time gate. Returns `null` when the install may
 * proceed; otherwise writes audit rows AND returns the typed error
 * the caller should throw.
 *
 *   - **User-installed extension** (`isBundled=false`) with
 *     credential-shaped env names → `ENV_KEY_LEAK_INSTALL_BLOCKED`
 *     row per name; returns `EnvKeyLeakInstallError`.
 *   - **Bundled extension** (`isBundled=true`) WITHOUT the
 *     `envEscapeHatch` opt-in with credential-shaped env names →
 *     same as user-installed (fails closed).
 *   - **Bundled extension** (`isBundled=true`) WITH
 *     `envEscapeHatch=true` and credential-shaped env names →
 *     `ENV_KEY_LEAK_BUNDLED_ESCAPE_HATCH_USED` row per name;
 *     returns `null` (install proceeds). The flag is grep-able
 *     so the eventual ctx.secrets migration knows what to touch.
 *
 * Audit rows are NOT keyed on the eventual extension id (the row
 * doesn't exist yet) — the caller passes the manifest name as the
 * audit target so a forensic trail can correlate by name even when
 * the install aborts before persistence.
 */
export async function checkEnvKeyLeakInstallGate(
  extensionName: string,
  envNames: string[] | undefined,
  opts: { isBundled: boolean; envEscapeHatch: boolean },
): Promise<EnvKeyLeakInstallError | null> {
  const leaks = detectEnvKeyLeaks(envNames);
  if (leaks.length === 0) return null;

  const allowEscapeHatch = opts.isBundled && opts.envEscapeHatch === true;
  try {
    const { insertAuditEntry } = await import("../db/queries/audit-log");
    const { EXT_AUDIT_ACTIONS } = await import("./audit-actions");
    const action = allowEscapeHatch
      ? EXT_AUDIT_ACTIONS.ENV_KEY_LEAK_BUNDLED_ESCAPE_HATCH_USED
      : EXT_AUDIT_ACTIONS.ENV_KEY_LEAK_INSTALL_BLOCKED;
    const reason = allowEscapeHatch
      ? `Bundled extension '${extensionName}' opted into envEscapeHatch — credential-shaped env name allowed pending ctx.secrets (v1.5+).`
      : `Install refused for '${extensionName}': credential-shaped env name. Migrate to ctx.llm (LLM creds) or wait for ctx.secrets (v1.5+).`;
    for (const name of leaks) {
      await insertAuditEntry(null, action, extensionName, {
        permission: "env",
        oldValue: undefined,
        newValue: name,
        actor: "system",
        reason,
        extensionName,
      });
    }
  } catch {
    // Audit failure is non-fatal — the throw still happens (or doesn't)
    // based on the gate's allow/deny decision so the gate never silently
    // permits an install just because the audit table is unreachable.
  }
  return allowEscapeHatch ? null : new EnvKeyLeakInstallError(leaks);
}
