/**
 * Coverage for `verifyExtension`'s STANDALONE manifest re-validation arm
 * (verify.ts validate-manifest FAIL branch).
 *
 * In normal operation `loadManifest` runs `validateManifestV2` internally
 * and throws on invalid input, so the verify pipeline's own
 * `validateManifestV2(manifest)` re-check is belt-and-suspenders that the
 * fixture-driven suite (verify-extension.test.ts) can't reach — both call
 * the same validator. To exercise the re-check's FAIL arm we stub
 * `loadManifest` to RESOLVE with a structurally-invalid manifest (skipping
 * the loader's own validation), so verify's standalone re-validation is
 * the gate that catches it. This is the only seam that drives the
 * `validate-manifest` `ok:false` step + early `{ pass:false }` return.
 *
 * Isolated in its own file because the
 * `mock.module("../extensions/loader", …)` stub is process-wide and must
 * NOT bleed into the fixture suite's real loader.
 */
import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// subprocess.ts (transitively imported by verify) pulls in
// db/queries/extensions — stub so no real DB is touched.
mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

// Stub the loader so it RESOLVES with a manifest that has NOT been
// validated — a missing `name` (required by validateManifestV2) makes the
// standalone re-check fail.
mock.module("../extensions/loader", () => ({
  loadManifest: async () => ({
    schemaVersion: 2,
    // name omitted on purpose → validateManifestV2 reports it invalid.
    version: "1.0.0",
    description: "invalid (no name) manifest that skipped loader validation",
    author: { name: "t" },
    permissions: {},
  }),
}));

afterAll(() => restoreModuleMocks());

const { verifyExtension } = await import("../extensions/sdk/verify");

describe("verifyExtension — standalone validateManifestV2 re-check FAIL arm", () => {
  test("a manifest that loads but fails validateManifestV2 ⇒ validate-manifest step FAIL + pass:false", async () => {
    const r = await verifyExtension({ extDir: "/tmp/does-not-matter" });
    expect(r.pass).toBe(false);

    // load-manifest succeeded (the stub resolved), so the FAIL is at the
    // standalone validate-manifest step — the belt-and-suspenders arm.
    const load = r.steps.find((s) => s.name === "load-manifest");
    expect(load?.ok).toBe(true);
    const validate = r.steps.find((s) => s.name === "validate-manifest");
    expect(validate).toBeDefined();
    expect(validate!.ok).toBe(false);
    expect(validate!.detail).toContain("Manifest invalid");

    // Pipeline short-circuited before any smoke-test step.
    expect(r.steps.some((s) => s.name === "smoke-test-present")).toBe(false);
  });
});
