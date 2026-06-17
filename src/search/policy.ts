/**
 * The 3-layer capability POLICY resolver (the heart of Phase 2).
 *
 * Layering — narrowest wins, FIELD-LEVEL (mirrors
 * `resolveExtensionSettings()` at `src/db/queries/extension-settings.ts`,
 * lifted from declared↔user to instance↔extension):
 *
 *   hard default (code)
 *     < instance default (admin global `*:*` settings)
 *       < per-extension grant override (`grantedPermissions.<cap>`)
 *
 * The grant override is the §3.1 three-state shape:
 *   - `false`     → DENIED. The handler soft-fails ("disabled").
 *   - `"inherit"` → use the live instance defaults (NOT a snapshot, so
 *                   changing an instance default propagates to every
 *                   inheriting extension).
 *   - `{…}`       → explicit, FIELD-LEVEL override. Only the fields the
 *                   override DEFINES win; undefined fields fall through to
 *                   the instance default. `providers: "inherit"` on a field
 *                   means "track the instance default for providers only".
 *
 * `resolveCapabilityPolicy(cap, …)` is the generic signature — search is
 * the first `cap`. `memory` / `llm` can adopt it later with no rework
 * (locked decision §1.7). v1 wires search via `resolveSearchPolicy`.
 */
import { getSetting } from "../db/queries/settings";
import { KNOWN_SEARCH_PROVIDERS } from "../extensions/clamp-permissions";
import type { ExtensionPermissions, SettingsField } from "../extensions/types";

/** Provider allowlist: an explicit list, or `"all"` (no restriction). */
export type ProviderAllowlist = string[] | "all";

/** The resolved, enforceable policy for a search-capable extension. */
export interface SearchPolicy {
  /** Per-day call quota ceiling. */
  quota: number;
  /** Max results clamp per search-web call. */
  maxResults: number;
  /** Allowed provider names, or `"all"`. */
  providers: ProviderAllowlist;
}

/** `false` grant → the resolver reports DENIED rather than a policy. */
export type ResolvedSearchPolicy =
  | { denied: true }
  | ({ denied: false } & SearchPolicy);

/** Hard defaults (code) — §3.3. The floor every other layer falls back to. */
export const HARD_SEARCH_DEFAULTS: SearchPolicy = {
  quota: 100,
  maxResults: 5,
  providers: "all",
};

/** The `global:search:*` instance-default setting keys (admin-only). */
export const SEARCH_SETTING_KEYS = {
  allowedByDefault: "global:search:allowedByDefault",
  defaultQuota: "global:search:defaultQuota",
  defaultMaxResults: "global:search:defaultMaxResults",
  defaultProviders: "global:search:defaultProviders",
} as const;

function asPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function asProviderAllowlist(v: unknown, fallback: ProviderAllowlist): ProviderAllowlist {
  if (v === "all") return "all";
  if (Array.isArray(v)) {
    const list = v.filter((p): p is string => typeof p === "string" && p.length > 0);
    return list.length > 0 ? list : "all";
  }
  return fallback;
}

/**
 * Read the instance-default layer (the `global:search:*` settings),
 * falling back to the hard defaults per field. A missing / malformed
 * setting never throws — it degrades to the hard default for that field.
 */
export async function getSearchInstanceDefaults(): Promise<SearchPolicy> {
  const [quota, maxResults, providers] = await Promise.all([
    getSetting(SEARCH_SETTING_KEYS.defaultQuota),
    getSetting(SEARCH_SETTING_KEYS.defaultMaxResults),
    getSetting(SEARCH_SETTING_KEYS.defaultProviders),
  ]);
  return {
    quota: asPositiveInt(quota, HARD_SEARCH_DEFAULTS.quota),
    maxResults: asPositiveInt(maxResults, HARD_SEARCH_DEFAULTS.maxResults),
    providers: asProviderAllowlist(providers, HARD_SEARCH_DEFAULTS.providers),
  };
}

/**
 * Whether new extensions get `"inherit"` (allowed) or `false` at install
 * — the `global:search:allowedByDefault` toggle (default true). Returned
 * for the install path; the resolver itself only reads the policy fields.
 */
export async function getSearchAllowedByDefault(): Promise<boolean> {
  const v = await getSetting(SEARCH_SETTING_KEYS.allowedByDefault);
  // Default ON — only an explicit `false` opts out.
  return v === undefined ? true : v !== false;
}

/**
 * PURE field-level merge of a grant override over the instance default.
 * Exported so the handler / tests can resolve without a DB round-trip
 * when the instance defaults are already in hand. Mirrors
 * `{ ...instanceDef, ...definedFieldsOf(override) }`.
 */
export function mergeSearchPolicy(
  grantOverride: ExtensionPermissions["search"],
  instanceDef: SearchPolicy,
): ResolvedSearchPolicy {
  if (grantOverride === false) return { denied: true };
  // `"inherit"`, `undefined`, or an absent grant → the instance defaults
  // verbatim. (Phase-1 handler already denies absent/false BEFORE the
  // resolver runs; `undefined` here is treated as inherit for safety.)
  if (grantOverride === "inherit" || grantOverride === undefined) {
    return { denied: false, ...instanceDef };
  }
  // Object override — field-level. Only DEFINED fields win; `providers:
  // "inherit"` tracks the instance default for the providers field only.
  return {
    denied: false,
    quota: grantOverride.quota !== undefined ? grantOverride.quota : instanceDef.quota,
    maxResults:
      grantOverride.maxResults !== undefined ? grantOverride.maxResults : instanceDef.maxResults,
    providers:
      grantOverride.providers === undefined || grantOverride.providers === "inherit"
        ? instanceDef.providers
        : grantOverride.providers,
  };
}

