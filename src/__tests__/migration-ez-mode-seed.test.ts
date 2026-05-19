/**
 * Phase 48 Wave 1 — Migration assertion: the 'ez' mode is seeded with
 * the exact seven-tool allowlist the Ez concierge requires.
 *
 * If anyone reorders / drops / renames an entry in the migration's
 * ARRAY[...] literal, this test catches it before the change ships.
 * Drift between the seed and the design contract would silently
 * disable an Ez capability.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { getModeBySlug } = await import("../db/queries/modes");

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("Ez mode seed (post-migration)", () => {
  test("the 'ez' slug exists with builtin = true", async () => {
    const mode = await getModeBySlug("ez");
    expect(mode).toBeDefined();
    expect(mode!.builtin).toBe(true);
    // Personal-data-free invariants: no userId on builtin modes.
    expect(mode!.userId).toBeNull();
  });

  test("toolRestriction is 'allowlist' (not 'all' / 'read-only' / 'none')", async () => {
    const mode = await getModeBySlug("ez");
    expect(mode!.toolRestriction).toBe("allowlist");
  });

  test("allowedTools contains the design-spec tool names plus extension-author/create_extension", async () => {
    const mode = await getModeBySlug("ez");
    // Migration step `migrate.ts:1252-1271` appends `extension-author/create_extension`
    // to Ez mode's allowed_tools after the initial 7-tool seed at `migrate.ts:891`.
    const expected = [
      "propose_create_project",
      "propose_create_agent",
      "propose_install_extension",
      "summarize_conversation",
      "find_agents",
      "fill_form",
      "navigate_to",
      "extension-author/create_extension",
    ];
    expect(mode!.allowedTools).toEqual(expected);
  });

  test("system_prompt_instruction carries the Ez persona text", async () => {
    const mode = await getModeBySlug("ez");
    // Lock down the load-bearing phrases of Appendix A so a tuning edit
    // can't accidentally drop the "concierge" framing or the explicit
    // "not a general-purpose assistant" guardrail.
    expect(mode!.systemPromptInstruction).toContain("concierge");
    expect(mode!.systemPromptInstruction).toContain("not a general-purpose assistant");
    // The persona references the propose_* tool family (wildcard form,
    // not literal individual names).
    expect(mode!.systemPromptInstruction).toContain("propose_*");
    // After the page-context-pushing mechanism was retired, the persona
    // explicitly tells the model it has limited page awareness.
    expect(mode!.systemPromptInstruction).toContain("limited awareness");
  });
});
