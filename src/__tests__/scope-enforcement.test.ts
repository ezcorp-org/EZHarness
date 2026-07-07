import { test, expect, describe } from "bun:test";
import { requireScope } from "../../web/src/lib/server/security/api-keys";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

describe("requireScope", () => {
  test("returns 403 when API key lacks required scope", () => {
    const result = requireScope({ apiKeyScopes: ["read"] }, "chat");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("returns null when API key has required scope", () => {
    const result = requireScope({ apiKeyScopes: ["chat"] }, "chat");
    expect(result).toBeNull();
  });

  test("returns null for admin scope when present", () => {
    const result = requireScope({ apiKeyScopes: ["admin"] }, "admin");
    expect(result).toBeNull();
  });

  test("returns null for cookie auth (no apiKeyScopes)", () => {
    const result = requireScope({}, "chat");
    expect(result).toBeNull();
  });

  test("returns 403 for read-only key on POST messages (chat scope)", () => {
    const result = requireScope({ apiKeyScopes: ["read"] }, "chat");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("returns 403 for chat-only key on settings (admin scope)", () => {
    const result = requireScope({ apiKeyScopes: ["chat"] }, "admin");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});

describe("scope enforcement coverage", () => {
  // updated for sec-C1 + Phase 59-04 (TEST-04): previously asserted every
  // route contains `requireScope`, but `requireScope` is a no-op for cookie
  // auth — the whole reason we're migrating admin-sensitive routes to
  // `requireRole(locals, "admin")`. The Phase-59 update adds two more
  // accepted shapes:
  //   1. `requireAuth` — cookie-only auth gate (no API-key scopes needed).
  //   2. An explicit allowlist of legitimately-public routes (health,
  //      diagnostic, anonymous-listing endpoints).
  // Together they cover every +server.ts under web/src/routes/api/ as of
  // HEAD 83781b5. See .planning/v1.4-backend-test-triage.md for the
  // per-route evidence.
  //
  // Determinism tier (`/api/__test/**`): these are gated by
  // `isTestSurfaceEnabled()` (fail-CLOSED 404 unless the three-condition test
  // opt-in holds), which is a legitimate gate. The mock-LLM completions route
  // is additionally unauthenticated-by-design (called server-internally over a
  // loopback-only bypass), so it carries NO requireScope/requireAuth — its
  // gate IS `isTestSurfaceEnabled`. We accept that token but ONLY for `__test`
  // routes, so a real prod route can't pass on a test-only predicate.
  // `route-contract.test.ts` independently enforces that every `__test/**`
  // route calls the gate.
  const PUBLIC_ROUTE_ALLOWLIST = new Set<string>([
    // Truly public — anonymous access by design.
    "/marketplace/categories/+server.ts",  // anonymous category listing
    "/version/+server.ts",                  // diagnostic
    "/ready/+server.ts",                    // health probe
  ]);

  test("all non-auth API routes contain a scope, role, or auth gate", async () => {
    const apiDir = join(import.meta.dir, "../../web/src/routes/api");
    const skipDirs = ["auth", "health", "favicon"];

    async function findServerFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.includes(entry.name)) continue;
          files.push(...(await findServerFiles(fullPath)));
        } else if (entry.name === "+server.ts") {
          files.push(fullPath);
        }
      }
      return files;
    }

    const serverFiles = await findServerFiles(apiDir);
    expect(serverFiles.length).toBeGreaterThan(25);

    const missing: string[] = [];
    for (const file of serverFiles) {
      const relative = file.replace(apiDir, "");
      if (PUBLIC_ROUTE_ALLOWLIST.has(relative)) continue;
      const content = await Bun.file(file).text();
      // `isTestSurfaceEnabled()` is a valid gate only for determinism-tier
      // (`/__test/**`) routes — never accept it for a production route.
      const isTestSurfaceRoute = relative.startsWith("/__test/");
      if (
        !content.includes("requireScope") &&
        !content.includes("requireRole") &&
        // `checkRole(locals, "admin")` is the non-throwing role gate for
        // +server.ts handlers (returns the denial Response instead of throwing
        // → no SvelteKit 500). It enforces BOTH axes — admin ROLE and, for key
        // principals, the admin SCOPE — so it is a strictly stronger gate than
        // requireScope/requireRole. Accept it or the checkRole-only admin
        // routes (settings/[key], extensions activate) read as ungated.
        !content.includes("checkRole") &&
        !content.includes("requireAuth") &&
        // `authGithubRoute` (web/.../github-projects/_shared.ts) is the
        // github-projects routes' gate: it calls `requireScope(locals,
        // "extensions")` + resolves the session/key user before any handler
        // logic. Accepting the wrapper keeps this textual scan accurate without
        // forcing a redundant inline `requireScope` into every route.
        !content.includes("authGithubRoute") &&
        !(isTestSurfaceRoute && content.includes("isTestSurfaceEnabled"))
      ) {
        missing.push(relative);
      }
    }

    expect(missing).toEqual([]);
  });
});
