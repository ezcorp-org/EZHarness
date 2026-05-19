import { test, expect, describe } from "bun:test";
import { helpContent } from "$lib/data/help-content";

/**
 * The chat composer's `?` tooltip is the discoverability path for the
 * three mention sigils. If this text drifts (e.g. silently reverts to
 * an old `@agent:name` copy), users won't learn about slash commands
 * even though the feature is live — this test locks in the current
 * wording so any future edit is a deliberate choice.
 */
describe("helpContent.chat.mentions tooltip", () => {
	const text = helpContent["chat.mentions"];

	test("documents all three trigger sigils", () => {
		expect(text).toBeDefined();
		expect(text).toMatch(/\/\s/); // "/ " for slash-commands bullet
		expect(text).toMatch(/@\s/); // "@ " for files bullet
		expect(text).toMatch(/!\s/); // "! " for agents/ext/teams bullet
	});

	test("mentions each trigger's purpose explicitly", () => {
		expect(text.toLowerCase()).toContain("slash command");
		expect(text.toLowerCase()).toContain("files");
		expect(text.toLowerCase()).toContain("agents");
		expect(text.toLowerCase()).toContain("extensions");
	});

	test("explains argument substitution so users know /cmd args does something", () => {
		expect(text).toContain("$ARGUMENTS");
	});

	test("does NOT reference legacy `@agent:` / `@ext:` grammar", () => {
		// Those prefixes belong to the pre-sigil-split grammar; surfacing
		// them in the tooltip teaches users the wrong thing.
		expect(text).not.toMatch(/@agent:/i);
		expect(text).not.toMatch(/@ext:/i);
	});

	test("keeps a realistic length — tooltip is a 256px wide box", () => {
		// If we cross ~500 chars the tooltip becomes unreadable. Anything
		// shorter than ~120 chars probably dropped one of the sigils.
		expect(text.length).toBeGreaterThan(120);
		expect(text.length).toBeLessThan(500);
	});
});
