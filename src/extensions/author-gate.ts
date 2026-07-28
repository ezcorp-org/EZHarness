/**
 * THE acceptance gate for the extension-author path — one implementation,
 * shared by every "is this draft installable?" surface.
 *
 * Before this module there were TWO gates and they disagreed. The web
 * preview page's Validate button ran manifest validation only, while
 * install hard-gated on the full `verifyExtension` (manifest + a
 * sandboxed `smokeTest` round-trip). A draft with a broken smokeTest
 * therefore showed "Manifest valid. Ready to install." and then failed
 * the install with a 422 — the Validate button was lying about the thing
 * it exists to answer.
 *
 * Both surfaces now call `runAuthorAcceptanceGate` and render/return the
 * same `{ ok, steps, errors }` shape the in-chat `validate_extension`
 * tool already returns, so "green here" means "installable" everywhere.
 *
 * Deliberately narrow imports (loader + verify only): the web validate
 * route pulls this in, and it must not drag the installer/registry/DB
 * graph into a read-only endpoint.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifestFresh } from "./loader";
import { verifyExtension, type VerifyStep } from "./sdk/verify";
import type { ExtensionManifestV2 } from "./types";

/**
 * Draft types that MUST clear the deterministic round-trip (a passing
 * `smokeTest` executed in a real sandbox) before install. skill/agent
 * ship no subprocess to round-trip, so manifest validation is their
 * complete acceptance.
 */
export const VERIFY_REQUIRED_TYPES: ReadonlySet<string> = new Set([
  "tool",
  "multi",
]);

export type AuthorGateFailureCode = "MANIFEST_INVALID" | "VERIFY_FAILED";

export interface AuthorGateResult {
  /** True only when the draft would survive an install right now. */
  ok: boolean;
  /** Per-step verdicts, same shape as `VerifyResult.steps`. */
  steps: VerifyStep[];
  /** Flat human/LLM-readable failure list. Empty when `ok`. */
  errors: string[];
  /** Which install error the failure maps to. Absent when `ok`. */
  code?: AuthorGateFailureCode;
  /** The validated manifest. Present only when `ok`. */
  manifest?: ExtensionManifestV2;
}

/**
 * Run the full acceptance gate against a draft directory.
 *
 * `draftType` is the scaffold type recorded on the draft row
 * (`payload.type`); it selects whether the sandboxed round-trip is
 * required. Never throws — every failure is a structured step.
 */
export async function runAuthorAcceptanceGate(args: {
  draftDir: string;
  draftType: string;
}): Promise<AuthorGateResult> {
  const { draftDir, draftType } = args;
  const steps: VerifyStep[] = [];

  const cfgPath = join(draftDir, "ezcorp.config.ts");
  if (!existsSync(cfgPath)) {
    steps.push({
      name: "manifest-present",
      ok: false,
      detail: "Missing ezcorp.config.ts",
    });
    return {
      ok: false,
      steps,
      errors: ["Missing ezcorp.config.ts"],
      code: "MANIFEST_INVALID",
    };
  }
  steps.push({
    name: "manifest-present",
    ok: true,
    detail: "Found ezcorp.config.ts",
  });

  // Cache-busted read — the caller is mid edit→revalidate loop on this
  // exact path (see loader.ts's `loadManifestFresh` contract).
  let manifest: ExtensionManifestV2;
  try {
    manifest = await loadManifestFresh(draftDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    steps.push({ name: "load-manifest", ok: false, detail: msg });
    return { ok: false, steps, errors: [msg], code: "MANIFEST_INVALID" };
  }

  const name = (manifest as { name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) {
    steps.push({
      name: "load-manifest",
      ok: false,
      detail: "Manifest missing name",
    });
    return {
      ok: false,
      steps,
      errors: ["name required"],
      code: "MANIFEST_INVALID",
    };
  }
  steps.push({
    name: "load-manifest",
    ok: true,
    detail: `Loaded ${name}@${manifest.version}`,
  });

  if (!VERIFY_REQUIRED_TYPES.has(draftType)) {
    steps.push({
      name: "smoke-test-present",
      ok: true,
      detail: `No sandboxed round-trip required for a "${draftType}" draft`,
    });
    return { ok: true, steps, errors: [], manifest };
  }

  const verifyResult = await verifyExtension({ extDir: draftDir });
  // verify re-loads the manifest itself; keep OUR load-manifest step
  // (already reported above) and append the rest so the caller sees one
  // linear, non-duplicated step list.
  steps.push(...verifyResult.steps.filter((s) => s.name !== "load-manifest"));
  if (!verifyResult.pass) {
    const failed = verifyResult.steps.find((s) => !s.ok);
    return {
      ok: false,
      steps,
      errors: [failed ? `${failed.name}: ${failed.detail}` : "verify failed"],
      code: "VERIFY_FAILED",
    };
  }
  return { ok: true, steps, errors: [], manifest };
}
