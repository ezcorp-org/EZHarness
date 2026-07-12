/**
 * Migration assertion: the 'ez' mode is seeded with the exact eight-tool
 * native allowlist the Ez concierge requires, plus the bundled
 * extension-author tool appended (under its runtime `__` namespaced name)
 * by the follow-up migration step.
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

  test("allowedTools contains the nine native tool names plus extension-author__create_extension", async () => {
    const mode = await getModeBySlug("ez");
    // The seed ARRAY holds the nine native Ez tools (fresh-install order);
    // the follow-up migrate.ts step (9) appends the bundled
    // `extension-author__create_extension` under its runtime `__`
    // namespaced name (double underscore — the '/' form never matched the
    // runtime tool name).
    const expected = [
      "propose_create_project",
      "propose_create_agent",
      "propose_install_extension",
      "summarize_conversation",
      "search_conversation",
      "find_agents",
      "fill_form",
      "navigate_to",
      "read_page",
      "extension-author__create_extension",
    ];
    expect(mode!.allowedTools).toEqual(expected);
  });

  test("system_prompt_instruction carries the refreshed Ez persona text", async () => {
    const mode = await getModeBySlug("ez");
    // Lock down the load-bearing phrases of the restored persona so a
    // tuning edit can't accidentally drop the "concierge" framing or the
    // on-demand page-context capability.
    expect(mode!.systemPromptInstruction).toContain("concierge");
    // The persona references the propose_* tool family (wildcard form,
    // not literal individual names).
    expect(mode!.systemPromptInstruction).toContain("propose_*");
    // The restore re-enabled on-demand page context, so the persona now
    // tells the model it CAN see the page (via read_page) — the retired
    // "You CANNOT see their open page" line must be gone.
    expect(mode!.systemPromptInstruction).toContain("You CAN see the page");
    expect(mode!.systemPromptInstruction).toContain("read_page");
    expect(mode!.systemPromptInstruction).not.toContain("You CANNOT see their open page");
  });
});
