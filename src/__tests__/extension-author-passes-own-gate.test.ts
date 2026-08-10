/**
 * M5 — the gatekeeper must pass its own gate.
 *
 * `extension-author` declares eight tools, and `verifyExtension` HARD-
 * REQUIRES a `smokeTest` block for any non-mcp manifest that declares
 * tools (`sdk/verify.ts:107-118`). For a while it shipped without one:
 * the extension that gates everyone else's extensions would have failed
 * its own acceptance gate, and nothing in the suite noticed because
 * every test that touches the gate mocks `verifyExtension` away
 * (`author-acceptance-gate.test.ts:44`).
 *
 * This runs the REAL `verifyExtension` against the REAL on-disk
 * extension-author directory. It spawns the extension as a sandboxed
 * subprocess with NO host on the other end of the reverse-RPC channel,
 * which is exactly the constraint the smokeTest is designed around: the
 * probe targets `create_extension`'s argument validation, the one path
 * that completes entirely inside the subprocess. A future edit that
 * drops the smokeTest, breaks the probe, or makes it round-trip to the
 * host (which would hang forever) fails here.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { verifyExtension } from "../extensions/sdk/verify";
import { loadManifestFresh } from "../extensions/loader";
import { getProjectRoot } from "../extensions/bundled";

const EXT_DIR = join(getProjectRoot(), "docs/extensions/examples/extension-author");

describe("extension-author passes its own acceptance gate", () => {
  test("its manifest declares tools AND a smokeTest targeting one of them", async () => {
    const manifest = await loadManifestFresh(EXT_DIR);

    expect(manifest.name).toBe("extension-author");
    expect((manifest.tools ?? []).length).toBeGreaterThan(0);
    // The condition that makes the smokeTest mandatory.
    expect(manifest.kind).not.toBe("mcp");

    const smoke = manifest.smokeTest;
    expect(smoke).toBeDefined();
    // The probe must name a tool the manifest actually serves, or the
    // round-trip below dies on "unknown tool" instead of exercising it.
    const toolNames = (manifest.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain(smoke!.tool);
  });

  test("verifyExtension round-trips it through a real sandboxed subprocess", async () => {
    const result = await verifyExtension({ extDir: EXT_DIR });

    const failed = result.steps.filter((s) => !s.ok);
    // Name the failing steps in the message — a bare `false` here is
    // useless when the subprocess died on a module-load error.
    expect(failed.map((s) => `${s.name}: ${s.detail}`).join(" | ")).toBe("");
    expect(result.pass).toBe(true);

    // The round-trip step specifically must have RUN, not been skipped
    // as "not required for this kind" — that skip is what would hide a
    // regression back to no-smokeTest.
    const roundTrip = result.steps.find((s) => s.name === "smoke-test-roundtrip");
    expect(roundTrip).toBeDefined();
    expect(roundTrip!.ok).toBe(true);
  }, 120_000);
});
