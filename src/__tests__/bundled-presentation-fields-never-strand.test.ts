/**
 * GENERIC guard: authoring a presentation-only tool field must never
 * strand an already-installed bundled extension.
 *
 * Why this file exists rather than another one-off regression test.
 *
 * The S9 re-approval gate compares the DB-stored manifest against disk.
 * A non-critical disable `continue`s before BOTH the manifest refresh and
 * the re-enable branch, so the stored manifest can never converge — the
 * row stays disabled on every subsequent boot until an admin re-approves.
 * A PHANTOM drift is therefore a silent, total outage: the extension
 * registers no tools, so agents simply never see them.
 *
 * That has now happened twice — v2→v3 derived `capabilities`, then
 * authored `suggestExamples` (which killed web search for every agent).
 * Both were caught by a human noticing the outage, then pinned by a
 * bespoke test AFTER the fact. Neither test protects against the NEXT
 * presentation-only field someone adds.
 *
 * Crucially, no fresh-install test can catch this class: on first install
 * the stored manifest IS the disk manifest, so drift is always zero and
 * the gate never fires. The bug only exists on UPGRADE. CI was green the
 * entire time web-search was dead in production.
 *
 * So this guard is driven off `NON_SEMANTIC_TOOL_FIELDS` and iterates
 * EVERY bundled extension: adding a field to that list automatically
 * extends coverage to all of them, and a maintainer who adds a
 * presentation field WITHOUT listing it fails here instead of stranding
 * every already-installed row in production.
 *
 * Filesystem-real but DB-free — mirrors `bundled-manifests-installable`.
 */

import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  canonicalizeAndHash,
  canonicalizeAndHashForReapproval,
  NON_SEMANTIC_TOOL_FIELDS,
} from "../extensions/bundled-lock";
import { resolveBundledExtensions, getProjectRoot } from "../extensions/bundled";
import { loadManifestFresh } from "../extensions/loader";
import { migrateManifestV2ToV3 } from "../extensions/manifest";
import type { ToolDefinition } from "../extensions/types";

/**
 * Load every bundled manifest UP FRONT so the tool arrays are available
 * synchronously at describe-time. That lets us skip generating cases for
 * entrypoint-less agent bundles (no tools) instead of early-returning
 * inside a test — an assertion-free test is a gate-integrity violation,
 * and it would also quietly under-report coverage.
 */
const withTools: Array<{ name: string; tools: ToolDefinition[] }> = [];
for (const entry of resolveBundledExtensions()) {
  const manifest = await loadManifestFresh(join(getProjectRoot(), entry.path));
  const tools = (migrateManifestV2ToV3(manifest).tools ?? []) as ToolDefinition[];
  if (tools.length > 0) withTools.push({ name: entry.name, tools });
}

/** The presentation-only field names, typed so indexing stays checked. */
type PresentationField = (typeof NON_SEMANTIC_TOOL_FIELDS)[number];

/** Drop one field from every tool — simulates a row installed BEFORE
 *  that field was authored (the live web-search state). */
function without(tools: ToolDefinition[], field: PresentationField): ToolDefinition[] {
  return tools.map((t) => {
    const copy: ToolDefinition = { ...t };
    delete copy[field];
    return copy;
  });
}

/** A different, TYPE-CORRECT value for each presentation field — an
 *  array of phrasings for `suggestExamples`, a real card name for
 *  `cardType`. A generic stand-in would still prove the field is
 *  stripped, but only by accident: `cardType` is validated against
 *  `KNOWN_CARD_TYPES`, so the edit a maintainer actually makes is a
 *  swap between two valid card names. */
const PERTURBED_VALUE: Record<PresentationField, unknown> = {
  suggestExamples: ["totally different phrasing"],
  cardType: "terminal",
};

/** Change one field's value on every tool — simulates a maintainer
 *  EDITING an existing presentation field rather than adding it. */
function perturbed(tools: ToolDefinition[], field: PresentationField): ToolDefinition[] {
  return tools.map((t) => ({ ...t, [field]: PERTURBED_VALUE[field] }) as ToolDefinition);
}

describe("presentation-only tool fields never strand an installed row", () => {
  test("the guard actually covers the bundled tool-bearing set", () => {
    // Guards the guard: if manifest loading silently yielded nothing,
    // every per-extension case below would vacuously pass.
    expect(withTools.length).toBeGreaterThan(0);
    expect(NON_SEMANTIC_TOOL_FIELDS.length).toBeGreaterThan(0);
    expect(withTools.map((e) => e.name)).toContain("web-search");
  });

  for (const { name, tools } of withTools) {
    describe(name, () => {
      for (const field of NON_SEMANTIC_TOOL_FIELDS) {
        test(`adding \`${field}\` does not fire the S9 gate`, () => {
          expect(canonicalizeAndHashForReapproval(without(tools, field))).toBe(
            canonicalizeAndHashForReapproval(tools),
          );
        });

        test(`editing \`${field}\` does not fire the S9 gate`, () => {
          expect(canonicalizeAndHashForReapproval(perturbed(tools, field))).toBe(
            canonicalizeAndHashForReapproval(tools),
          );
        });
      }

      // The gate must still have teeth for this extension: a real
      // contract edit has to flip the signature. Without this, a bug that
      // made `canonicalizeAndHashForReapproval` constant would pass every
      // assertion above.
      test("a real description change DOES fire the S9 gate", () => {
        const edited = tools.map((t, i) =>
          i === 0 ? ({ ...t, description: `${t.description} (edited)` } as ToolDefinition) : t,
        );
        expect(canonicalizeAndHashForReapproval(edited)).not.toBe(
          canonicalizeAndHashForReapproval(tools),
        );
      });
    });
  }
});

describe("the lockfile hash keeps full fidelity", () => {
  // The two hashes answer different questions and must not converge:
  // S9 asks "does this need admin consent?", the lockfile asks "did
  // anything change at all?". If someone 'simplifies' by pointing
  // verifyManifestAgainstLock at the re-approval hash, tamper detection
  // silently stops seeing these fields.
  for (const field of NON_SEMANTIC_TOOL_FIELDS) {
    test(`\`${field}\` still moves the lockfile hash`, () => {
      const base = [
        {
          name: "t",
          description: "d",
          inputSchema: { type: "object" },
        } as ToolDefinition,
      ];
      const withField = [{ ...base[0]!, [field]: PERTURBED_VALUE[field] } as ToolDefinition];
      expect(canonicalizeAndHash(withField)).not.toBe(canonicalizeAndHash(base));
    });
  }
});
