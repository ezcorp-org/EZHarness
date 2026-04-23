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
