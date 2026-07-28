/**
 * `runAuthorAcceptanceGate` — the ONE gate the extension-author path
 * runs, shared by the web preview page's Validate button and the
 * install pipeline.
 *
 * The bug it exists to prevent: Validate ran manifest validation only
 * while install ran the full sandboxed round-trip, so a draft with a
 * broken `smokeTest` rendered "Manifest valid. Ready to install." and
 * then 422'd on install. These tests pin that the gate's verdict is
 * type-aware and identical for both callers.
 *
 * The loader + verify collaborators are mocked so each branch is driven
 * deterministically; the directory/manifest presence checks run against
 * a real temp dir.
 */

import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let manifestImpl: () => Promise<unknown> = async () => ({
  name: "weather",
  version: "1.0.0",
});
let verifyImpl: () => Promise<{
  pass: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}> = async () => ({
  pass: true,
  steps: [
    { name: "load-manifest", ok: true, detail: "Loaded weather@1.0.0" },
    { name: "smoke-test-roundtrip", ok: true, detail: "round-tripped" },
  ],
});
let verifyCalls = 0;

mock.module("../extensions/loader", () => ({
  loadManifest: () => {
    throw new Error("the gate must call loadManifestFresh");
  },
  loadManifestFresh: () => manifestImpl(),
}));
mock.module("../extensions/sdk/verify", () => ({
  verifyExtension: () => {
    verifyCalls++;
    return verifyImpl();
  },
}));

afterAll(() => restoreModuleMocks());

const { runAuthorAcceptanceGate, VERIFY_REQUIRED_TYPES } = await import(
  "../extensions/author-gate"
);

let DIR = "";

beforeEach(() => {
  DIR = join(tmpdir(), `gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "ezcorp.config.ts"), "export default {};\n");
  manifestImpl = async () => ({ name: "weather", version: "1.0.0" });
  verifyImpl = async () => ({
    pass: true,
    steps: [
      { name: "load-manifest", ok: true, detail: "Loaded weather@1.0.0" },
      { name: "smoke-test-roundtrip", ok: true, detail: "round-tripped" },
    ],
  });
  verifyCalls = 0;
});
afterEach(() => {
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("runAuthorAcceptanceGate — manifest failures", () => {
  test("missing ezcorp.config.ts → MANIFEST_INVALID", async () => {
    rmSync(join(DIR, "ezcorp.config.ts"));
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MANIFEST_INVALID");
    expect(r.errors).toEqual(["Missing ezcorp.config.ts"]);
    expect(r.steps[0]).toEqual({
      name: "manifest-present",
      ok: false,
      detail: "Missing ezcorp.config.ts",
    });
    // Never spins a sandbox for a draft with no manifest.
    expect(verifyCalls).toBe(0);
  });

  test("loader throws → MANIFEST_INVALID carrying the loader message", async () => {
    manifestImpl = async () => {
      throw new Error("Invalid manifest: name required");
    };
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MANIFEST_INVALID");
    expect(r.errors).toEqual(["Invalid manifest: name required"]);
    expect(r.steps.find((s) => s.name === "load-manifest")?.ok).toBe(false);
    expect(verifyCalls).toBe(0);
  });

  test("loader throws a non-Error → still MANIFEST_INVALID with a string detail", async () => {
    manifestImpl = async () => {
      throw "kaboom";
    };
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(r.code).toBe("MANIFEST_INVALID");
    expect(r.errors).toEqual(["kaboom"]);
  });

  test("manifest resolves with no name → MANIFEST_INVALID", async () => {
    manifestImpl = async () => ({ version: "1.0.0" });
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "skill" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MANIFEST_INVALID");
    expect(r.errors).toEqual(["name required"]);
  });

  test("manifest resolves with an empty name → MANIFEST_INVALID", async () => {
    manifestImpl = async () => ({ name: "", version: "1.0.0" });
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "skill" });
    expect(r.code).toBe("MANIFEST_INVALID");
  });
});

describe("runAuthorAcceptanceGate — type-aware round-trip requirement", () => {
  test("skill draft passes on manifest validation alone (no sandbox spawned)", async () => {
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "skill" });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(verifyCalls).toBe(0);
    expect(r.manifest?.name).toBe("weather");
    expect(r.manifest?.version).toBe("1.0.0");
    const smoke = r.steps.find((s) => s.name === "smoke-test-present");
    expect(smoke?.ok).toBe(true);
    expect(smoke?.detail).toContain('"skill" draft');
  });

  test("tool draft runs the sandboxed round-trip and can PASS", async () => {
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(r.ok).toBe(true);
    expect(verifyCalls).toBe(1);
    // Our own load-manifest step survives; verify's duplicate does not.
    expect(r.steps.filter((s) => s.name === "load-manifest").length).toBe(1);
    expect(r.steps.some((s) => s.name === "smoke-test-roundtrip")).toBe(true);
  });

  test("multi draft also runs the round-trip", async () => {
    await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "multi" });
    expect(verifyCalls).toBe(1);
    expect(VERIFY_REQUIRED_TYPES.has("multi")).toBe(true);
    expect(VERIFY_REQUIRED_TYPES.has("agent")).toBe(false);
  });

  test("tool draft with a failing smokeTest → VERIFY_FAILED naming the step", async () => {
    verifyImpl = async () => ({
      pass: false,
      steps: [
        { name: "load-manifest", ok: true, detail: "Loaded weather@1.0.0" },
        { name: "smoke-test-roundtrip", ok: false, detail: "Smoke test failed: boom" },
      ],
    });
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("VERIFY_FAILED");
    expect(r.errors).toEqual(["smoke-test-roundtrip: Smoke test failed: boom"]);
    expect(r.manifest).toBeUndefined();
  });

  test("verify fails with no failing step → generic 'verify failed'", async () => {
    verifyImpl = async () => ({ pass: false, steps: [] });
    const r = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(r.code).toBe("VERIFY_FAILED");
    expect(r.errors).toEqual(["verify failed"]);
  });
});

describe("runAuthorAcceptanceGate — the two surfaces agree", () => {
  test("the SAME draft yields the same verdict for validate and install", async () => {
    verifyImpl = async () => ({
      pass: false,
      steps: [
        {
          name: "smoke-test-present",
          ok: false,
          detail: "tool/multi extensions MUST declare a `smokeTest` block",
        },
      ],
    });
    // Whatever the caller, one gate, one verdict — this is the H2 fix:
    // a "Validate" that reported ok:true here would be lying.
    const a = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    const b = await runAuthorAcceptanceGate({ draftDir: DIR, draftType: "tool" });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.errors).toEqual(b.errors);
    expect(a.code).toBe(b.code);
  });
});
