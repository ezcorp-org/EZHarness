/**
 * The LLM providers this deployment knows about — ONE table.
 *
 * Before this module the same four-element list
 * (`["anthropic", "openai", "google", "openrouter"]`) was written out
 * independently in six places that all had to agree, plus two derived maps:
 *
 *   - `web/src/routes/api/providers/+server.ts`            — PROVIDERS, ENV_KEYS, OAUTH_SUPPORTED
 *   - `web/src/routes/api/providers/[provider]/test`       — VALID_PROVIDERS
 *   - `web/src/routes/api/providers/[provider]/refresh-models` — VALID_PROVIDERS
 *   - `web/src/lib/server/provider-availability.ts`        — ENV_KEYS
 *   - `src/providers/router.ts`                            — DEFAULT_PREFERENCE_ORDER
 *   - `src/providers/registry.ts`                          — the discovered-models scan
 *   - `src/health.ts`                                      — providerNames
 *   - `src/providers/credentials.ts`                       — BYOK_ONLY_PROVIDERS
 *
 * A provider added to some of those and not the others is not a compile error
 * — it is a provider you can save a key for but cannot route to, or can route
 * to but never see in the picker. Adding Kilo meant touching every one of
 * them, so they now all read this table instead.
 *
 * ── Purity (why this lives in src/runtime, not src/providers) ──
 * Same rationale as the sibling `./tier-ladder` and `./custom-models`:
 * `src/providers/**` is excluded from the coverage gate
 * (`scripts/coverage-config.ts`), and the preference ORDER below is a routing
 * decision — it is the list `resolveModel`'s Level 3 walks. So the table is
 * pure (no DB, no pi-ai, no imports at all) and coverage-enforced.
 *
 * `web/src/lib/settings-models.ts` keeps its own mirrored copy of the order:
 * it is a separate build with its own tests, and that mirroring predates this
 * module (see the note there).
 */

/** How a provider proves who it is. */
export interface LlmProviderSpec {
  /** Canonical provider id — the key used in every `provider:*` setting. */
  id: string;
  /** Env var consulted when no key is stored in settings. */
  envKey: string;
  /** A pi-managed OAuth (subscription) login flow exists for this provider. */
  oauth: boolean;
  /**
   * No pi-managed OAuth flow at all, so the credential chain skips the
   * DB-OAuth attempt and goes straight to BYOK → env var. Distinct from
   * `!oauth`: a provider could gain a flow later without becoming routable
   * through it (see the credentials.ts note about pi-ai 0.83.0 shipping
   * `auth.oauth` for anthropic without EZCorp ever writing that row).
   */
  byokOnly: boolean;
  /**
   * This provider answers with NO credential at all, for some subset of its
   * models. Kilo's gateway serves its free models to anonymous callers
   * (measured: HTTP 200, `cost: "0"`) and 401s paid ones with
   * `PAID_MODEL_AUTH_REQUIRED`, so a deployment that has configured nothing
   * can still route a turn to it.
   *
   * This is the flag that lets `resolveProviderAvailability` report a
   * provider as available without finding a stored key — every other
   * provider is unavailable until someone configures it.
   */
  keylessFreeTier: boolean;
}

/** Kilo's canonical provider id. Named so nothing has to spell the string. */
export const KILO_PROVIDER = "kilo";

/**
 * Every provider, in the order `resolveModel` walks them when no model is
 * pinned. Order is load-bearing: Level 3 takes the FIRST entry that has both
 * a usable credential and a model in the tier.
 *
 * Kilo is deliberately LAST. A provider reached at that point is one every
 * entry ahead of it was already skipped for (open breaker, no credential, no
 * model in the tier), so placing a keyless-free provider there can only ADD an
 * answer where a deployment previously had none — it can never re-route a
 * deployment that has cloud credentials. That is what makes appending it to
 * every existing stored order (via `mergePreferenceOrder`) safe.
 */
export const LLM_PROVIDERS: readonly LlmProviderSpec[] = [
  { id: "anthropic", envKey: "ANTHROPIC_API_KEY", oauth: false, byokOnly: true, keylessFreeTier: false },
  { id: "openai", envKey: "OPENAI_API_KEY", oauth: true, byokOnly: false, keylessFreeTier: false },
  { id: "google", envKey: "GOOGLE_API_KEY", oauth: true, byokOnly: false, keylessFreeTier: false },
  { id: "openrouter", envKey: "OPENROUTER_API_KEY", oauth: false, byokOnly: true, keylessFreeTier: false },
  { id: KILO_PROVIDER, envKey: "KILO_API_KEY", oauth: false, byokOnly: true, keylessFreeTier: true },
];

/** Provider ids, in preference order. */
export const LLM_PROVIDER_IDS: readonly string[] = LLM_PROVIDERS.map((p) => p.id);

/** Env var per provider — the shape `provider-availability` and the provider
 *  CRUD route both want. */
export const PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  LLM_PROVIDERS.map((p) => [p.id, p.envKey]),
);

/** Providers with a pi-managed OAuth login flow. */
export const OAUTH_SUPPORTED_PROVIDERS: readonly string[] = LLM_PROVIDERS.filter((p) => p.oauth).map(
  (p) => p.id,
);

/** Providers whose credential chain skips the DB-OAuth attempt entirely. */
export const BYOK_ONLY_PROVIDERS: readonly string[] = LLM_PROVIDERS.filter((p) => p.byokOnly).map(
  (p) => p.id,
);

/** The spec for `id`, or undefined when it is not a known LLM provider. */
export function llmProviderSpec(id: string): LlmProviderSpec | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** Is `id` one of the providers this deployment knows how to talk to? */
export function isKnownLlmProvider(id: string): boolean {
  return llmProviderSpec(id) !== undefined;
}

/**
 * Can this provider answer with no credential configured at all?
 *
 * The single question `getCredential`'s last-resort branch and
 * `resolveProviderAvailability` both need. False for everything but Kilo
 * today, and deliberately a per-provider FACT rather than a hardcoded
 * `provider === "kilo"` in two files that would then have to agree.
 */
export function hasKeylessFreeTier(id: string): boolean {
  return llmProviderSpec(id)?.keylessFreeTier === true;
}

/**
 * The human-readable provider list used in 400 messages
 * (`"Must be one of: anthropic, openai, google, openrouter, kilo"`).
 */
export function providerListMessage(): string {
  return LLM_PROVIDER_IDS.join(", ");
}
