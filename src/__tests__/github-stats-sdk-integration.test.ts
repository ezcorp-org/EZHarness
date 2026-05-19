/**
 * SDK integration tests for the `github-stats` example extension.
 *
 * Exercises the `@ezcorp/sdk/runtime` Phase 2.3 refactor (e846de2) for
 * the unique HTTP surface — `fetchPermitted` — which github-stats uses
 * for all three tools (repo-stats, user-profile, repo-languages).
 *
 * Split into two describe blocks:
 *
 *   ALLOW path: in-process direct import of `fetchPermitted` with
 *     `globalThis.fetch` stubbed and `EZCORP_PERMITTED_HOSTS` set to
 *     `api.github.com`. Asserts the wrapper forwards the request once
 *     the hostname check passes.
 *
 *   DENY path: real `ExtensionProcess` subprocess with `networkAllowed:
 *     true` — the sandbox-preload's global-fetch denier is disarmed, so
 *     `fetchPermitted`'s OWN allowlist branches are reached. Two
 *     branches covered per `packages/@ezcorp/sdk/src/runtime/http.ts`
 *     lines 36–48:
 *       Branch 1 (empty / omitted allowlist) → "not configured" throw
 *       Branch 2 (decoy allowlist without api.github.com) → hostname throw
 *
 * Isolated into its own file because `mock.module("../db/queries/extensions")`
 * would contaminate the shared module cache for other files that import
 * the real DB queries.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── DB stubs BEFORE importing ExtensionProcess (transitive) ────────
let incrementCalls = 0;
let _resetCalls = 0;
let _disableCalls = 0;

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => ++incrementCalls,
  resetFailures: async () => { _resetCalls++; },
  disableExtension: async () => { _disableCalls++; },
}));

afterAll(() => restoreModuleMocks());

// ── ALLOW path: in-process fetchPermitted with mocked globalThis.fetch ──
//
// Mirrors the `docs/extensions/examples/github-stats/index.test.ts`
// pattern (already green) and extends it with tool-URL coverage for all
// three handlers so the Phase 2.3 refactor's fetchPermitted surface is
// exercised through each production code path.
const mockFetch = mock(() => Promise.resolve(new Response("{}")));
globalThis.fetch = mockFetch as unknown as typeof fetch;

beforeAll(() => {
  // Simulate the post-install granted state — host's buildAllowedEnv
  // would inject this after the user grants manifest.permissions.network.
  process.env.EZCORP_PERMITTED_HOSTS = "api.github.com";
});

beforeEach(() => {
  mockFetch.mockReset();
});

import { fetchPermitted } from "@ezcorp/sdk/runtime";

describe("github-stats SDK integration ALLOW path (fetchPermitted direct)", () => {
  test("repo-stats URL: allowed hostname flows through to fetch, returns parsed body", async () => {
    const repoData = {
      full_name: "octocat/hello-world",
      stargazers_count: 42,
      forks_count: 7,
      open_issues_count: 1,
      language: "TypeScript",
      description: "integration-test repo",
    };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(repoData), { status: 200 }));

    const res = await fetchPermitted("https://api.github.com/repos/octocat/hello-world");
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data.full_name).toBe("octocat/hello-world");
    expect(data.stargazers_count).toBe(42);
  });

  test("user-profile URL: allowlist-matched hostname proceeds to fetch", async () => {
    const userData = { login: "octocat", followers: 1000 };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(userData), { status: 200 }));

    const res = await fetchPermitted("https://api.github.com/users/octocat");
    const data = await res.json() as Record<string, unknown>;
    expect(data.login).toBe("octocat");
  });

  test("repo-languages URL: same allowlist check applied to sub-paths", async () => {
    const langs = { TypeScript: 12345, JavaScript: 678 };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(langs), { status: 200 }));

    const res = await fetchPermitted("https://api.github.com/repos/octocat/hello-world/languages");
    const data = await res.json() as Record<string, unknown>;
    expect(data.TypeScript).toBe(12345);
  });

  test("Authorization header propagates through fetchPermitted when caller passes it", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await fetchPermitted("https://api.github.com/users/octocat", {
      headers: { Authorization: "Bearer test-token", "User-Agent": "github-stats-ext" },
    });

    expect(mockFetch.mock.calls.length).toBe(1);
    const calls = mockFetch.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const init = calls[0]?.[1];
    if (!init?.headers) throw new Error("expected init.headers");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["User-Agent"]).toBe("github-stats-ext");
  });
});

// Import AFTER mock.module so subprocess.ts resolves to the stub above.
import { ExtensionProcess } from "../extensions/subprocess";

const GITHUB_STATS_ENTRYPOINT = join(
  import.meta.dir, "..", "..",
  "docs", "extensions", "examples", "github-stats", "index.ts",
);

function makeSandboxEnv(extensionId: string, permittedHosts?: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
  if (permittedHosts !== undefined) env.EZCORP_PERMITTED_HOSTS = permittedHosts;
  return env;
}

describe("github-stats SDK integration DENY path (real subprocess, sandbox fetch wrapper)", () => {
  test("Branch 1 — empty allowlist: EZCORP_PERMITTED_HOSTS omitted, sandbox wrapper denies the host", async () => {
    const extId = "github-stats-deny-empty-" + Math.random().toString(36).slice(2, 8);
    // Phase 2: enforcement moved from the SDK's `fetchPermitted` helper
    // (now a thin alias) to the sandbox-preload's `globalThis.fetch`
    // wrapper. With `EZCORP_PERMITTED_HOSTS` unset, the wrapper denies
    // every external host — message anchors on the wrapper's "not in
    // the granted network allowlist" pattern.
    const env = makeSandboxEnv(extId);
    const proc = new ExtensionProcess(extId, GITHUB_STATS_ENTRYPOINT, env, {
      persistent: false,
      networkAllowed: true,
      callTimeoutMs: 15_000,
    });
    try {
      const r = await proc.callTool("repo-stats", { owner: "octocat", repo: "hello-world" });
      expect(r.isError).toBe(true);
      const first = r.content[0];
      if (!first || first.type !== "text") throw new Error("expected text content");
      // Wrapper denies api.github.com — empty allowlist means everything
      // not internal is denied with the same error.
      expect(first.text).toContain("api.github.com");
      expect(first.text).toMatch(/not in the granted network allowlist/);
    } finally {
      proc.kill();
    }
  }, 30_000);

  test("Branch 2 — decoy allowlist: EZCORP_PERMITTED_HOSTS set but missing api.github.com, hostname throw cites target host", async () => {
    const extId = "github-stats-deny-decoy-" + Math.random().toString(36).slice(2, 8);
    // Non-empty allowlist that does NOT include api.github.com → hostname
    // check fires, error text includes the rejected hostname (http.ts:43-47).
    const env = makeSandboxEnv(extId, "example.com");
    const proc = new ExtensionProcess(extId, GITHUB_STATS_ENTRYPOINT, env, {
      persistent: false,
      networkAllowed: true,
      callTimeoutMs: 15_000,
    });
    try {
      const r = await proc.callTool("repo-stats", { owner: "octocat", repo: "hello-world" });
      expect(r.isError).toBe(true);
      const first = r.content[0];
      if (!first || first.type !== "text") throw new Error("expected text content");
      expect(first.text).toContain("api.github.com");
      expect(first.text).toContain("example.com");
      // Phase 2: error message now comes from the sandbox-preload's
      // `globalThis.fetch` wrapper (which `fetchPermitted` aliases), not
      // the SDK helper's hand-rolled check. The new message uses
      // "Extension sandbox" / "granted network allowlist" — assertions
      // anchor on the host names + the "not in" / "allowlist" pattern
      // that's shared between both message shapes.
      expect(first.text).toMatch(
        /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist/,
      );
    } finally {
      proc.kill();
    }
  }, 30_000);
});
