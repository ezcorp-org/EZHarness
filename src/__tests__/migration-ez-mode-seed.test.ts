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
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

const { sql } = await import("drizzle-orm");
const { getModeBySlug } = await import("../db/queries/modes");

// The exact page-context sentence the pre-9f persona carried and the new
// persona drops — the LIKE anchor migrate.ts step (9f) matches on.
const ANCHOR = "call read_page to get its content (route, headings, forms, and fields)";

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
    // Page-first answering: read the page before answering ANY visible-content
    // question, and escalate to summarize/search when the excerpt is truncated.
    expect(mode!.systemPromptInstruction).toContain("before answering ANY question about visible content");
    expect(mode!.systemPromptInstruction).toContain("summarize_conversation");
    expect(mode!.systemPromptInstruction).toContain("search_conversation");
    // The 9f LIKE anchor must be absent from the NEW persona, or the refresh
    // step would re-match and loop on fresh installs.
    expect(mode!.systemPromptInstruction).not.toContain(ANCHOR);
  });

  // ── Step (9f): gated persona refresh for page-first answering ──────────
  // The seeded fresh row already carries the NEW persona; these tests prove
  // the 9f UPDATE upgrades a STALE builtin row (LIKE-matched on the retired
  // page-context sentence) to the new persona, leaves non-builtin rows and
  // fresh (already-new) rows untouched, and is idempotent. They re-run the
  // EXACT 9f SQL migrate.ts emits (same convention as the allowlist tests).
  describe("Ez persona refresh (step 9f)", () => {
    let newPersona: string;
    beforeAll(async () => {
      // Captured BEFORE any mutation below — this is the clean seeded persona.
      const mode = await getModeBySlug("ez");
      newPersona = mode!.systemPromptInstruction!;
    });

    async function ezPersona(): Promise<string> {
      return (await getModeBySlug("ez"))!.systemPromptInstruction!;
    }

    test("a stale builtin row (retired page-context phrase) is refreshed to the new persona", async () => {
      const stale = `You are EZ. ${ANCHOR} whenever asked.`;
      await getTestDb().execute(
        sql`UPDATE modes SET system_prompt_instruction = ${stale}, builtin = TRUE WHERE slug = 'ez'`,
      );
      await getTestDb().execute(sql`
        UPDATE modes
        SET system_prompt_instruction = ${newPersona}
        WHERE slug = 'ez'
          AND builtin = TRUE
          AND system_prompt_instruction LIKE '%call read_page to get its content (route, headings, forms, and fields)%'
      `);
      expect(await ezPersona()).toBe(newPersona);
    });

    test("idempotent: re-running 9f after the refresh is a no-op (anchor gone → no match)", async () => {
      // Row now holds newPersona (from the prior test). Re-run with a bogus
      // SET value — the anchor-less new persona must NOT match, so it stays.
      await getTestDb().execute(sql`
        UPDATE modes
        SET system_prompt_instruction = 'SHOULD-NEVER-APPLY'
        WHERE slug = 'ez'
          AND builtin = TRUE
          AND system_prompt_instruction LIKE '%call read_page to get its content (route, headings, forms, and fields)%'
      `);
      expect(await ezPersona()).toBe(newPersona);
    });

    test("a non-builtin admin-tuned row with the anchor is left untouched (builtin guard)", async () => {
      const adminTuned = `Custom admin persona. ${ANCHOR} — do not clobber.`;
      await getTestDb().execute(
        sql`UPDATE modes SET system_prompt_instruction = ${adminTuned}, builtin = FALSE WHERE slug = 'ez'`,
      );
      await getTestDb().execute(sql`
        UPDATE modes
        SET system_prompt_instruction = ${newPersona}
        WHERE slug = 'ez'
          AND builtin = TRUE
          AND system_prompt_instruction LIKE '%call read_page to get its content (route, headings, forms, and fields)%'
      `);
      // builtin = FALSE → the guard blocked the update; admin text survives.
      expect(await ezPersona()).toBe(adminTuned);
    });
  });
});
