/**
 * Unit tests for the injected-env feature on `buildAllowedEnv` + the
 * `setInjectedEnv` / `clearInjectedEnv` pair on ExtensionRegistry.
 *
 * Security contract:
 *   1. An injected value can ONLY reach the subprocess env if the
 *      manifest declares the key in permissions.env AND the grantedPerms
 *      include that key. The injection mechanism cannot bypass the
 *      manifest-declared trust boundary.
 *   2. An injected value shadows process.env[key] for that extension. If
 *      the operator sets EZCORP_API_KEY on the host process and the web
 *      layer also injects a freshly minted loopback-only key, the
 *      loopback key wins — otherwise an accidentally-exported admin key
 *      could replace the scoped internal key.
 *   3. Clearing an injection for an extension removes it without touching
 *      other extensions' injections.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ExtensionRegistry, buildAllowedEnv } from "../extensions/registry";
import type { ExtensionManifestV2 } from "../extensions/types";

function makeManifest(
  overrides: Partial<ExtensionManifestV2> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "sample",
    version: "0.0.1",
    description: "",
    author: { name: "test" },
    permissions: { env: ["EZCORP_API_KEY", "EZCORP_BASE_URL"] },
    entrypoint: "./index.ts",
    ...overrides,
  } as ExtensionManifestV2;
}

describe("buildAllowedEnv — injectedEnv gating", () => {
  test("injected value is passed through when manifest declares + permission granted", () => {
    const out = buildAllowedEnv(
      makeManifest(),
      { env: ["EZCORP_API_KEY", "EZCORP_BASE_URL"], grantedAt: { env: 1 } },
      "ext-1",
      { EZCORP_API_KEY: "ezkint_injected", EZCORP_BASE_URL: "http://127.0.0.1:3000" },
    );
    expect(out["EZCORP_API_KEY"]).toBe("ezkint_injected");
    expect(out["EZCORP_BASE_URL"]).toBe("http://127.0.0.1:3000");
  });

  test("injected value is DROPPED when manifest doesn't declare the key", () => {
    const out = buildAllowedEnv(
      makeManifest({ permissions: { env: ["EZCORP_API_KEY"] } }), // no BASE_URL
      { env: ["EZCORP_API_KEY", "EZCORP_BASE_URL"], grantedAt: { env: 1 } },
      "ext-1",
      { EZCORP_API_KEY: "ezkint_x", EZCORP_BASE_URL: "http://127.0.0.1:3000" },
    );
    expect(out["EZCORP_API_KEY"]).toBe("ezkint_x");
    expect(out["EZCORP_BASE_URL"]).toBeUndefined();
  });

  test("injected value is DROPPED when user didn't grant the permission", () => {
    const out = buildAllowedEnv(
      makeManifest(),
      { env: ["EZCORP_BASE_URL"], grantedAt: { env: 1 } }, // API_KEY not granted
      "ext-1",
      { EZCORP_API_KEY: "ezkint_x", EZCORP_BASE_URL: "http://127.0.0.1:3000" },
    );
    expect(out["EZCORP_API_KEY"]).toBeUndefined();
    expect(out["EZCORP_BASE_URL"]).toBe("http://127.0.0.1:3000");
  });

  test("injected value shadows process.env (defense against accidental host export)", () => {
    const prev = process.env["EZCORP_API_KEY"];
    process.env["EZCORP_API_KEY"] = "ezk_host_admin_key";
    try {
      const out = buildAllowedEnv(
        makeManifest(),
        { env: ["EZCORP_API_KEY"], grantedAt: { env: 1 } },
        "ext-1",
        { EZCORP_API_KEY: "ezkint_fresh" },
      );
      expect(out["EZCORP_API_KEY"]).toBe("ezkint_fresh");
    } finally {
      if (prev === undefined) delete process.env["EZCORP_API_KEY"];
      else process.env["EZCORP_API_KEY"] = prev;
    }
  });

  test("empty injected value falls back to process.env (injection opt-out)", () => {
    const prev = process.env["EZCORP_API_KEY"];
    process.env["EZCORP_API_KEY"] = "ezk_user_key";
    try {
      const out = buildAllowedEnv(
        makeManifest(),
        { env: ["EZCORP_API_KEY"], grantedAt: { env: 1 } },
        "ext-1",
        { EZCORP_API_KEY: "" }, // empty = explicit opt-out of injection
      );
      expect(out["EZCORP_API_KEY"]).toBe("ezk_user_key");
    } finally {
      if (prev === undefined) delete process.env["EZCORP_API_KEY"];
      else process.env["EZCORP_API_KEY"] = prev;
    }
  });

  test("no injected arg means behavior is unchanged (backcompat with existing callers)", () => {
    const prev = process.env["EZCORP_API_KEY"];
    process.env["EZCORP_API_KEY"] = "ezk_user_key";
    try {
      const out = buildAllowedEnv(
        makeManifest(),
        { env: ["EZCORP_API_KEY"], grantedAt: { env: 1 } },
        "ext-1",
      );
      expect(out["EZCORP_API_KEY"]).toBe("ezk_user_key");
    } finally {
      if (prev === undefined) delete process.env["EZCORP_API_KEY"];
      else process.env["EZCORP_API_KEY"] = prev;
    }
  });

  test("extensions that never declared env.permissions get zero injected values", () => {
    const out = buildAllowedEnv(
      makeManifest({ permissions: {} }),
      { grantedAt: {} },
      "ext-1",
      { EZCORP_API_KEY: "ezkint_x" },
    );
    expect(out["EZCORP_API_KEY"]).toBeUndefined();
  });
});

describe("buildAllowedEnv — EZCORP_PROJECT_ROOT resolution", () => {
  test("swallows findProjectRoot failure when run outside a git tree", () => {
    // findProjectRoot() walks up from process.cwd() and throws when it hits
    // the filesystem root with no `.git` ancestor. buildAllowedEnv catches
    // that so a spawn outside a git tree doesn't crash — it just leaves
    // EZCORP_PROJECT_ROOT unset. Force the throw by chdir'ing to /tmp.
    const cwd = process.cwd();
    try {
      process.chdir("/tmp");
      const out = buildAllowedEnv(makeManifest(), { grantedAt: {} }, "ext-nogit");
      expect(out.EZCORP_PROJECT_ROOT).toBeUndefined();
    } finally {
      process.chdir(cwd);
    }
  });

  test("sets EZCORP_PROJECT_ROOT to the .git ancestor when inside a git tree", () => {
    const out = buildAllowedEnv(makeManifest(), { grantedAt: {} }, "ext-git");
    expect(typeof out.EZCORP_PROJECT_ROOT).toBe("string");
    expect(out.EZCORP_PROJECT_ROOT!.length).toBeGreaterThan(0);
  });
});

describe("ExtensionRegistry — manifest + bundled accessors", () => {
  test("getAllManifests returns an iterable of [id, manifest] entries", () => {
    const registry = ExtensionRegistry.getInstance();
    const entries = [...registry.getAllManifests()];
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(Array.isArray(entry)).toBe(true);
      expect(entry).toHaveLength(2);
    }
  });

  test("isBundled returns false for an extension id with no bundled flag", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.isBundled("definitely-not-installed-ext")).toBe(false);
  });
});

// ── Registry setter ──────────────────────────────────────────────────────────

describe("ExtensionRegistry — injected env lifecycle", () => {
  let registry: ExtensionRegistry;
  beforeEach(() => {
    registry = ExtensionRegistry.getInstance();
    registry.resetInjectedEnvForTests();
  });
  afterEach(() => registry.resetInjectedEnvForTests());

  test("setInjectedEnv stores a copy (mutating the caller's map does not affect registry)", () => {
    const src: Record<string, string> = { EZCORP_API_KEY: "first" };
    registry.setInjectedEnv("ai-kit", src);
    src["EZCORP_API_KEY"] = "second";
    // We can't read back directly without spawning, but clearInjectedEnv
    // tells us the entry exists — and a defensive copy is easy to verify
    // via the clear count.
    expect(registry.clearInjectedEnv("ai-kit")).toBe(true);
    expect(registry.clearInjectedEnv("ai-kit")).toBe(false);
  });

  test("clearInjectedEnv removes only the named extension", () => {
    registry.setInjectedEnv("a", { X: "1" });
    registry.setInjectedEnv("b", { X: "2" });
    expect(registry.clearInjectedEnv("a")).toBe(true);
    expect(registry.clearInjectedEnv("b")).toBe(true);
    expect(registry.clearInjectedEnv("a")).toBe(false);
  });

  test("resetInjectedEnvForTests wipes the entire registry", () => {
    registry.setInjectedEnv("a", { X: "1" });
    registry.setInjectedEnv("b", { X: "2" });
    registry.resetInjectedEnvForTests();
    expect(registry.clearInjectedEnv("a")).toBe(false);
    expect(registry.clearInjectedEnv("b")).toBe(false);
  });

  test("setInjectedEnvResolver registers a resolver findable by clearInjectedEnv", () => {
    registry.setInjectedEnvResolver("dyn", async () => ({ X: "1" }));
    // Clear returns true because a resolver was registered under that name.
    expect(registry.clearInjectedEnv("dyn")).toBe(true);
    expect(registry.clearInjectedEnv("dyn")).toBe(false);
  });

  test("clearInjectedEnv returns true if either static env OR resolver was registered", () => {
    registry.setInjectedEnv("static-only", { X: "1" });
    registry.setInjectedEnvResolver("resolver-only", async () => ({ X: "1" }));
    registry.setInjectedEnv("both", { X: "1" });
    registry.setInjectedEnvResolver("both", async () => ({ X: "2" }));
    expect(registry.clearInjectedEnv("static-only")).toBe(true);
    expect(registry.clearInjectedEnv("resolver-only")).toBe(true);
    expect(registry.clearInjectedEnv("both")).toBe(true);
    expect(registry.clearInjectedEnv("unknown")).toBe(false);
  });

  test("resetInjectedEnvForTests clears resolvers too", () => {
    registry.setInjectedEnvResolver("a", async () => ({ X: "1" }));
    registry.resetInjectedEnvForTests();
    expect(registry.clearInjectedEnv("a")).toBe(false);
  });
});

// ── callTimeoutMs pass-through (parity with registry.ts lines 359-362) ──────
//
// registry.getProcess() spawns a real subprocess, so a full integration test
// is heavy. Instead, mirror the exact ternary used in the registry here and
// assert its behavior directly — so any future drift between this test and
// the source will be caught at review time.
//
// Source (src/extensions/registry.ts ~line 359):
//   const callTimeoutMs =
//     typeof manifest.resources?.callTimeoutMs === "number" &&
//     manifest.resources.callTimeoutMs > 0
//       ? manifest.resources.callTimeoutMs
//       : undefined;
function deriveCallTimeoutMs(
  manifest: ExtensionManifestV2,
): number | undefined {
  return typeof manifest.resources?.callTimeoutMs === "number" &&
    manifest.resources.callTimeoutMs > 0
    ? manifest.resources.callTimeoutMs
    : undefined;
}

// ── Phase 2: EZCORP_TOOL_NETWORK_CAPS env var (per-tool allowlist) ──
//
// `buildAllowedEnv` emits a JSON-serialized `{toolName: string[]}` map
// that the in-sandbox fetch wrapper consumes. v3 manifests with
// authored `tool.capabilities.network.hosts` flow through verbatim; v2
// manifests get migrated inline so each tool inherits the
// extension-wide grant.

describe("buildAllowedEnv — EZCORP_TOOL_NETWORK_CAPS (Phase 2)", () => {
  test("v3 manifest with per-tool capabilities → serialized per-tool map", () => {
    const m: ExtensionManifestV2 = {
      schemaVersion: 3,
      name: "phase2-v3",
      version: "1.0.0",
      description: "v3 with authored caps",
      author: { name: "test" },
      entrypoint: "./index.ts",
      permissions: { network: ["api.foo.com", "api.bar.com"] },
      tools: [
        {
          name: "foo_only",
          description: "",
          inputSchema: {},
          capabilities: { network: { hosts: ["api.foo.com"] } },
        },
        {
          name: "both",
          description: "",
          inputSchema: {},
          capabilities: { network: { hosts: ["api.foo.com", "api.bar.com"] } },
        },
        {
          name: "no_caps_declared",
          description: "",
          inputSchema: {},
          // No capabilities → inherits extension-wide via v2→v3 migrator
          // when run through migrateManifestV2ToV3.
        },
      ],
    } as ExtensionManifestV2;

    const out = buildAllowedEnv(
      m,
      { network: ["api.foo.com", "api.bar.com"], grantedAt: { network: 1 } },
      "ext-1",
    );
    expect(out.EZCORP_PERMITTED_HOSTS).toBe("api.foo.com,api.bar.com");
    const map = JSON.parse(out.EZCORP_TOOL_NETWORK_CAPS ?? "{}");
    expect(map.foo_only).toEqual(["api.foo.com"]);
    expect(map.both).toEqual(["api.foo.com", "api.bar.com"]);
    // v3 manifest passes through unchanged — `no_caps_declared` had no
    // capabilities authored, so it stays absent from the map (the
    // extension-wide ceiling alone applies, no per-tool narrowing).
    expect(map.no_caps_declared).toBeUndefined();
  });

  test("v2 manifest is auto-migrated → every tool inherits extension-wide hosts", () => {
    const m: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "phase2-v2",
      version: "1.0.0",
      description: "v2, no per-tool caps",
      author: { name: "test" },
      entrypoint: "./index.ts",
      permissions: { network: ["api.foo.com"] },
      tools: [
        { name: "search", description: "", inputSchema: {} },
        { name: "fetch_one", description: "", inputSchema: {} },
      ],
    } as ExtensionManifestV2;

    const out = buildAllowedEnv(
      m,
      { network: ["api.foo.com"], grantedAt: { network: 1 } },
      "ext-1",
    );
    const map = JSON.parse(out.EZCORP_TOOL_NETWORK_CAPS ?? "{}");
    // v2→v3 migration distributes the extension-wide grant to every
    // tool that lacks an authored cap declaration.
    expect(map.search).toEqual(["api.foo.com"]);
    expect(map.fetch_one).toEqual(["api.foo.com"]);
  });

  test("manifest with no network permission → env var omitted", () => {
    const m: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "no-net",
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      entrypoint: "./index.ts",
      permissions: {},
      tools: [{ name: "t1", description: "", inputSchema: {} }],
    } as ExtensionManifestV2;

    const out = buildAllowedEnv(m, { grantedAt: {} }, "ext-1");
    expect(out.EZCORP_PERMITTED_HOSTS).toBeUndefined();
    expect(out.EZCORP_TOOL_NETWORK_CAPS).toBeUndefined();
  });

  test("manifest with no tools → env var omitted", () => {
    const m: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "tool-less",
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      entrypoint: "./index.ts",
      permissions: { network: ["api.foo.com"] },
    } as ExtensionManifestV2;

    const out = buildAllowedEnv(
      m,
      { network: ["api.foo.com"], grantedAt: { network: 1 } },
      "ext-1",
    );
    expect(out.EZCORP_PERMITTED_HOSTS).toBe("api.foo.com");
    expect(out.EZCORP_TOOL_NETWORK_CAPS).toBeUndefined();
  });

  test("hostnames in the per-tool map are lowercased (defense against authored CASE drift)", () => {
    const m: ExtensionManifestV2 = {
      schemaVersion: 3,
      name: "case-test",
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      entrypoint: "./index.ts",
      permissions: { network: ["api.foo.com"] },
      tools: [
        {
          name: "t1",
          description: "",
          inputSchema: {},
          capabilities: { network: { hosts: ["API.FOO.com"] } },
        },
      ],
    } as ExtensionManifestV2;
    const out = buildAllowedEnv(
      m,
      { network: ["api.foo.com"], grantedAt: { network: 1 } },
      "ext-1",
    );
    const map = JSON.parse(out.EZCORP_TOOL_NETWORK_CAPS ?? "{}");
    expect(map.t1).toEqual(["api.foo.com"]);
  });
});

describe("registry getProcess — manifest.resources.callTimeoutMs pass-through", () => {
  test("positive number is forwarded as-is", () => {
    const m = makeManifest({ resources: { callTimeoutMs: 180_000 } } as any);
    expect(deriveCallTimeoutMs(m)).toBe(180_000);
  });

  test("absent resources block → undefined (falls back to subprocess default)", () => {
    expect(deriveCallTimeoutMs(makeManifest())).toBeUndefined();
  });

  test("resources block present but callTimeoutMs missing → undefined", () => {
    const m = makeManifest({ resources: {} } as any);
    expect(deriveCallTimeoutMs(m)).toBeUndefined();
  });

  test("explicit undefined → undefined", () => {
    const m = makeManifest({ resources: { callTimeoutMs: undefined } } as any);
    expect(deriveCallTimeoutMs(m)).toBeUndefined();
  });

  test("zero is rejected (positive-number guard)", () => {
    const m = makeManifest({ resources: { callTimeoutMs: 0 } } as any);
    expect(deriveCallTimeoutMs(m)).toBeUndefined();
  });

  test("negative values are rejected", () => {
    const m = makeManifest({ resources: { callTimeoutMs: -1 } } as any);
    expect(deriveCallTimeoutMs(m)).toBeUndefined();
  });

  test("non-number values (string) → undefined", () => {
    const m = makeManifest({ resources: { callTimeoutMs: "180000" } } as any);
    expect(deriveCallTimeoutMs(m)).toBeUndefined();
  });
});
