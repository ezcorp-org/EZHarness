/**
 * Phase B — `verifyExtension` deterministic acceptance pipeline.
 *
 * Root-cause fix #2 of the harness-smoke-test loop: a zero-LLM,
 * schema-driven gate that actually spins the extension up in a sandbox
 * and round-trips a tool. Covers: pass; manifest-invalid FAIL;
 * missing-smokeTest FAIL (tool kind); tool returns isError FAIL;
 * assertion-mismatch FAIL; process killed in all paths.
 */

import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// subprocess.ts transitively imports db/queries/extensions — stub it so
// the test harness never touches a real DB.
mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

const { verifyExtension } = await import("../extensions/sdk/verify");
const { buildVerifyFixture } = await import("./helpers/verify-fixtures");

describe("verifyExtension — pass path", () => {
  test("valid manifest + smokeTest that round-trips ⇒ pass:true", async () => {
    const fx = buildVerifyFixture({ name: "verify-pass" });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(true);
      const stepNames = r.steps.map((s) => s.name);
      expect(stepNames).toContain("load-manifest");
      expect(stepNames).toContain("validate-manifest");
      expect(stepNames).toContain("smoke-test-present");
      expect(stepNames).toContain("smoke-test-roundtrip");
      expect(r.steps.every((s) => s.ok)).toBe(true);
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});

describe("verifyExtension — FAIL paths", () => {
  test("manifest fails to load ⇒ FAIL (no config)", async () => {
    const fx = buildVerifyFixture({ rawConfig: "export default 42;\n" });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(false);
      expect(r.steps[0]!.name).toBe("load-manifest");
      expect(r.steps[0]!.ok).toBe(false);
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("manifest invalid (bad smokeTest tool) ⇒ structured FAIL", async () => {
    // `loadManifest` runs `validateManifestV2` internally and throws on
    // invalid input, so an undeclared smokeTest.tool surfaces as a
    // structured FAIL at the load-manifest step — the validation error
    // is still in the detail. (A manifest that passes the loader's
    // validation but fails verify's standalone re-validation is
    // unreachable in practice; both call the same validator.)
    const fx = buildVerifyFixture({
      smokeTest: {
        tool: "does-not-exist",
        input: {},
        expect: { isError: false },
      },
    });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(false);
      const failStep = r.steps.find((s) => !s.ok);
      expect(failStep).toBeDefined();
      expect(failStep!.detail).toContain("not a declared tool");
      // No subprocess should have been spawned (we never reached
      // smoke-test-roundtrip).
      expect(r.steps.some((s) => s.name === "smoke-test-roundtrip")).toBe(
        false,
      );
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("tool/multi kind missing smokeTest ⇒ explicit FAIL", async () => {
    const fx = buildVerifyFixture({ smokeTest: null });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(false);
      const step = r.steps.find((s) => s.name === "smoke-test-present");
      expect(step?.ok).toBe(false);
      expect(step?.detail).toContain("MUST declare a `smokeTest`");
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("tool returns isError but expect.isError=false ⇒ FAIL", async () => {
    const fx = buildVerifyFixture({
      pingErrors: true,
      smokeTest: {
        tool: "ping",
        input: { message: "x" },
        expect: { isError: false },
      },
    });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(false);
      const step = r.steps.find((s) => s.name === "smoke-test-roundtrip");
      expect(step?.ok).toBe(false);
      expect(step?.detail).toContain("Smoke test failed");
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("assertion mismatch (textIncludes not found) ⇒ FAIL", async () => {
    const fx = buildVerifyFixture({
      pingText: "totally different output",
      smokeTest: {
        tool: "ping",
        input: { message: "x" },
        expect: { textIncludes: '"ok": true' },
      },
    });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(false);
      const step = r.steps.find((s) => s.name === "smoke-test-roundtrip");
      expect(step?.ok).toBe(false);
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});

describe("verifyExtension — skill/agent kinds (no tools)", () => {
  test("no tools + no smokeTest ⇒ pass (manifest validation is the gate)", async () => {
    const fx = buildVerifyFixture({
      rawConfig: `export default ${JSON.stringify({
        schemaVersion: 2,
        name: "skill-only-fx",
        version: "1.0.0",
        description: "skill only",
        author: { name: "t" },
        skills: [{ name: "s", description: "d", content: "c" }],
        permissions: {},
      })} as const;\n`,
    });
    try {
      const r = await verifyExtension({ extDir: fx.dir });
      expect(r.pass).toBe(true);
      const step = r.steps.find((s) => s.name === "smoke-test-present");
      expect(step?.ok).toBe(true);
      expect(step?.detail).toContain("none required");
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});
