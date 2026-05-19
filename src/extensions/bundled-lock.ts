/**
 * Bundled extension manifest lock — Phase 5.
 *
 * Verifies that a bundled extension's on-disk manifest matches the
 * `manifest.lock.json` checked into the repo. The lockfile records
 * each bundled extension's:
 *
 *   - `version` string (manifest.version)
 *   - `entrypoint` string (manifest.entrypoint)
 *   - `toolsHash` — SHA-256 of the canonicalized `manifest.tools` array
 *
 * Any mismatch on any field returns `{ ok: false, reason }`. The caller
 * (`bundled.ts`'s manifest-refresh path) treats this as fail-closed:
 * disable the extension, write an audit row, do NOT proceed with the
 * refresh.
 *
 * Lockfile MISSING / MALFORMED is also fail-closed — a missing lockfile
 * means either the developer hasn't run the regenerate script
 * (operator error, fail visibly) or the file was deleted (potentially
 * malicious). Either way, refusing to load is safer than silently
 * falling back.
 *
 * The lockfile composes with `bundled-ceiling.ts` (which guards the
 * permission grant). Manifest tamper is caught even if an attacker
 * widens the ceiling; ceiling-violation is caught even if an attacker
 * regenerates the lockfile.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionManifestV2, ToolDefinition } from "./types";
import { logger } from "../logger";

const log = logger.child("bundled-lock");

export interface ManifestLockEntry {
  version: string;
  entrypoint: string;
  /** Canonicalized SHA-256 of `manifest.tools` array. */
  toolsHash: string;
}

export interface ManifestLockFile {
  schemaVersion: 1;
  generatedAt: string;
  extensions: Record<string, ManifestLockEntry>;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; expected?: unknown; actual?: unknown };

/**
 * Cache the parsed lockfile in memory. Tests reset via
 * `clearLockfileCache()`. The cache is keyed by absolute path so a
 * test that swaps lockfile location (via `setLockfilePathOverride`)
 * doesn't see stale data.
 *
 * `null` distinguishes "loaded and missing" from "not yet attempted"
 * (`undefined`). Callers should rely only on the return value of
 * `loadManifestLock()`, NOT on this internal cache.
 */
let lockfileCache: { path: string; value: ManifestLockFile | null } | undefined;

/** Test-only: override the resolved lockfile path. */
let lockfilePathOverride: string | undefined;

/**
 * Resolve the lockfile path. Walks up from this module to the project
 * root (mirrors `bundled.ts:getProjectRoot`) and joins
 * `manifest.lock.json`. Override available via `setLockfilePathOverride`
 * for tests that exercise verify-against-temp-lockfile flows.
 */
export function resolveLockfilePath(): string {
  if (lockfilePathOverride) return lockfilePathOverride;
  // Mirror `bundled.ts:getProjectRoot` — keep this deliberately
  // duplicated so a future split of bundled.ts doesn't accidentally
  // change which file we consult.
  let root: string | undefined;
  if (typeof import.meta.dir === "string" && import.meta.dir.includes("src/extensions")) {
    root = join(import.meta.dir, "..", "..");
  } else {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const lastIdx = thisFile.lastIndexOf("/src/extensions/");
      if (lastIdx >= 0) root = thisFile.substring(0, lastIdx);
    } catch { /* not a file URL */ }
  }
  if (!root) root = process.cwd();
  return join(root, "manifest.lock.json");
}

/** Test-only seam: override the lockfile path. Pass `undefined` to reset. */
export function setLockfilePathOverride(path: string | undefined): void {
  lockfilePathOverride = path;
  lockfileCache = undefined;
}

/** Test-only seam: drop the in-memory cache so the next call re-reads disk. */
export function clearLockfileCache(): void {
  lockfileCache = undefined;
}

/**
 * Load the lockfile from disk, returning a parsed object or `null` if
 * the file is missing OR malformed (both treated as fail-closed signals
 * for the caller).
 *
 * Cached after first successful read for the lifetime of the process —
 * the lockfile is intentionally read at startup only; live reloading
 * would defeat the boot-gate.
 */
