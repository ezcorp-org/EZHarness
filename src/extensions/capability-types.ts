/**
 * Capability discriminated union — single source of truth for the runtime
 * capability shape consumed by the Policy Decision Point
 * (`./permission-engine.ts`).
 *
 * Each `Capability` is a `{kind, value?}` pair. Comparisons go through
 * `intersect` and `isSubset` so capability-comparison logic lives in
 * exactly one place.
 *
 * Per phase-1 spec:
 *   - `network`  — `value` = lowercase hostname
 *   - `fs.*`     — `value` = absolute path
 *   - `shell`    — `value` = undefined (boolean today; per-command-prefix
 *                   allowlists are deferred)
 *   - `env`      — `value` = env var name
 *   - `storage`  — `value` = undefined (boolean)
 *   - `ezcorp:*` — namespaced caps (chat, agent config, spawn, tasks,
 *                   events). `value` is undefined for the boolean variants.
 *
 * Phase 2 will extend `capabilityDeclarationToSet` to substitute runtime
 * values from the tool's actual call args (URL host, fs path, etc.). In
 * Phase 1 it produces caps from the static declaration only; the resolver
 * `_args` parameter is reserved for that future work.
 */

import type { CapabilityDeclaration, ExtensionPermissions } from "./types";
import { expandGrantPrefix } from "./permissions";

export type CapabilityKind =
  | "network"
  | "fs.read"
  | "fs.write"
  | "fs.list"
  | "fs.stat"
  | "shell"
  | "env"
  | "storage"
  | "ezcorp:chat:append"
  | "ezcorp:agent:config"
  | "ezcorp:agent:spawn"
  | "ezcorp:tasks:emit"
  | "ezcorp:events:subscribe"
  // Install an authored extension draft. Sensitive + ALWAYS prompts
  // (even for the bundled extension-author) and is NEVER persisted as
  // an always-allow grant — see the carve-outs in
  // `permission-engine.ts`. Granted only via the existing
  // `custom.drafts.kinds:["extension"]` permission (bundled-only).
  | "ezcorp:extension:install";

export interface Capability {
  kind: CapabilityKind;
  value?: string;
}

export type CapabilitySet = readonly Capability[];

/**
 * Sensitive caps (Phase 1). When `needed` includes any of these AND
 * always-allow is not set for the (user, scope, scopeId, capability)
 * tuple, the engine returns `prompt`. Phase 6 will wire the UI; Phase 1
 * treats `prompt` as `allow` to avoid behavioral regression.
 */
export const SENSITIVE_KINDS: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  "shell",
  "fs.write",
  // Installing model-authored code that then runs with its declared
  // permissions is the strongest trust boundary in the system — gate
  // it like the other sensitive caps so the engine returns `prompt`.
  "ezcorp:extension:install",
]);

/** Lowercase, trimmed key for set-keyed comparison. */
function keyOf(c: Capability): string {
  return `${c.kind}::${c.value ?? ""}`;
}

/**
 * Set intersection: caps present in BOTH a and b. Used by Phase 4's
 * cross-extension confused-deputy gate (`callerCaps ∩ calleeCaps`).
 *
 * Comparison is by `(kind, value)` exact match. Hostname normalization
 * (lowercase) and path normalization are the caller's responsibility.
 */
