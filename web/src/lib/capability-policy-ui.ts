/**
 * Pure logic for the extension-detail Capabilities panel (Phase 3 §5.2;
 * multi-provider rework — shared-search residual #3).
 *
 * No Svelte / no fetch — so the grant↔UI-mode mapping, the prefill
 * values, and the partial-override builder are unit-testable. The
 * `CapabilitiesPanel.svelte` component is a thin wrapper over these.
 *
 * Mirrors the resolver's field-level merge semantics (`mergeSearchPolicy`
 * in `src/search/policy.ts`): a "Custom" override stores ONLY the fields
 * the admin changed away from the inherited value; everything else stays
 * inherited (undefined in the grant).
 *
 * `providers` is now a FIRST-CLASS multi-select: a `string[]` subset of
 * the known providers. The old single-`<select>` preserve-hack
 * (`providersOriginal`/`providersDirty`/`hasPreservedProviderList`) is
 * gone — the multi-select represents an arbitrary list natively, so a
 * pre-existing N-provider grant round-trips verbatim with no preservation
 * shim. The UI offers only the KNOWN providers; `clampSearchPermission`
 * stays the server-side security ceiling (the UI is not the boundary).
 */

/** The three grant states surfaced as a UI mode. */
export type CapabilityMode = "inherit" | "custom" | "disabled";

/** The effective (resolved) policy the API returns — display values that
 *  also seed the Custom form's prefill. */
export interface EffectivePolicyView {
  quota: number;
  maxResults: number;
  /** `"all"` or a provider list. */
  providers: string[] | "all";
}

/** The raw grant state from the API (matches `ExtensionPermissions["search"]`). */
export type SearchGrant =
  | "inherit"
  | false
  | { quota?: number; maxResults?: number; providers?: string[] | "inherit" }
  | undefined;

/** A capability schema field carries its setting KEY + the manifest
 *  `SettingsField` declaration (mirrors `CapabilitySettingsField` in
 *  `src/search/policy.ts`; re-declared here to avoid a web→server type
 *  import for the UI layer). */
export interface CapabilitySettingsField {
  key: string;
  field:
    | { type: "select"; label: string; description?: string; options: { value: string; label: string }[]; default?: string }
    | { type: "text"; label: string; description?: string; default?: string; minLength?: number; maxLength?: number; pattern?: string }
    | { type: "number"; label: string; description?: string; default?: number; min?: number; max?: number; step?: number; integer?: boolean }
    | { type: "boolean"; label: string; description?: string; default?: boolean };
}

/** One held capability as returned by GET …/settings `capabilities[]`. */
export interface HeldCapabilityView {
  cap: string;
  schema: CapabilitySettingsField[];
  effective: { denied: boolean; quota?: number; maxResults?: number; providers?: string[] | "all" };
  grant: SearchGrant;
}

/** The editable Custom-form buffer. `providers` is a first-class
 *  multi-select: the explicit list of provider names the admin has
 *  checked. An empty list is a VALIDATION ERROR in Custom mode (an empty
 *  allowlist would deny every provider) — never persisted as `[]`. */
export interface CapabilityForm {
  providers: string[];
  quota: number;
  maxResults: number;
}

/** The canonical provider list the UI offers — sourced from the
 *  capability schema's `providers` select options (which derive from
 *  `KNOWN_SEARCH_PROVIDERS` server-side), MINUS the `"inherit"` sentinel.
 *  DRY: no divergent hardcoded list on the web side. */
export function providerOptions(c: HeldCapabilityView): string[] {
  const f = c.schema.find((s) => s.key === "providers")?.field;
  if (!f || f.type !== "select") return [];
  return f.options.map((o) => o.value).filter((v) => v !== "inherit");
}

/** Map a raw grant to the UI mode. `false` → disabled; `"inherit"` /
 *  absent → inherit; an object → custom. */
export function grantToMode(grant: SearchGrant): CapabilityMode {
  if (grant === false) return "disabled";
  if (grant === "inherit" || grant === undefined) return "inherit";
  return "custom";
}