export async function loadManifestLock(): Promise<ManifestLockFile | null> {
  const path = resolveLockfilePath();
  if (lockfileCache && lockfileCache.path === path) {
    return lockfileCache.value;
  }

  let value: ManifestLockFile | null = null;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      log.warn("manifest.lock.json missing — fail-closed for bundled extensions", { path });
      lockfileCache = { path, value: null };
      return null;
    }
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      log.error("manifest.lock.json is malformed JSON — fail-closed", {
        path,
        error: String(parseErr),
      });
      lockfileCache = { path, value: null };
      return null;
    }
    if (!isValidLockfile(parsed)) {
      log.error("manifest.lock.json failed schema check — fail-closed", { path });
      lockfileCache = { path, value: null };
      return null;
    }
    value = parsed;
  } catch (readErr) {
    log.error("manifest.lock.json read failed — fail-closed", {
      path,
      error: String(readErr),
    });
    lockfileCache = { path, value: null };
    return null;
  }

  lockfileCache = { path, value };
  return value;
}

function isValidLockfile(x: unknown): x is ManifestLockFile {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return false;
  if (typeof obj.generatedAt !== "string") return false;
  if (!obj.extensions || typeof obj.extensions !== "object") return false;
  for (const [, entry] of Object.entries(obj.extensions as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.version !== "string") return false;
    if (typeof e.entrypoint !== "string") return false;
    if (typeof e.toolsHash !== "string") return false;
  }
  return true;
}

/**
 * Verify a manifest's tool-list / entrypoint / version against the lockfile.
 *
 * Returns `{ ok: true }` only if the lockfile loaded successfully, has
 * an entry for the named extension, and ALL three fields match.
 * Otherwise `{ ok: false, reason, expected?, actual? }` — the caller
 * disables the extension and writes an audit row.
 */
export async function verifyManifestAgainstLock(
  extensionName: string,
  manifest: ExtensionManifestV2,
): Promise<VerifyResult> {
  const lock = await loadManifestLock();
  if (!lock) {
    return {
      ok: false,
      reason: "manifest.lock.json missing or malformed — fail-closed",
    };
  }

  const entry = lock.extensions[extensionName];
  if (!entry) {
    return {
      ok: false,
      reason: `no lockfile entry for extension '${extensionName}'`,
    };
  }

  if (manifest.version !== entry.version) {
    return {
      ok: false,
      reason: "version drift",
      expected: entry.version,
      actual: manifest.version,
    };
  }

  // Entrypoint MAY be optional in v2 manifests for non-tool packages.
  // If the lockfile records an empty string, both sides must agree on
  // its absence. Otherwise exact-match.
  const manifestEntrypoint = manifest.entrypoint ?? "";
  if (manifestEntrypoint !== entry.entrypoint) {
    return {
      ok: false,
      reason: "entrypoint drift",
      expected: entry.entrypoint,
      actual: manifestEntrypoint,
    };
  }

  const computedHash = canonicalizeAndHash(manifest.tools ?? []);
  if (computedHash !== entry.toolsHash) {
    return {
      ok: false,
      reason: "tool-list drift",
      expected: entry.toolsHash,
      actual: computedHash,
    };
  }

  return { ok: true };
}

/**
 * Compute the canonical-JSON SHA-256 of a tools array.
 *
 * Canonicalization rules (deterministic across runs / authors):
 *   1. Sort tools by `name` (case-sensitive, lexicographic).
 *   2. For each tool, sort its top-level keys alphabetically.
 *   3. For nested `inputSchema`, recursively sort object keys; arrays
 *      preserve their original order (JSON Schema array semantics
 *      are positional — `type: ["string","null"]` means something
 *      different from `["null","string"]` to some validators).
 *   4. Serialize as compact JSON (no whitespace).
 *
 * Returns a `sha256-…` prefixed base64 digest so a future digest-algo
 * migration (sha512, blake3) can co-exist via prefix discrimination.
 */
export function canonicalizeAndHash(tools: ToolDefinition[]): string {
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const canonical = sortedTools.map(canonicalizeTool);
  const json = JSON.stringify(canonical);
  const digest = createHash("sha256").update(json).digest("base64");
  return `sha256-${digest}`;
}

/**
 * Canonical form of a single ToolDefinition: top-level keys sorted,
 * `inputSchema` deeply-sorted, function-valued fields stripped.
 */
function canonicalizeTool(tool: ToolDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(tool).sort();
  for (const key of keys) {
    const value = (tool as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") continue;
    if (value === undefined) continue;
    out[key] = canonicalizeValue(value);
  }
  return out;
}

/** Recursively sort object keys; preserve array order. */
function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined || typeof v === "function") continue;
      out[key] = canonicalizeValue(v);
    }
    return out;
  }
  return value;
}
