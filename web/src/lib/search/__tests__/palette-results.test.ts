/**
 * RED unit suite — cross-project grouping helper `buildPaletteResults`
 * (Phase 67 — Command Palette Search, plan 01 / TDD scaffold).
 *
 * This file is written TEST-FIRST against the Plan-05 import contract
 * (`web/src/lib/search/palette-results.ts`). That module does NOT exist
 * yet, so the `import { buildPaletteResults } from "../palette-results"`
 * below fails to resolve and this whole suite is RED by design. Plan 05
 * turns it GREEN by implementing the helper to this exact shape.
 *
 * Contract under test (see 67-01-PLAN.md <interfaces>):
 *   buildPaletteResults(
 *     matchingCommands: Command[],
 *     hits: MessageSearchHit[],
 *     activeConversationId: string | null,
 *   ): PaletteResults  // { sections, flatItems }
 *
 * The hit fixtures here carry `projectId` + `projectName` — the EXTENDED
 * MessageSearchHit shape that Plan 03 adds. Until Plan 03 lands those two
 * fields are not on the base type; the `as MessageSearchHit` casts on the
 * fixtures keep this file compiling against the current api.ts while still
 * pinning the cross-project grouping behavior the helper must produce.
 *
 * Branch coverage targets (both `activeConversationId` paths + empties +
 * flat-index ordering) so Plan 05's helper ships at the project's 100%
 * per-file bar with this suite as its sampling target.
 *
 * Section grouping MUST reuse `groupHitsByConversation` (search-mode.ts)
 * per-project rather than re-deriving the conversation grouping — these
 * assertions pin the first-seen-order semantics that helper guarantees.
 */
import { describe, test, expect } from "bun:test";
import type { MessageSearchHit } from "$lib/api.js";
import type { Command } from "$lib/command-registry";
// RED: ../palette-results does not exist yet (Plan 05 creates it).
import { buildPaletteResults } from "../palette-results";

// --- Fixtures ----------------------------------------------------------

function cmd(id: string, label: string): Command {
	return { id, label, group: "Navigate", action: () => {} };
}

// Hit factory carrying the Plan-03 EXTENDED shape (projectId/projectName).
// Cast to MessageSearchHit so this RED suite compiles against today's
// api.ts; Plan 03 widens the real type and the cast becomes a no-op.
function hit(
	overrides: Partial<MessageSearchHit> & {
		projectId: string;
		projectName: string;
		conversationId: string;
		conversationTitle: string;
		messageId: string;
	},
): MessageSearchHit {
	return {
		role: "user",
		createdAt: "2026-05-30T00:00:00.000Z",
		snippet: "a <mark>match</mark>",
		matchType: "both",
		rankLexical: 1,
		rankSemantic: 1,
		score: 1,
		...overrides,
	} as MessageSearchHit;
}

const ACTIVE_CONV = "conv-active";

// Two projects, plus the active conversation living in project A.
const activeHit = hit({
	projectId: "projA",
	projectName: "Project A",
	conversationId: ACTIVE_CONV,
	conversationTitle: "Active Conversation",
	messageId: "m-active-1",
});
const activeHit2 = hit({
	projectId: "projA",
	projectName: "Project A",
	conversationId: ACTIVE_CONV,
	conversationTitle: "Active Conversation",
	messageId: "m-active-2",
});
const otherAHit = hit({
	projectId: "projA",
	projectName: "Project A",
	conversationId: "conv-a-other",
	conversationTitle: "Other A Convo",
	messageId: "m-a-1",
});
const otherBHit = hit({
	projectId: "projB",
	projectName: "Project B",
	conversationId: "conv-b",
	conversationTitle: "B Convo",
	messageId: "m-b-1",
});

const commands = [cmd("go-home", "Go Home"), cmd("go-chat", "Go to Chat")];

function sectionById(r: ReturnType<typeof buildPaletteResults>, id: string) {
	return r.sections.find((s) => s.id === id);
}

// --- WITH an active conversation --------------------------------------

