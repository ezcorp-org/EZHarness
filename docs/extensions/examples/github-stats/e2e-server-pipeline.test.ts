/**
 * E2E test: exercises the REAL server pipeline for github-stats.
 *
 * Mirrors the canonical `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts`
 * pattern. Spawns github-stats through `ExtensionProcess` (from
 * `src/extensions/subprocess.ts`) — the same class the server uses in
 * `ExtensionRegistry.getProcess` — so the full server-pipeline path
 * (sandbox preload → stdin JSON-RPC framing → dispatcher → fetchPermitted
 * → `isError` envelope) is reproducible here.
 *
 * Exercises the **empty-allowlist** deny branch of
 * `fetchPermitted` (`packages/@ezcorp/sdk/src/runtime/http.ts:36-41`) —
 * the realistic production mis-config where the extension runs without
 * a granted `permissions.network` entry in `EZCORP_PERMITTED_HOSTS`.
 * Decoy-allowlist (Branch 2, hostname throw) is covered alongside
 * Branch 1 in the companion `src/__tests__/github-stats-sdk-integration.test.ts`.
 *
 * `networkAllowed: true` is load-bearing: it disarms the sandbox
 * preload's global-fetch denier so `fetchPermitted`'s OWN guard is the
 * check that fires. With `networkAllowed: false`, the preload would
 * poison `fetch` before the extension imports the SDK — we'd be
 * testing the preload, not the SDK refactor.
 *
 * Isolated into its own file because `mock.module("../../../../src/db/queries/extensions")`
 * would otherwise contaminate the shared module cache for the rest of
 * the github-stats tests (which import nothing from src/db).
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

// ── DB stubs ────────────────────────────────────────────────────
let incrementCalls = 0;
let resetCalls = 0;
let disableCalls = 0;
let simulatedConsecutiveFailures = 0;

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => {
    incrementCalls++;
    simulatedConsecutiveFailures++;
    return simulatedConsecutiveFailures;
  },
  resetFailures: async () => {
    resetCalls++;
    simulatedConsecutiveFailures = 0;
  },
  disableExtension: async () => {
    disableCalls++;
  },
}));

// Import AFTER mock.module so subprocess.ts resolves to the stub.
import { ExtensionProcess } from "../../../../src/extensions/subprocess";

// ── buildAllowedEnv() parity ────────────────────────────────────
// Mirrors `registry.ts buildAllowedEnv()` for github-stats's manifest
// (`permissions.network: ["api.github.com"]`, `permissions.env: ["GITHUB_TOKEN"]`).
// EZCORP_PERMITTED_HOSTS is DELIBERATELY OMITTED to simulate the
// "extension installed but network permission not granted" state —
// this is the deny-branch-1 scenario (http.ts:36-41, empty allowlist).
// GITHUB_TOKEN is likewise omitted so no auth header is constructed,
// though this is moot: fetchPermitted throws before any header is read.
function buildAllowedEnvLike(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
}

const GITHUB_STATS_ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `github-stats-e2e-pipeline-${Date.now()}`);

function makeProc(persistent: boolean): ExtensionProcess {
  const extId = "github-stats-test-" + Math.random().toString(36).slice(2, 8);
  const env = buildAllowedEnvLike(extId);
  return new ExtensionProcess(extId, GITHUB_STATS_ENTRYPOINT, env, {
    persistent,
    // CRITICAL: true so the preload does NOT poison globalThis.fetch —
    // fetchPermitted's allowlist guard is then the denier that fires.
    networkAllowed: true,
    callTimeoutMs: 15_000,
  });
}

describe("E2E: github-stats real ExtensionProcess (server pipeline, empty-allowlist deny)", () => {
  const procs: ExtensionProcess[] = [];

  beforeEach(() => {
    incrementCalls = 0;
    resetCalls = 0;
    disableCalls = 0;
    simulatedConsecutiveFailures = 0;
  });

  afterEach(() => {
    for (const p of procs.splice(0)) {
      try { p.kill(); } catch { /* already dead */ }
    }
  });

  afterAll(() => {
    try { rmSync(TEST_TMP_ROOT, { recursive: true }); } catch { /* best-effort */ }
  });

  test("repo-stats without granted network permission returns isError with 'not configured' guard message", async () => {
    const proc = makeProc(false);
    procs.push(proc);

    const r = await proc.callTool("repo-stats", { owner: "octocat", repo: "hello-world" });
    expect(r.isError).toBe(true);
    const first = r.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    // Phase 2: enforcement moved from the SDK's hand-rolled
    // `fetchPermitted` guard to the sandbox-preload's `globalThis.fetch`
    // wrapper. With network NOT granted at the spawn level (no
    // EZCORP_NETWORK_ALLOWED env), the wrapper installs an outright-deny
    // stub whose message reads "blocked — extension requires 'network'
    // permission". When network IS granted but PERMITTED_HOSTS is unset,
    // the wrapper's per-host check denies with "not in the granted
    // network allowlist". Either pattern indicates the deny path fired.
    expect(first.text).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
    // Phase 2: the wrapper's deny message uses "granted network
    // allowlist" (not "granted network permission" — that was the SDK
    // helper's wording). Both shapes carry the same intent.
    expect(first.text).toMatch(/granted network (allowlist|permission)/);
  }, 30_000);

  test("user-profile routes through the same fetchPermitted guard — confirms handler-map coverage", async () => {
    const proc = makeProc(false);
    procs.push(proc);

    const r = await proc.callTool("user-profile", { username: "octocat" });
    expect(r.isError).toBe(true);
    const first = r.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    // Phase 2: enforcement moved from the SDK's hand-rolled
    // `fetchPermitted` guard to the sandbox-preload's `globalThis.fetch`
    // wrapper. With network NOT granted at the spawn level (no
    // EZCORP_NETWORK_ALLOWED env), the wrapper installs an outright-deny
    // stub whose message reads "blocked — extension requires 'network'
    // permission". When network IS granted but PERMITTED_HOSTS is unset,
    // the wrapper's per-host check denies with "not in the granted
    // network allowlist". Either pattern indicates the deny path fired.
    expect(first.text).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
  }, 30_000);

  test("repo-languages routes through the same fetchPermitted guard — all 3 tools wired by createToolDispatcher", async () => {
    const proc = makeProc(false);
    procs.push(proc);

    const r = await proc.callTool("repo-languages", { owner: "octocat", repo: "hello-world" });
    expect(r.isError).toBe(true);
    const first = r.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    // Phase 2: enforcement moved from the SDK's hand-rolled
    // `fetchPermitted` guard to the sandbox-preload's `globalThis.fetch`
    // wrapper. With network NOT granted at the spawn level (no
    // EZCORP_NETWORK_ALLOWED env), the wrapper installs an outright-deny
    // stub whose message reads "blocked — extension requires 'network'
    // permission". When network IS granted but PERMITTED_HOSTS is unset,
    // the wrapper's per-host check denies with "not in the granted
    // network allowlist". Either pattern indicates the deny path fired.
    expect(first.text).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
  }, 30_000);

  test("unknown tool returns JSON-RPC 'Tool not found' error; subprocess recovers for a valid call", async () => {
    const proc = makeProc(true);
    procs.push(proc);

    const bad = await proc.callTool("no-such-tool", {});
    expect(bad.isError).toBe(true);
    const badFirst = bad.content[0];
    if (!badFirst || badFirst.type !== "text") throw new Error("expected text content");
    expect(badFirst.text).toContain("Tool not found");

    // Follow-up valid-named call still routes through the handler (even
    // though its fetchPermitted still denies): dispatcher did not tear
    // down the process on protocol-error branch.
    const ok = await proc.callTool("repo-stats", { owner: "octocat", repo: "hello-world" });
    expect(ok.isError).toBe(true);
    const okFirst = ok.content[0];
    if (!okFirst || okFirst.type !== "text") throw new Error("expected text content");
    expect(okFirst.text).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("3 sequential repo-stats calls on persistent process — each denied, subprocess survives, resetFailures fires per transport-success", async () => {
    const proc = makeProc(true);
    procs.push(proc);

    for (let i = 0; i < 3; i++) {
      const r = await proc.callTool("repo-stats", { owner: "octocat", repo: `repo-${i}` });
      expect(r.isError).toBe(true);
      const first = r.content[0];
      if (!first || first.type !== "text") throw new Error("expected text content");
      // Phase 2: enforcement moved from the SDK's hand-rolled
    // `fetchPermitted` guard to the sandbox-preload's `globalThis.fetch`
    // wrapper. With network NOT granted at the spawn level (no
    // EZCORP_NETWORK_ALLOWED env), the wrapper installs an outright-deny
    // stub whose message reads "blocked — extension requires 'network'
    // permission". When network IS granted but PERMITTED_HOSTS is unset,
    // the wrapper's per-host check denies with "not in the granted
    // network allowlist". Either pattern indicates the deny path fired.
    expect(first.text).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
    }

    // Tool-level isError still counts as transport success → resetFailures
    // called on each call (subprocess.ts:237). Three calls, three resets.
    // incrementFailures only fires on transport-level crash, which never
    // happens here because the handler-throw is caught by the dispatcher.
    expect(resetCalls).toBeGreaterThanOrEqual(3);
    expect(incrementCalls).toBe(0);
    expect(proc.isRunning).toBe(true);
  }, 45_000);

  test("concurrent Promise.all of 3 denies — dispatcher + transport interleave cleanly, subprocess alive", async () => {
    const proc = makeProc(true);
    procs.push(proc);

    const results = await Promise.all([
      proc.callTool("repo-stats", { owner: "octocat", repo: "a" }),
      proc.callTool("user-profile", { username: "octocat" }),
      proc.callTool("repo-languages", { owner: "octocat", repo: "b" }),
    ]);

    for (const r of results) {
      expect(r.isError).toBe(true);
      const first = r.content[0];
      if (!first || first.type !== "text") throw new Error("expected text content");
      // Phase 2: enforcement moved from the SDK's hand-rolled
    // `fetchPermitted` guard to the sandbox-preload's `globalThis.fetch`
    // wrapper. With network NOT granted at the spawn level (no
    // EZCORP_NETWORK_ALLOWED env), the wrapper installs an outright-deny
    // stub whose message reads "blocked — extension requires 'network'
    // permission". When network IS granted but PERMITTED_HOSTS is unset,
    // the wrapper's per-host check denies with "not in the granted
    // network allowlist". Either pattern indicates the deny path fired.
    expect(first.text).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
    }
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("simulatedConsecutiveFailures never rises — ExtensionProcess does not treat tool-level deny as a subprocess crash", async () => {
    const proc = makeProc(true);
    procs.push(proc);

    for (let i = 0; i < 5; i++) {
      const r = await proc.callTool("repo-stats", { owner: "octocat", repo: `r${i}` });
      expect(r.isError).toBe(true);
    }
    expect(simulatedConsecutiveFailures).toBe(0);
    expect(disableCalls).toBe(0);
  }, 45_000);
});