/**
 * Generic 3-layer resolver — search is the first `cap`. Reads the
 * instance-default layer for `cap`, then field-level-merges the grant
 * override on top. `memory` / `llm` adopt this by adding a branch on
 * `cap` (their instance-default readers) with no change to the merge
 * semantics.
 */
export async function resolveCapabilityPolicy(
  cap: "search",
  grantOverride: ExtensionPermissions["search"],
): Promise<ResolvedSearchPolicy> {
  // `cap` is a single-member union today; the switch is the seam for
  // memory/llm to plug in their own instance-default readers later.
  switch (cap) {
    case "search": {
      const instanceDef = await getSearchInstanceDefaults();
      return mergeSearchPolicy(grantOverride, instanceDef);
    }
  }
}

/**
 * Resolve the effective search policy for an extension's grant override.
 * The grant lives on the handler's `ctx.granted.search`; pass it in so
 * the resolver stays decoupled from the registry (and trivially
 * testable). Called by `search-handler.ts` before EVERY search.
 */
export function resolveSearchPolicy(
  grantOverride: ExtensionPermissions["search"],
): Promise<ResolvedSearchPolicy> {
  return resolveCapabilityPolicy("search", grantOverride);
}

/** Whether a resolved policy permits a given provider name. */
export function providerAllowed(policy: SearchPolicy, providerName: string): boolean {
  return policy.providers === "all" || policy.providers.includes(providerName);
}

// ── §3.4 Capability-contributed settings schema (the UI bridge) ──────

/** A capability schema field carries its setting KEY alongside the
 *  manifest `SettingsField` declaration, so the UI renders the fields in
 *  a stable order (provider → quota → maxResults) and writes back by key.
 *  Reuses the manifest `SettingsField` types (§3.4) — the Capabilities
 *  panel renders these with the SAME field widgets as `manifest.settings`. */
export interface CapabilitySettingsField {
  key: string;
  field: SettingsField;
}

/** The §5.2 settings-API payload for ONE held host capability: the
 *  capability id, its contributed schema, the resolved EFFECTIVE policy
 *  (what the handler enforces right now), and the raw grant state (so the
 *  UI can pick Inherit / Custom / Disabled). */
export interface HeldCapability {
  cap: "search";
  schema: CapabilitySettingsField[];
  /** The resolved policy — `{ denied: true }` when the grant is `false`. */
  effective: ResolvedSearchPolicy;
  /** The raw grant state: `"inherit"` | `false` | `{…override}` | undefined. */
  grant: ExtensionPermissions["search"];
}

/**
 * Build the §5.2 capabilities payload for an extension grant: for each
 * HOST capability the extension holds (v1: search — presence of a
 * `search` key on the grant), return its contributed schema + resolved
 * effective policy + raw grant. Reads the instance defaults ONCE.
 *
 * Returns `[]` for an extension that holds no host capability (no
 * `search` key) — the UI then renders no Capabilities section. Generic by
 * construction: memory/llm add their grant-key checks here later.
 */
export async function getHeldCapabilities(
  granted: ExtensionPermissions | null | undefined,
): Promise<HeldCapability[]> {
  if (!granted) return [];
  const held: HeldCapability[] = [];
  // `search` is "held" when the grant carries the key at all (any of the
  // three states — including `false`, so an admin can see + re-enable a
  // disabled capability rather than it vanishing from the UI).
  if ("search" in granted && granted.search !== undefined) {
    const instanceDefaults = await getSearchInstanceDefaults();
    held.push({
      cap: "search",
      schema: getCapabilitySettingsSchema("search", instanceDefaults),
      effective: mergeSearchPolicy(granted.search, instanceDefaults),
      grant: granted.search,
    });
  }
  return held;
}

/**
 * Build the capability-contributed `SettingsField` schema for a host
 * capability, with each field's `default` sourced from the live INSTANCE
 * defaults (so the "Custom" UI prefills the inherited values as
 * placeholders). Generic by `cap` — search is the first; `memory` / `llm`
 * add a branch later with no change to the consumers (locked decision
 * §1.7). An unknown / not-yet-wired capability returns `[]`.
 *
 * The `providers` field is a `select` whose option set is the KNOWN
 * provider list plus an explicit "all" sentinel (the instance default may
 * be `"all"` or a list; the select represents the single-choice common
 * case — a richer multi-select is a Phase-3.x polish, out of v1 scope).
 */
export function getCapabilitySettingsSchema(
  cap: string,
  instanceDefaults: SearchPolicy,
): CapabilitySettingsField[] {
  if (cap !== "search") return [];
  return [
    {
      key: "providers",
      field: {
        type: "select",
        // The grant's `providers` field is `string[] | "inherit"` — there
        // is no literal "all" at the grant tier (only the instance default
        // can be "all"). So the override choices are: track the instance
        // default ("inherit") or pin ONE specific provider.
        label: "Allowed providers",
        description:
          "Restrict this extension to one search backend, or inherit the instance default.",
        options: [
          { value: "inherit", label: "Inherit (instance default)" },
          ...KNOWN_SEARCH_PROVIDERS.map((p) => ({ value: p, label: p })),
        ],
        default: "inherit",
      },
    },
    {
      key: "quota",
      field: {
        type: "number",
        label: "Daily quota",
        description: "Max search calls per day for this extension.",
        default: instanceDefaults.quota,
        min: 1,
        integer: true,
      },
    },
    {
      key: "maxResults",
      field: {
        type: "number",
        label: "Max results",
        description: "Max results returned per search-web call.",
        default: instanceDefaults.maxResults,
        min: 1,
        integer: true,
      },
    },
  ];
}