describe("buildPaletteResults — with an active conversation", () => {
	const res = buildPaletteResults(
		commands,
		[activeHit, activeHit2, otherAHit, otherBHit],
		ACTIVE_CONV,
	);

	test("section order is [commands, in-this-conversation, other]", () => {
		const ids = res.sections.map((s) => s.id);
		expect(ids).toEqual(["commands", "in-this-conversation", "other"]);
	});

	test("commands section carries the matching commands as rows", () => {
		const section = sectionById(res, "commands")!;
		const rows = section.groups.flatMap((g) => g.rows);
		expect(rows.map((r) => r.kind)).toEqual(["command", "command"]);
		expect(rows.map((r) => (r.kind === "command" ? r.command.id : null))).toEqual([
			"go-home",
			"go-chat",
		]);
	});

	test("in-this-conversation holds only hits from the active conversation", () => {
		const section = sectionById(res, "in-this-conversation")!;
		const rows = section.groups.flatMap((g) => g.rows);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.kind).toBe("hit");
			if (row.kind === "hit") expect(row.hit.conversationId).toBe(ACTIVE_CONV);
		}
	});

	test("'other' groups hits by projectId then conversationId, carrying names/titles", () => {
		const section = sectionById(res, "other")!;
		// Two projects → at least two groups; the active conversation must NOT leak in.
		const projectIds = section.groups.map((g) => g.projectId);
		expect(projectIds).toContain("projA");
		expect(projectIds).toContain("projB");
		for (const g of section.groups) {
			// project header carries projectName, conversation sub-header carries title
			expect(g.projectName).toBeTruthy();
			expect(g.conversationTitle).toBeTruthy();
			// none of the 'other' rows are the active conversation
			for (const row of g.rows) {
				if (row.kind === "hit") {
					expect(row.hit.conversationId).not.toBe(ACTIVE_CONV);
				}
			}
		}
		const a = section.groups.find((g) => g.projectId === "projA")!;
		expect(a.projectName).toBe("Project A");
		expect(a.conversationTitle).toBe("Other A Convo");
		const b = section.groups.find((g) => g.projectId === "projB")!;
		expect(b.projectName).toBe("Project B");
	});

	test("flatItems are actionable rows only, in render order (commands → active hits → other hits)", () => {
		// NEVER headers; commands first, then in-this-conversation, then other.
		expect(res.flatItems).toEqual([
			commands[0],
			commands[1],
			activeHit,
			activeHit2,
			otherAHit,
			otherBHit,
		]);
	});

	test("flat-index mapping is stable: ArrowDown from last command lands on first hit", () => {
		const lastCommandIdx = res.flatItems.indexOf(commands[1]);
		expect(res.flatItems[lastCommandIdx + 1]).toBe(activeHit);
		// indexOf of a hit matches its render order position
		expect(res.flatItems.indexOf(otherBHit)).toBe(res.flatItems.length - 1);
	});
});

// --- WITHOUT an active conversation -----------------------------------

describe("buildPaletteResults — no active conversation (activeConversationId === null)", () => {
	const res = buildPaletteResults(
		commands,
		[activeHit, otherAHit, otherBHit],
		null,
	);

	test("no in/other split — single 'messages' section after commands", () => {
		expect(res.sections.map((s) => s.id)).toEqual(["commands", "messages"]);
	});

	test("'messages' section is still project → conversation grouped", () => {
		const section = sectionById(res, "messages")!;
		const projectIds = section.groups.map((g) => g.projectId);
		expect(projectIds).toContain("projA");
		expect(projectIds).toContain("projB");
		for (const g of section.groups) {
			expect(g.projectName).toBeTruthy();
			expect(g.conversationTitle).toBeTruthy();
		}
	});

	test("flatItems still commands-first then all hits in render order", () => {
		expect(res.flatItems).toEqual([
			commands[0],
			commands[1],
			activeHit,
			otherAHit,
			otherBHit,
		]);
	});
});

// --- Empty-section policy + degenerate inputs -------------------------

describe("buildPaletteResults — empty-section handling", () => {
	test("empty sections are omitted (no commands → no commands section)", () => {
		const res = buildPaletteResults([], [otherBHit], ACTIVE_CONV);
		expect(res.sections.map((s) => s.id)).not.toContain("commands");
		// flatItems contains only the single hit
		expect(res.flatItems).toEqual([otherBHit]);
	});

	test("no hits → only the commands section, hits sections omitted", () => {
		const res = buildPaletteResults(commands, [], ACTIVE_CONV);
		expect(res.sections.map((s) => s.id)).toEqual(["commands"]);
		expect(res.flatItems).toEqual([commands[0], commands[1]]);
	});

	test("no commands and no hits → empty sections + empty flatItems", () => {
		const res = buildPaletteResults([], [], null);
		expect(res.sections).toEqual([]);
		expect(res.flatItems).toEqual([]);
	});

	test("active conversation with NO hits in it → in-this-conversation omitted, other kept", () => {
		const res = buildPaletteResults(commands, [otherBHit], ACTIVE_CONV);
		const ids = res.sections.map((s) => s.id);
		expect(ids).not.toContain("in-this-conversation");
		expect(ids).toContain("other");
	});
});

// --- first-seen-order grouping parity with search-mode.ts -------------

describe("buildPaletteResults — per-project grouping reuses first-seen order", () => {
	test("conversations within a project keep first-seen order", () => {
		const c1a = hit({
			projectId: "projA",
			projectName: "Project A",
			conversationId: "c1",
			conversationTitle: "C1",
			messageId: "m1",
		});
		const c2 = hit({
			projectId: "projA",
			projectName: "Project A",
			conversationId: "c2",
			conversationTitle: "C2",
			messageId: "m2",
		});
		const c1b = hit({
			projectId: "projA",
			projectName: "Project A",
			conversationId: "c1",
			conversationTitle: "C1",
			messageId: "m3",
		});
		// Interleaved c1, c2, c1 → groupHitsByConversation keeps [c1, c2]
		const res = buildPaletteResults([], [c1a, c2, c1b], null);
		const section = sectionById(res, "messages")!;
		const convOrder = section.groups.map((g) => g.conversationId);
		expect(convOrder).toEqual(["c1", "c2"]);
		// flatItems preserves interleaved render order grouped by conversation:
		// c1's two hits adjacent, then c2.
		expect(res.flatItems).toEqual([c1a, c1b, c2]);
	});
});
