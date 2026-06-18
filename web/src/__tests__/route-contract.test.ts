/**
 * Governance meta-test — keeps the remote-control contract from rotting.
 *
 *  1. Every `/api/__test/**` route is gated by `isTestSurfaceEnabled` (no
 *     ungated test/determinism surface can ship).
 *  2. Every control-tier `/api/*` route on disk is registered in
 *     `src/api-registry.ts` (so it is documented + appears in the generated
 *     OpenAPI contract). A frozen BASELINE captures pre-existing gaps so the
 *     test is green today but fails when a NEW unregistered route lands.
 *
 * See docs/harness-contract.md.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { apiRegistry } from "../../../src/api-registry";

const routesDir = `${import.meta.dir}/../routes`;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function fileToRoutePath(rel: string): string {
  let p = rel.replace(/\/\+server\.ts$/, "");
  // Drop SvelteKit route groups: "(group)" segments don't appear in URLs.
  p = p.split("/").filter((seg) => !(seg.startsWith("(") && seg.endsWith(")"))).join("/");
  // [...rest] -> :rest ; [param] -> :param  (registry uses Express syntax).
  p = p.replace(/\[\.\.\.([^\]]+)\]/g, ":$1").replace(/\[([^\]]+)\]/g, ":$1");
  return "/" + p;
}

function exportedMethods(src: string): string[] {
  const found = new Set<string>();
  for (const m of METHODS) {
    if (new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${m}\\b`).test(src)) found.add(m);
    // re-export form: export { GET, POST }
    if (new RegExp(`export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`).test(src)) found.add(m);
  }
  return [...found];
}

interface DiskRoute { method: string; path: string; file: string }

function discoverDiskRoutes(): DiskRoute[] {
  const out: DiskRoute[] = [];
  const glob = new Glob("api/**/+server.ts");
  for (const rel of glob.scanSync(routesDir)) {
    const src = readFileSync(`${routesDir}/${rel}`, "utf8");
    const path = fileToRoutePath(rel);
    for (const method of exportedMethods(src)) out.push({ method, path, file: rel });
  }
  return out;
}

const disk = discoverDiskRoutes();

describe("test-surface gating", () => {
  test("every /api/__test/** route references isTestSurfaceEnabled", () => {
    const glob = new Glob("api/__test/**/+server.ts");
    const ungated: string[] = [];
    for (const rel of glob.scanSync(routesDir)) {
      const src = readFileSync(`${routesDir}/${rel}`, "utf8");
      if (!src.includes("isTestSurfaceEnabled")) ungated.push(rel);
    }
    expect(ungated).toEqual([]);
  });

  test("there is at least one __test route (sanity: glob works)", () => {
    expect(disk.some((r) => r.path.startsWith("/api/__test/"))).toBe(true);
  });
});

describe("registry ⇄ filesystem parity", () => {
  const controlDisk = disk.filter((r) => !r.path.startsWith("/api/__test/"));
  const diskKeys = new Set(controlDisk.map((r) => `${r.method} ${r.path}`));
  const registeredKeys = apiRegistry.map((e) => `${e.method} ${e.path}`);

  // Pre-existing registry inaccuracies (wrong method/path vs the handler on
  // disk) — surfaced by this very test, but unrelated to the remote-control
  // feature so left for a separate registry-reconciliation pass. Frozen so a
  // NEW stale entry fails; shrink as these are corrected.
  const KNOWN_STALE = new Set<string>([
    "GET /api/auth/oauth/callback", // disk: POST + DELETE
    "GET /api/users/:id",           // disk: PUT only
    "GET /api/warmup",              // disk: POST
    "PATCH /api/conversations/:id", // disk: PUT
    "POST /api/quickstart",         // disk: GET
  ]);

  test("no NEW stale registry entry (registered routes exist on disk)", () => {
    // Keeps the generated OpenAPI contract honest — a registry entry with no
    // matching handler would advertise a route that 404s.
    const stale = registeredKeys.filter((k) => !diskKeys.has(k) && !KNOWN_STALE.has(k)).sort();
    expect(stale).toEqual([]);
  });

  // The registry is a curated (currently partial) mirror of the HTTP surface.
  // Rather than freeze ~135 pre-existing gaps, ratchet the count: a NEW
  // unregistered control route pushes it over the line and fails, forcing the
  // author to register it (and so document it + expose it in OpenAPI). Lower
  // this number as gaps close; never raise it without registering the route.
  const BASELINE_UNREGISTERED = 135;

  test("unregistered control-route count does not grow (ratchet)", () => {
    const registered = new Set(registeredKeys);
    const unregistered = controlDisk
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !registered.has(k));
    if (unregistered.length > BASELINE_UNREGISTERED) {
      const newly = unregistered.filter((k) => !diskKeys.has(k) ? false : true).sort();
      throw new Error(
        `Unregistered control routes rose to ${unregistered.length} (baseline ${BASELINE_UNREGISTERED}). ` +
        `Register new /api/* routes in src/api-registry.ts (see docs/harness-contract.md).\n${newly.join("\n")}`,
      );
    }
    expect(unregistered.length).toBeLessThanOrEqual(BASELINE_UNREGISTERED);
  });
});
