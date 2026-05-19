/**
 * Deterministic extension acceptance — `ezcorp ext verify`.
 *
 * Root-cause fix #2 of the harness-smoke-test loop incident: there was
 * no machine-checked "this extension loads in the sandbox and a tool
 * round-trips" gate. "installed/enabled" came from registry state and an
 * LLM hallucinated "use the ping tool". This module is a ZERO-LLM,
 * schema-driven pipeline that produces a structured PASS/FAIL artifact.
 *
 * Pipeline:
 *   1. loadManifest → validateManifestV2 (fail ⇒ structured FAIL).
 *   2. tool/multi kinds REQUIRE a `smokeTest` block (else FAIL).
 *   3. createTestExtension(extDir, {sandbox:true}) → proc.callTool(
 *      smokeTest.tool, smokeTest.input) → assertToolResult(result,
 *      smokeTest.expect) → proc.kill() in `finally` (every path).
 *   4. Return `VerifyResult { pass, steps: {name,ok,detail}[] }`.
 */

import { loadManifest } from "../loader";
import { validateManifestV2 } from "../manifest";
import { createTestExtension, assertToolResult } from "./test-helpers";
import type { ExtensionManifestV2, ToolCallResult } from "../types";

export interface VerifyStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  pass: boolean;
  steps: VerifyStep[];
}

export interface VerifyExtensionOptions {
  extDir: string;
}

/**
 * Does this manifest's acceptance REQUIRE a passing smokeTest?
 *
 * The v2 manifest schema only carries `kind?: "local" | "mcp"`; the
 * scaffold-time tool/multi/skill/agent distinction is not persisted.
 * The deterministic question the spec actually asks is "does this have
 * LLM-callable tools that must round-trip" — `tools[].length > 0` AND
 * not an MCP-cache manifest answers it precisely and is robust to the
 * scaffold's `multi` shape (tools + skill + agent), which also declares
 * tools and therefore correctly requires a smokeTest.
 */
function requiresSmokeTest(manifest: ExtensionManifestV2): boolean {
  if (manifest.kind === "mcp") return false;
  return Array.isArray(manifest.tools) && manifest.tools.length > 0;
}

/**
 * Run the deterministic acceptance pipeline against an extension dir.
 * Never throws — every failure mode is captured as a `VerifyStep` with
 * `ok:false` and `pass:false`.
 */
export async function verifyExtension(
  opts: VerifyExtensionOptions,
): Promise<VerifyResult> {
  const { extDir } = opts;
  const steps: VerifyStep[] = [];

  // ── Step 1: load + validate manifest ──────────────────────────────
  let manifest: ExtensionManifestV2;
  try {
    manifest = await loadManifest(extDir);
  } catch (err) {
    steps.push({
      name: "load-manifest",
      ok: false,
      detail: `Failed to load manifest: ${(err as Error).message}`,
    });
    return { pass: false, steps };
  }
  steps.push({
    name: "load-manifest",
    ok: true,
    detail: `Loaded ${manifest.name}@${manifest.version}`,
  });

  const validation = validateManifestV2(manifest);
  if (!validation.valid) {
    steps.push({
      name: "validate-manifest",
      ok: false,
      detail: `Manifest invalid: ${validation.errors.join("; ")}`,
    });
    return { pass: false, steps };
  }
  steps.push({
    name: "validate-manifest",
    ok: true,
    detail: "Manifest passed validateManifestV2",
  });

  // ── Step 2: smokeTest presence (required for tool/multi) ───────────
  if (!manifest.smokeTest) {
    if (requiresSmokeTest(manifest)) {
      steps.push({
        name: "smoke-test-present",
        ok: false,
        detail:
          "tool/multi extensions MUST declare a `smokeTest` block " +
          "(tool + input + expect) for deterministic acceptance — " +
          "none found in ezcorp.config.ts",
      });
      return { pass: false, steps };
    }
    // skill/agent/mcp with no smokeTest — nothing to round-trip, the
    // manifest-validation steps above are the full acceptance.
    steps.push({
      name: "smoke-test-present",
      ok: true,
      detail: "No smokeTest declared and none required for this kind",
    });
    return { pass: true, steps };
  }
  steps.push({
    name: "smoke-test-present",
    ok: true,
    detail: `smokeTest targets tool "${manifest.smokeTest.tool}"`,
  });

  // ── Step 3: sandboxed round-trip ───────────────────────────────────
  const smoke = manifest.smokeTest;
  let proc: Awaited<ReturnType<typeof createTestExtension>> | null = null;
  try {
    proc = await createTestExtension(extDir, { sandbox: true });
    const result: ToolCallResult = await proc.callTool(
      smoke.tool,
      smoke.input,
    );
    // assertToolResult uses `{ text, isError }`; the smokeTest schema
    // uses `{ textIncludes, isError }`. Map across the boundary.
    assertToolResult(result, {
      isError: smoke.expect.isError,
      text: smoke.expect.textIncludes,
    });
    steps.push({
      name: "smoke-test-roundtrip",
      ok: true,
      detail: `Tool "${smoke.tool}" round-tripped and matched expectations`,
    });
    return { pass: true, steps };
  } catch (err) {
    steps.push({
      name: "smoke-test-roundtrip",
      ok: false,
      detail: `Smoke test failed: ${(err as Error).message}`,
    });
    return { pass: false, steps };
  } finally {
    if (proc) {
      try {
        proc.kill();
      } catch {
        // Best-effort cleanup — never let a kill error mask the verdict.
      }
    }
  }
}