/** True iff two provider lists hold the same set (order-insensitive). */
export function sameProviderSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * The provider list to SEED the multi-select with, given the effective
 * (resolved) providers and the full set the UI offers:
 *   - effective `"all"` → every available provider checked (tracks the
 *     instance default; collapses back to `"inherit"` on save if the set
 *     is unchanged).
 *   - an explicit list → exactly those providers checked, intersected
 *     with the available set (a stale/unknown provider is dropped — the
 *     server ceiling would drop it anyway).
 */
export function seedProviders(
  effectiveProviders: string[] | "all",
  available: string[],
): string[] {
  if (effectiveProviders === "all") return [...available];
  const avail = new Set(available);
  return effectiveProviders.filter((p) => avail.has(p));
}

/**
 * Seed the Custom form from the resolved EFFECTIVE policy (the inherited
 * values overlaid with any explicit override) — so opening "Custom" shows
 * the values currently in force. The effective policy already merged the
 * override, so it IS the prefill. `available` is the provider set the UI
 * offers (from `providerOptions`).
 */
export function formFromEffective(
  effective: EffectivePolicyView,
  available: string[],
): CapabilityForm {
  return {
    providers: seedProviders(effective.providers, available),
    quota: effective.quota,
    maxResults: effective.maxResults,
  };
}

/** A providers selection EQUALS the inherited default when it covers the
 *  full available set (the instance default the resolver would apply) —
 *  the multi-select can't pin a literal "all", so "all checked" means
 *  "inherit". */
function providersMatchInherited(selected: string[], available: string[]): boolean {
  return sameProviderSet(selected, available);
}

/** Validation: a Custom-mode form with an empty provider selection is
 *  invalid (an empty allowlist denies every provider). */
export function isCustomFormValid(form: CapabilityForm): boolean {
  return form.providers.length > 0;
}

/**
 * Build the GRANT override object from the Custom form, FIELD-LEVEL: only
 * include a field when it DIFFERS from the inherited (effective-when-
 * inheriting) value, so unchanged fields keep tracking the instance
 * default. Mirrors the resolver's `{...instanceDef, ...definedFields}`.
 *
 * `inherited` is the effective policy computed with a pure-`"inherit"`
 * grant (i.e. the instance defaults); `available` is the full provider
 * set. A providers selection covering the full available set collapses to
 * inherit (omitted). An all-inherited form collapses to `"inherit"`.
 *
 * Throws on an empty provider selection — callers must gate with
 * `isCustomFormValid` first (the panel surfaces a validation error).
 */
export function buildOverride(
  form: CapabilityForm,
  inherited: EffectivePolicyView,
  available: string[],
): SearchGrant {
  if (form.providers.length === 0) {
    throw new Error("empty provider selection");
  }
  const override: { quota?: number; maxResults?: number; providers?: string[] } = {};

  // providers — include the explicit list ONLY when it is a true subset
  // (i.e. NOT the full available set). "All available checked" === inherit
  // (the resolver applies the instance default), so it's omitted.
  if (!providersMatchInherited(form.providers, available)) {
    override.providers = [...form.providers];
  }

  const quota = sanitizePositiveInt(form.quota, inherited.quota);
  if (quota !== inherited.quota) override.quota = quota;

  const maxResults = sanitizePositiveInt(form.maxResults, inherited.maxResults);
  if (maxResults !== inherited.maxResults) override.maxResults = maxResults;

  // Nothing changed → collapse to "inherit" (an empty override is
  // semantically identical to inherit per the resolver).
  if (Object.keys(override).length === 0) return "inherit";
  return override;
}

/** Clamp a form numeric to a positive integer, falling back to the
 *  inherited value when the input is junk. */
export function sanitizePositiveInt(n: number, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** The grant value to PUT for a given mode. Custom uses `buildOverride`;
 *  the caller passes the form + inherited + available for that case. */
export function grantForMode(
  mode: CapabilityMode,
  form: CapabilityForm,
  inherited: EffectivePolicyView,
  available: string[],
): SearchGrant {
  if (mode === "disabled") return false;
  if (mode === "inherit") return "inherit";
  return buildOverride(form, inherited, available);
}
