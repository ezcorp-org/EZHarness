/**
 * Pure URL-classification + allowlist logic for the sandbox's
 * `globalThis.fetch` wrapper.
 *
 * The wrapper itself lives in `sandbox-preload.ts` because it has to be
 * installed before the extension's module graph runs. The decision
 * logic — given a URL string, which "lane" should this fetch take? —
 * is extracted here so `bun test` can exercise the matrix without
 * spawning a subprocess for every case.
 *
 * Three lanes:
 *   1. INVALID URL ─────────────────────────────────────────────────
 *      Rejected before any network attempt — same throw shape as
 *      Phase 1's preload denier.
 *
 *   2. INTERNAL HOST ───────────────────────────────────────────────
 *      localhost / 127.0.0.1 / ::1 / RFC-1918 / link-local. The wrapper
 *      forwards the call to `ezcorp/network.internal` reverse-RPC; the
 *      host PDP enforces, the host performs the fetch, and the result
 *      streams back. SSRF protection: deny by default unless the manifest
 *      declared the specific internal host.
 *
 *   3. EXTERNAL HOST ───────────────────────────────────────────────
 *      Wrapper enforces per-host + per-tool allowlist locally:
 *      - Host MUST be in `EZCORP_PERMITTED_HOSTS` (extension-wide ceiling).
 *      - If a tool is currently running (ALS-bound) AND the per-tool
 *        capability map declares a host list for that tool, the host
 *        MUST also be in the per-tool list.
 *      - If no tool is running (e.g. fetch at module init time), the
 *        per-tool check is skipped — extension-wide ceiling applies.
 *
 * The host PDP is NOT consulted on this path — perf cost rejected by
 * the perf agent (2-3 orders of magnitude on streaming bodies). The
 * spawn-time env (`EZCORP_PERMITTED_HOSTS` + `EZCORP_TOOL_NETWORK_CAPS`)
 * is the sole source of truth for the wrapper.
 */

// Internal-host classification (regex + bracket normalizer) lives in
// `./internal-host.ts` so this wrapper and the host-side
// `network-handler.ts` agree on what "internal" means. Re-exported here
// for back-compat with existing test imports
// (network-wrapper.test.ts uses `INTERNAL_HOST_RE` / `normalizeHostname`
// against this module's surface).
import { INTERNAL_HOST_RE, normalizeHostname } from "./internal-host";
export { INTERNAL_HOST_RE, normalizeHostname };

/**
 * Outcome of URL classification. The wrapper switches on `kind`:
 *   - "invalid"   → throw immediately
 *   - "internal"  → reverse-RPC `ezcorp/network.internal`
 *   - "deny"      → throw with the supplied reason
 *   - "external"  → forward to the original `fetch` (host already vetted)
 */
export type NetworkDecision =
  | { kind: "invalid"; reason: string }
  | { kind: "internal"; host: string }
  | { kind: "deny"; reason: string }
  | { kind: "external" };

export interface ClassifyOptions {
  /** Lowercase hostnames the extension as a whole may reach. */
  permittedHosts: readonly string[];
  /** `{toolName: string[]}` — per-tool allowlist override. Empty = no override. */
  toolCaps: Readonly<Record<string, readonly string[]>>;
  /** Active tool name from ALS, or `undefined` when called outside any handler. */
  toolName?: string;
}

/**
 * Decide what the wrapper should do with `urlStr` given the spawn-time
 * env and the current ALS tool name. Pure — no I/O, no globals read.
 *
 * Internal hosts always route via reverse-RPC; the manifest gate (whether
 * the extension declared the internal host as permitted) lives on the
 * HOST side, not in the wrapper. This is correct: the wrapper can't
 * trust its own env for SSRF carve-outs.
 */
export function classifyFetch(
  urlStr: string,
  opts: ClassifyOptions,
): NetworkDecision {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { kind: "invalid", reason: "Extension sandbox: invalid URL passed to fetch()" };
  }

  const host = normalizeHostname(url.hostname);

  if (INTERNAL_HOST_RE.test(host)) {
    return { kind: "internal", host };
  }

  // Extension-wide ceiling. An empty allowlist means the extension was
  // not granted any external network access — every external host
  // denied. Per-tool overrides cannot widen the ceiling.
  if (opts.permittedHosts.length === 0 || !opts.permittedHosts.includes(host)) {
    const grantedClause = opts.permittedHosts.length
      ? ` (granted: ${opts.permittedHosts.join(", ")})`
      : "";
    return {
      kind: "deny",
      reason:
        `Extension sandbox: hostname '${host}' is not in the granted ` +
        `network allowlist${grantedClause}`,
    };
  }

  // Per-tool override. Only consulted when a tool is currently running
  // (ALS-bound) AND that tool has its own host list declared in the
  // capability map. Tools without a per-tool entry inherit the
  // extension-wide ceiling.
  if (opts.toolName && Object.hasOwn(opts.toolCaps, opts.toolName)) {
    const allowedForTool = opts.toolCaps[opts.toolName] ?? [];
    if (!allowedForTool.includes(host)) {
      const allowedClause = allowedForTool.length
        ? allowedForTool.join(", ")
        : "none";
      return {
        kind: "deny",
        reason:
          `Extension sandbox: tool '${opts.toolName}' did not declare ` +
          `network access to '${host}' (tool's hosts: ${allowedClause})`,
      };
    }
  }

  return { kind: "external" };
}

/**
 * Parse the comma-separated allowlist env into a normalized array.
 * Idempotent — safe to call repeatedly. Returns `[]` for unset / empty.
 */
export function parsePermittedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Parse the per-tool capability map env. Malformed JSON → empty map.
 * The permission system MUST fail safe under bad input — a corrupted
 * env should NOT widen the wrapper's enforcement (the extension-wide
 * ceiling still applies).
 */
export function parseToolCaps(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        out[k] = (v as string[]).map((s) => s.toLowerCase());
      }
    }
    return out;
  } catch {
    return {};
  }
}