export function intersect(a: CapabilitySet, b: CapabilitySet): CapabilitySet {
  const seen = new Set(b.map(keyOf));
  const out: Capability[] = [];
  const dedup = new Set<string>();
  for (const c of a) {
    const k = keyOf(c);
    if (seen.has(k) && !dedup.has(k)) {
      dedup.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * Subset check: every cap in `needed` is present in `granted`. The PDP
 * uses this to decide allow vs deny.
 *
 * Path-prefix semantics for fs.* caps: a granted cap with `value=/foo`
 * covers a needed cap with `value=/foo/bar`. Hostname matching for
 * `network` is exact (Phase 2 may relax to suffix-match).
 */
export function isSubset(needed: CapabilitySet, granted: CapabilitySet): boolean {
  for (const n of needed) {
    if (!granted.some((g) => capabilityCovers(g, n))) return false;
  }
  return true;
}

/**
 * Does granted-cap `g` cover required-cap `n`? Encapsulates the
 * per-kind matching semantics so `intersect`/`isSubset` stay simple.
 */
export function capabilityCovers(g: Capability, n: Capability): boolean {
  if (g.kind !== n.kind) return false;

  // Boolean caps (no value): kind match is enough.
  if (g.value === undefined && n.value === undefined) return true;
  if (g.value === undefined || n.value === undefined) return false;

  // Filesystem prefix-match: `/foo` covers `/foo` and `/foo/bar/baz` but
  // NOT `/foobar`. Mirrors `checkFilesystemPermission`'s prefix logic.
  if (g.kind === "fs.read" || g.kind === "fs.write" || g.kind === "fs.list" || g.kind === "fs.stat") {
    return n.value === g.value || n.value.startsWith(g.value + "/");
  }

  // Network / env / namespaced caps: exact value match.
  return g.value === n.value;
}

/**
 * Find the first needed-cap not covered by granted. Used by the engine
 * to produce a deny reason that names the missing cap.
 */
export function firstMissingCapability(
  needed: CapabilitySet,
  granted: CapabilitySet,
): Capability | null {
  for (const n of needed) {
    if (!granted.some((g) => capabilityCovers(g, n))) return n;
  }
  return null;
}

/**
 * Translate a tool's manifest-level `CapabilityDeclaration` (declared at
 * authoring time, structurally typed in `./types.ts`) plus the actual
 * call args into a flat `CapabilitySet`.
 *
 * Phase 1 only handles the static-declaration path — `_args` is unused
 * but reserved for Phase 2, which will substitute runtime values
 * (URL host extracted from a fetch arg, fs.path normalized to its
 * realpath, etc.).
 */
export function capabilityDeclarationToSet(
  decl: CapabilityDeclaration | undefined,
  _args: Record<string, unknown>,
): CapabilitySet {
  if (!decl) return [];
  const caps: Capability[] = [];

  if (decl.network?.hosts) {
    for (const host of decl.network.hosts) {
      caps.push({ kind: "network", value: host.toLowerCase() });
    }
  }

  if (decl.filesystem?.paths) {
    const modes = decl.filesystem.mode ?? [];
    const wantsRead = modes.includes("read");
    const wantsWrite = modes.includes("write");
    for (const path of decl.filesystem.paths) {
      // Same `$CWD` expansion as the granted-cap side above so the
      // PDP's needed↔granted comparison stays consistent. A tool that
      // declares `filesystem.paths: ["$CWD"]` for its required cap must
      // match a grant for the same logical root, not the literal string.
      const expanded = expandGrantPrefix(path);
      // Default to read+list+stat when no mode is set (most permissive
      // read-only), matching the migration's read-only default.
      if (wantsRead || modes.length === 0) {
        caps.push({ kind: "fs.read", value: expanded });
        caps.push({ kind: "fs.list", value: expanded });
        caps.push({ kind: "fs.stat", value: expanded });
      }
      if (wantsWrite) {
        caps.push({ kind: "fs.write", value: expanded });
      }
    }
  }

  if (decl.shell === true) {
    caps.push({ kind: "shell" });
  }

  if (decl.env) {
    for (const name of decl.env) {
      caps.push({ kind: "env", value: name });
    }
  }

  if (decl.storage === true) {
    caps.push({ kind: "storage" });
  }

  // Namespaced custom caps. Translate `appendMessages`/`agentConfig`/
  // `taskEvents`/`spawnAgents`/`eventSubscriptions` boolean keys to
  // their `ezcorp:*` form. Other keys are dropped (unknown — Phase 6
  // will widen this).
  if (decl.custom) {
    for (const [key, val] of Object.entries(decl.custom)) {
      const kind = customToKind(key);
      if (!kind) continue;
      if (Array.isArray(val)) {
        for (const v of val) caps.push({ kind, value: v });
      } else if (val === true) {
        caps.push({ kind });
      }
    }
  }

  return caps;
}

/**
 * Intersect two `ExtensionPermissions` shapes (manifest-level), the way
 * Phase 4's spawn-assignment uses to clip a child conversation's grants
 * by the parent's effective grants. Mirrors the semantics of
 * `intersect(CapabilitySet)` but stays at the manifest-permissions
 * level so callers can persist the result back into
 * `conversation_extensions.effective_granted_permissions` without an
 * intermediate flatten/lift step.
 *
 * Per-field rules:
 *   • `network`     — array intersection, lowercased + deduped
 *   • `filesystem`  — path-prefix intersection: a path survives only
 *                     when it has a covering prefix in BOTH sides
 *                     (mirrors `capabilityCovers` for `fs.*`)
 *   • `shell`       — boolean AND
 *   • `env`         — array intersection
 *   • `storage`     — boolean AND
 *   • `taskEvents`  — boolean AND
 *   • `agentConfig` — both sides "read" → "read", else absent
 *   • `spawnAgents` — min(maxPerHour) + min(maxConcurrent), absent if
 *                     either side absent (the more restrictive wins)
 *   • `appendMessages` — both sides present + AND on `excludedDefault`
 *   • `eventSubscriptions` — array intersection
 *
 * `grantedAt` is rebuilt from the keys that survived intersection,
 * preferring the OLDER timestamp of either side so an audit trail
 * can't reset its issue date by intersection. The result has `grantedAt`
 * with only the keys that survived — empty `{}` when nothing did.
 */
export function intersectPermissions(
  a: ExtensionPermissions,
  b: ExtensionPermissions,
): ExtensionPermissions {
  const out: ExtensionPermissions = { grantedAt: {} };

  // network — array intersection (lowercased)
  if (a.network && b.network) {
    const bSet = new Set(b.network.map((h) => h.toLowerCase()));
    const seen = new Set<string>();
    const list: string[] = [];
    for (const h of a.network) {
      const k = h.toLowerCase();
      if (bSet.has(k) && !seen.has(k)) {
        seen.add(k);
        list.push(k);
      }
    }
    if (list.length > 0) out.network = list;
  }

  // filesystem — path-prefix intersection (a path survives if it's in
  // BOTH allowlists' prefix-cover relations). The narrower of two
  // prefix-overlapping paths wins (e.g. `/foo` vs `/foo/bar` →
  // `/foo/bar`).
  if (a.filesystem && b.filesystem) {
    const survivors = new Set<string>();
    const covers = (g: string, n: string) =>
      g === n || n.startsWith(g + "/");
    for (const pa of a.filesystem) {
      for (const pb of b.filesystem) {
        if (covers(pa, pb)) survivors.add(pb);
        else if (covers(pb, pa)) survivors.add(pa);
      }
    }
    if (survivors.size > 0) out.filesystem = [...survivors];
  }

  // shell — boolean AND
  if (a.shell === true && b.shell === true) {
    out.shell = true;
  }

  // env — array intersection
  if (a.env && b.env) {
    const bSet = new Set(b.env);
    const seen = new Set<string>();
    const list: string[] = [];
    for (const e of a.env) {
      if (bSet.has(e) && !seen.has(e)) {
        seen.add(e);
        list.push(e);
      }
    }
    if (list.length > 0) out.env = list;
  }

  // storage — boolean AND
  if (a.storage === true && b.storage === true) {
    out.storage = true;
  }

  // taskEvents — boolean AND
  if (a.taskEvents === true && b.taskEvents === true) {
    out.taskEvents = true;
  }

  // agentConfig — both must be "read" for "read" to survive
  if (a.agentConfig === "read" && b.agentConfig === "read") {
    out.agentConfig = "read";
  }

  // spawnAgents — both sides must declare; take the min of each
  // numeric ceiling so the more restrictive wins.
  if (a.spawnAgents && b.spawnAgents) {
    const hourly = Math.min(a.spawnAgents.maxPerHour, b.spawnAgents.maxPerHour);
    const concurrentA = a.spawnAgents.maxConcurrent;
    const concurrentB = b.spawnAgents.maxConcurrent;
    let concurrent: number | undefined;
    if (concurrentA !== undefined && concurrentB !== undefined) {
      concurrent = Math.min(concurrentA, concurrentB);
    } else if (concurrentA !== undefined) {
      concurrent = concurrentA;
    } else if (concurrentB !== undefined) {
      concurrent = concurrentB;
    }
    if (hourly > 0) {
      out.spawnAgents = concurrent !== undefined
        ? { maxPerHour: hourly, maxConcurrent: concurrent }
        : { maxPerHour: hourly };
    }
  }

  // appendMessages — both sides must declare; OR on `excludedDefault`
  // (force-exclude wins on either side). This is the correct CLIP
  // semantics for a "default exclude this turn from history" toggle:
  // intersection should never RELAX a restriction. If EITHER side
  // says "exclude by default", the result excludes; AND would have
  // let `false ∩ true → false` accidentally publish turns the more
  // restrictive side wanted to hide.
  if (a.appendMessages && b.appendMessages) {
    out.appendMessages = {
      excludedDefault:
        a.appendMessages.excludedDefault === true ||
        b.appendMessages.excludedDefault === true,
    };
  }

  // eventSubscriptions — array intersection (case-sensitive event names)
  if (a.eventSubscriptions && b.eventSubscriptions) {
    const bSet = new Set(b.eventSubscriptions);
    const seen = new Set<string>();
    const list: string[] = [];
    for (const e of a.eventSubscriptions) {
      if (bSet.has(e) && !seen.has(e)) {
        seen.add(e);
        list.push(e);
      }
    }
    if (list.length > 0) out.eventSubscriptions = list;
  }

  // ── Phase 53 capability tiers (`llm`, `memory`, `lessons`, `schedule`).
  // These survive when both sides declare them. Bundled extension
  // ceilings are written in `bundled-ceiling.ts` to mirror the install
  // grant verbatim, so the intersection should be a no-op for the
  // happy path. The intersection rule is "narrower of the two" on
  // each numeric ceiling and "intersection of provider/category lists"
  // on the array fields. Today only bundled extensions reach this
  // code path through `clampToBundledCeiling`, but the rule is
  // future-proof for user-installed exts that gain LLM access.
  if (a.llm && b.llm) {
    // Provider intersection — both sides always have `providers` (required
    // on the granted shape). Empty intersection is allowed (zero providers
    // means "no LLM access", a valid clamped state).
    const aProviders = new Set(a.llm.providers);
    const providers = b.llm.providers.filter((p) => aProviders.has(p));
    const llmOut: NonNullable<ExtensionPermissions["llm"]> = {
      providers,
      maxCallsPerHour: Math.min(a.llm.maxCallsPerHour, b.llm.maxCallsPerHour),
      maxCallsPerDay: Math.min(a.llm.maxCallsPerDay, b.llm.maxCallsPerDay),
    };
    // Optional numeric ceilings — narrower of the two when both present,
    // pass-through when only one side declares.
    const tokensPerCall =
      a.llm.maxTokensPerCall !== undefined && b.llm.maxTokensPerCall !== undefined
        ? Math.min(a.llm.maxTokensPerCall, b.llm.maxTokensPerCall)
        : (a.llm.maxTokensPerCall ?? b.llm.maxTokensPerCall);
    if (tokensPerCall !== undefined) llmOut.maxTokensPerCall = tokensPerCall;
    if (a.llm.allowedModels || b.llm.allowedModels) {
      llmOut.allowedModels = intersectAllowedModels(a.llm.allowedModels, b.llm.allowedModels);
    }
    out.llm = llmOut;
  }
  if (a.memory && b.memory) {
    out.memory = {
      access: a.memory.access === "write" && b.memory.access === "write" ? "write" : "read",
      maxWritesPerDay: Math.min(a.memory.maxWritesPerDay, b.memory.maxWritesPerDay),
      // selfOnly is OR — the more restrictive setting wins (false ∩
      // true → true, the safer default for any user-installed
      // extension reaching this path). Bundled-only `selfOnly: false`
      // is preserved when BOTH sides explicitly opt out (memory-extractor's
      // ceiling matches its declaration verbatim — see bundled-ceiling.ts).
      selfOnly: a.memory.selfOnly || b.memory.selfOnly,
      ...(a.memory.categories && b.memory.categories
        ? {
            categories: a.memory.categories.filter((c) => b.memory!.categories!.includes(c)),
          }
        : a.memory.categories
          ? { categories: a.memory.categories }
          : b.memory.categories
            ? { categories: b.memory.categories }
            : {}),
    };
  }
  if (a.lessons && b.lessons) {
    out.lessons = {
      access: a.lessons.access === "write" && b.lessons.access === "write" ? "write" : "read",
      maxWritesPerDay: Math.min(a.lessons.maxWritesPerDay, b.lessons.maxWritesPerDay),
      maxVisibility:
        a.lessons.maxVisibility === "project" && b.lessons.maxVisibility === "project"
          ? "project"
          : "user",
    };
  }
  if (a.schedule && b.schedule) {
    // Crons must be the same set (or a strict intersection); for a
    // bundled-ceiling clamp the ceiling mirrors the install verbatim,
    // so the intersection equals the input. For other callers we
    // intersect by exact-match.
    const crons = a.schedule.crons.filter((c) => b.schedule!.crons.includes(c));
    out.schedule = {
      crons,
      maxRunsPerDay: Math.min(a.schedule.maxRunsPerDay, b.schedule.maxRunsPerDay),
      maxRunDurationMs: Math.min(a.schedule.maxRunDurationMs, b.schedule.maxRunDurationMs),
      // Tighter missed-run policy wins: skip < fire-once < fire-all.
      missedRunPolicy: tighterMissedRunPolicy(a.schedule.missedRunPolicy, b.schedule.missedRunPolicy),
      maxRetries: Math.min(a.schedule.maxRetries, b.schedule.maxRetries),
    };
  }

  // custom — namespaced capability bag. Today the only registered key
  // is `drafts: { kinds: string[] }` used by `extension-author`. The
  // intersection rule is: a `kinds` array survives only when BOTH sides
  // declare it, and the result is the array intersection. Unknown keys
  // pass through when both sides declare them (defensive default —
  // future custom capabilities will spell out their own clamp rules).
  if (a.custom && b.custom) {
    const customOut: NonNullable<ExtensionPermissions["custom"]> = {};
    if (a.custom.drafts && b.custom.drafts) {
      const aKinds = new Set(a.custom.drafts.kinds);
      const kinds = b.custom.drafts.kinds.filter((k) => aKinds.has(k));
      if (kinds.length > 0) customOut.drafts = { kinds };
    }
    if (Object.keys(customOut).length > 0) out.custom = customOut;
  }

  // grantedAt — keep keys whose corresponding permission survived;
  // prefer the older grant timestamp (more conservative audit trail).
  const aAt = a.grantedAt ?? {};
  const bAt = b.grantedAt ?? {};
  for (const key of Object.keys({ ...aAt, ...bAt })) {
    const survived =
      (key === "network" && out.network) ||
      (key === "filesystem" && out.filesystem) ||
      (key === "shell" && out.shell) ||
      (key === "env" && out.env) ||
      (key === "storage" && out.storage) ||
      (key === "taskEvents" && out.taskEvents) ||
      (key === "agentConfig" && out.agentConfig) ||
      (key === "spawnAgents" && out.spawnAgents) ||
      (key === "appendMessages" && out.appendMessages) ||
      (key === "eventSubscriptions" && out.eventSubscriptions) ||
      (key === "llm" && out.llm) ||
      (key === "memory" && out.memory) ||
      (key === "lessons" && out.lessons) ||
      (key === "schedule" && out.schedule) ||
      (key === "custom" && out.custom);
    if (!survived) continue;
    const ta = typeof aAt[key] === "number" ? aAt[key] : undefined;
    const tb = typeof bAt[key] === "number" ? bAt[key] : undefined;
    if (ta !== undefined && tb !== undefined) {
      out.grantedAt[key] = Math.min(ta, tb);
    } else if (ta !== undefined) {
      out.grantedAt[key] = ta;
    } else if (tb !== undefined) {
      out.grantedAt[key] = tb;
    }
  }

  return out;
}

/**
 * Translate an `ExtensionPermissions` install-time GRANT blob into a
 * `CapabilitySet` for runtime intersection. Phase 4's `handlePiInvoke`
 * uses this on both caller and callee grants before computing
 * `intersect(callerCaps, calleeCaps)` so the PDP gates against what the
 * user actually authorized, not the manifest's declaration.
 *
 * Mirrors the semantics of `capabilityDeclarationToSet` but consumes
 * the `ExtensionPermissions` shape (flat arrays + booleans + structured
 * spawn fields) instead of `CapabilityDeclaration` (nested objects).
 *
 * Filesystem mode is treated as read+write at the runtime layer because
 * the v2 `permissions.filesystem` grant didn't separate modes — Phase 1
 * already encoded that as `["read","write"]` in
 * `migrateManifestV2ToV3`. v3 callers that want narrower modes pass
 * them via the per-tool `capabilities` declaration which the PDP
 * already enforces.
 */
export function grantsToCapabilitySet(
  grants: ExtensionPermissions | null,
): CapabilitySet {
  if (!grants) return [];
  const caps: Capability[] = [];

  if (grants.network) {
    for (const host of grants.network) {
      caps.push({ kind: "network", value: host.toLowerCase() });
    }
  }

  if (grants.filesystem) {
    for (const path of grants.filesystem) {
      // Expand `$CWD` (and `$CWD/<sub>`) at grant→cap translation time.
      // The fs-handler authorizes against the realpath-resolved absolute
      // path (see `fs-handler.ts:549` — `value: result.resolvedPath`),
      // so a literal `$CWD` cap value never prefix-matches the resolved
      // absolute path and the PDP wrongly denies a write that the
      // fs-handler's own pre-PDP `checkFilesystemPermission` already
      // approved (which DOES expand `$CWD`). Expanding here closes the
      // mirror gap so the PDP and fs-handler agree on what `$CWD` means.
      const expanded = expandGrantPrefix(path);
      caps.push({ kind: "fs.read", value: expanded });
      caps.push({ kind: "fs.list", value: expanded });
      caps.push({ kind: "fs.stat", value: expanded });
      caps.push({ kind: "fs.write", value: expanded });
    }
  }

  if (grants.shell === true) {
    caps.push({ kind: "shell" });
  }

  if (grants.env) {
    for (const name of grants.env) {
      caps.push({ kind: "env", value: name });
    }
  }

  if (grants.storage === true) {
    caps.push({ kind: "storage" });
  }

  if (grants.taskEvents === true) {
    caps.push({ kind: "ezcorp:tasks:emit" });
  }

  if (grants.agentConfig === "read") {
    caps.push({ kind: "ezcorp:agent:config" });
  }

  if (grants.spawnAgents) {
    caps.push({ kind: "ezcorp:agent:spawn" });
  }

  if (grants.eventSubscriptions) {
    for (const eventName of grants.eventSubscriptions) {
      caps.push({ kind: "ezcorp:events:subscribe", value: eventName });
    }
  }

  if (grants.appendMessages) {
    caps.push({ kind: "ezcorp:chat:append" });
  }

  // Derive the install cap from the existing drafts grant — an
  // extension granted `custom.drafts.kinds:["extension"]` (bundled-only:
  // `extension-author`) may REQUEST an install, but the actual install
  // ALWAYS goes through a mandatory user-approval prompt that is never
  // persisted (see `permission-engine.ts`). Adding it here only lets
  // the needed↔granted subset check pass so the request reaches that
  // prompt instead of being denied as an ungranted capability.
  if (grants.custom?.drafts?.kinds?.includes("extension")) {
    caps.push({ kind: "ezcorp:extension:install" });
  }

  return caps;
}

// ── Phase 53 helpers for `intersectPermissions` ────────────────────

/** Intersect two `allowedModels` maps. The result keeps a provider
 *  only if BOTH sides list it; the per-provider model list is the
 *  set intersection. Used for LLM permission intersection. */
function intersectAllowedModels(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined,
): Record<string, string[]> {
  if (!a || !b) return a ?? b ?? {};
  const out: Record<string, string[]> = {};
  for (const provider of Object.keys(a)) {
    const aModels = a[provider];
    const bModels = b[provider];
    if (!aModels || !bModels) continue;
    const intersection = aModels.filter((m) => bModels.includes(m));
    if (intersection.length > 0) out[provider] = intersection;
  }
  return out;
}

/** Tighter missed-run policy wins: `skip` ≺ `fire-once` ≺ `fire-all`.
 *  Used for schedule permission intersection. */
function tighterMissedRunPolicy(
  a: "skip" | "fire-once" | "fire-all",
  b: "skip" | "fire-once" | "fire-all",
): "skip" | "fire-once" | "fire-all" {
  const order: Record<string, number> = { skip: 0, "fire-once": 1, "fire-all": 2 };
  return order[a]! <= order[b]! ? a : b;
}

/** Map manifest-level custom keys to namespaced capability kinds. */
function customToKind(key: string): CapabilityKind | null {
  switch (key) {
    case "appendMessages":
    case "ezcorp:chat:append":
      return "ezcorp:chat:append";
    case "agentConfig":
    case "ezcorp:agent:config":
      return "ezcorp:agent:config";
    case "spawnAgents":
    case "ezcorp:agent:spawn":
      return "ezcorp:agent:spawn";
    case "taskEvents":
    case "ezcorp:tasks:emit":
      return "ezcorp:tasks:emit";
    case "eventSubscriptions":
    case "ezcorp:events:subscribe":
      return "ezcorp:events:subscribe";
    default:
      return null;
  }
}
