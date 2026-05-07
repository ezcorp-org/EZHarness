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

import type { CapabilityDeclaration } from "./types";

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
  | "ezcorp:events:subscribe";

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
      // Default to read+list+stat when no mode is set (most permissive
      // read-only), matching the migration's read-only default.
      if (wantsRead || modes.length === 0) {
        caps.push({ kind: "fs.read", value: path });
        caps.push({ kind: "fs.list", value: path });
        caps.push({ kind: "fs.stat", value: path });
      }
      if (wantsWrite) {
        caps.push({ kind: "fs.write", value: path });
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
