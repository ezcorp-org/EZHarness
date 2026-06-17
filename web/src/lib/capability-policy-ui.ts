/**
 * Pure logic for the extension-detail Capabilities panel (Phase 3 §5.2).
 *
 * No Svelte / no fetch — so the grant↔UI-mode mapping, the prefill
 * values, and the partial-override builder are unit-testable. The
 * `CapabilitiesPanel.svelte` component is a thin wrapper over these.
 *
 * Mirrors the resolver's field-level merge semantics (`mergeSearchPolicy`
 * in `src/search/policy.ts`): a "Custom" override stores ONLY the fields
 * the admin changed away from the inherited value; everything else stays
 * inherited (undefined in the grant). `providers` is the single-select
 * common case — "all" or one provider name.
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

/** The editable Custom-form buffer. `providers` is a single select value:
 *  the sentinel `"inherit"` (track the instance default) or ONE provider
 *  name — the grant tier can't express a literal "all" (only the instance
 *  default can), so the override pins one provider or inherits. */
export interface CapabilityForm {
  providers: string;
  quota: number;
  maxResults: number;
  /**
   * The original grant's providers allowlist, captured at form-seed time.
   * The single-select can't FAITHFULLY represent a multi-provider list
   * (it collapses to the `"inherit"` sentinel), so we carry the original
   * here to PRESERVE it verbatim on save — preventing a silent §8
   * ceiling-WIDENING when the admin edits an unrelated field (quota /
   * maxResults) and never touched providers. `undefined` when the grant
   * had no explicit list. */
  providersOriginal?: string[];
  /** Set true once the admin actively changes the providers select — only
   *  then do we honor the (necessarily single-provider/inherit) new value
   *  over the preserved original list. */
  providersDirty?: boolean;
}

/** Map a raw grant to the UI mode. `false` → disabled; `"inherit"` /
 *  absent → inherit; an object → custom. */
export function grantToMode(grant: SearchGrant): CapabilityMode {
  if (grant === false) return "disabled";
  if (grant === "inherit" || grant === undefined) return "inherit";
  return "custom";
}

/**
 * Single-select value for a providers policy. A single-element list pins
 * that one provider (an explicit override); `"all"` or a multi-element
 * list is shown as `"inherit"` because the override tier can only pin ONE
 * provider or inherit (it can't express "all" or an arbitrary subset). */
export function providersToSelectValue(providers: string[] | "all"): string {
  if (providers === "all") return "inherit";
  return providers.length === 1 ? providers[0]! : "inherit";
}

/** Whether a providers value is a multi-provider list the single-select
 *  CANNOT faithfully represent (it would collapse to `"inherit"`). Such a
 *  grant must be preserved verbatim on save, not silently widened. */
export function isUnrepresentableProviderList(providers: string[] | "all" | "inherit" | undefined): boolean {
  return Array.isArray(providers) && providers.length > 1;
}

/**
 * Seed the Custom form from the resolved EFFECTIVE policy (the inherited
 * values) overlaid with any explicit fields already on the grant — so
 * opening "Custom" shows the values currently in force. The effective
 * policy already merged the override, so it IS the prefill.
 *
 * Pass the RAW grant too so a multi-provider allowlist (which the
 * single-select can't represent) is captured into `providersOriginal` and
 * preserved on save. When omitted (e.g. inherit/false grant), no original
 * list is carried.
 */
export function formFromEffective(effective: EffectivePolicyView, grant?: SearchGrant): CapabilityForm {
  // Only carry the original list when it's UNREPRESENTABLE by the
  // single-select (>1 provider) — a single-element list round-trips
  // through the select faithfully and needs no preservation.
  const grantProviders =
    grant && typeof grant === "object" && Array.isArray(grant.providers) ? grant.providers : undefined;
  const preserve = isUnrepresentableProviderList(grantProviders) ? grantProviders : undefined;
  return {
    providers: providersToSelectValue(effective.providers),
    quota: effective.quota,
    maxResults: effective.maxResults,
    ...(preserve ? { providersOriginal: preserve } : {}),
    providersDirty: false,
  };
}

/**
 * Build the GRANT override object from the Custom form, FIELD-LEVEL: only
 * include a field when it DIFFERS from the inherited (effective-when-
 * inheriting) value, so unchanged fields keep tracking the instance
 * default. Mirrors the resolver's `{...instanceDef, ...definedFields}`.
 *
 * `inherited` is the effective policy computed with a pure-`"inherit"`
 * grant (i.e. the instance defaults) — pass it so "same as inherited" is
 * detectable. An all-inherited form collapses to `"inherit"` (no object),
 * matching the resolver: an empty override === inherit.
 */
export function buildOverride(
  form: CapabilityForm,
  inherited: EffectivePolicyView,
): SearchGrant {
  const override: { quota?: number; maxResults?: number; providers?: string[] | "inherit" } = {};

  // providers — three cases, in priority order:
  //  1. The admin ACTIVELY changed the select (`providersDirty`): honor it —
  //     a concrete provider pins `[provider]`; `"inherit"` tracks the default.
  //  2. NOT dirty, original grant carried a multi-provider list the
  //     single-select can't represent: PRESERVE the original list verbatim
  //     (never silently widen a §8 ceiling to inherit). [the fix]
  //  3. NOT dirty, no special original: pin a concrete provider if shown,
  //     else inherit (omit).
  if (form.providersDirty) {
    if (form.providers !== "inherit") override.providers = [form.providers];
  } else if (isUnrepresentableProviderList(form.providersOriginal)) {
    override.providers = form.providersOriginal!;
  } else if (form.providers !== "inherit") {
    override.providers = [form.providers];
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
 *  the caller passes the form + inherited for that case. */
export function grantForMode(
  mode: CapabilityMode,
  form: CapabilityForm,
  inherited: EffectivePolicyView,
): SearchGrant {
  if (mode === "disabled") return false;
  if (mode === "inherit") return "inherit";
  return buildOverride(form, inherited);
}

/**
 * Whether the Custom form is sitting on a multi-provider allowlist the
 * single-select can't represent AND the admin hasn't actively changed the
 * providers field. The panel surfaces a warning so the admin knows the
 * list is being PRESERVED (not editable here, not silently widened); the
 * moment they touch the select (`providersDirty`), the warning clears and
 * their explicit single-provider/inherit choice takes effect. */
export function hasPreservedProviderList(form: CapabilityForm): boolean {
  return !form.providersDirty && isUnrepresentableProviderList(form.providersOriginal);
}
