import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

mock.module("../extensions/loader", () => ({
  loadManifest: async () => {
    throw new Error("verify.ts must call loadManifestFresh, not loadManifest");
  },
  loadManifestFresh: async () => ({
    schemaVersion: 2,
    version: "1.0.0",
    description: "invalid (no name) manifest that skipped loader validation",
    author: { name: "t" },
    permissions: {},
  }),
}));

afterAll(() => restoreModuleMocks());

const { verifyExtension } = await import("../extensions/sdk/verify");

describe("verifyExtension cannot regain host execution from a replaced loader", () => {
  test("a loader stub cannot turn the retired API into a passing verification", async () => {
    const r = await verifyExtension({ extDir: "/tmp/does-not-matter" });
    expect(r.pass).toBe(false);

    const load = r.steps.find((s) => s.name === "load-manifest");
    expect(load?.ok).toBe(false);
    expect(load?.detail).toContain("Host configuration evaluation is disabled");
    const validate = r.steps.find((s) => s.name === "validate-manifest");
    expect(validate).toBeUndefined();

    expect(r.steps.some((s) => s.name === "smoke-test-present")).toBe(false);
  });
});
