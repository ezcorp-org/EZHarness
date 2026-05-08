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

  // appendMessages — both sides must declare; AND `excludedDefault`
  // (true ∧ true is the only safe shape — the field's intent is "force
  // exclude unless both sides agreed otherwise").
  if (a.appendMessages && b.appendMessages) {
    out.appendMessages = {
      excludedDefault:
        a.appendMessages.excludedDefault === true &&
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
      (key === "eventSubscriptions" && out.eventSubscriptions);
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
