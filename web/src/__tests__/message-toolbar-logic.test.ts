import { test, expect, describe } from "bun:test";

// Pure logic extracted from MessageToolbar.svelte

type Role = "user" | "assistant";

/** Whether edit action should be available. */
function canEdit(role: Role, onedit: boolean): boolean {
	return role === "user" && onedit;
}

/** Whether regenerate action should be available. */
function canRegenerate(role: Role, onregenerate: boolean): boolean {
	return role === "assistant" && onregenerate;
}

/** Whether the retry button is shown instead of normal actions. */
function showRetryOnly(isError: boolean, onretry: boolean): boolean {
	return isError && onretry;
}

/** Whether save-memory button appears. */
function hasSaveMemory(onsavememory: boolean): boolean {
	return onsavememory;
}

/**
 * Derive the memory button aria-label based on state.
 * Mirrors the logic in the template:
 *   justSaved -> 'Saved to memory!'
 *   showRemove -> 'Remove from memory'
 *   isSaved -> 'Saved to memory'
 *   else -> 'Save to memory'
 */
function memoryButtonLabel(opts: {
	justSaved: boolean;
	showRemove: boolean;
	isSaved: boolean;
}): string {
	if (opts.justSaved) return "Saved to memory!";
	if (opts.showRemove) return "Remove from memory";
	if (opts.isSaved) return "Saved to memory";
	return "Save to memory";
}

/**
 * isSaved = savedAsMemory && !justSaved
 * showRemove = isSaved && hoveringMemoryBtn && !!onremovememory
 */
function computeMemoryState(opts: {
	savedAsMemory: boolean;
	justSaved: boolean;
	hoveringMemoryBtn: boolean;
	hasRemoveHandler: boolean;
}): { isSaved: boolean; showRemove: boolean } {
	const isSaved = opts.savedAsMemory && !opts.justSaved;
	const showRemove = isSaved && opts.hoveringMemoryBtn && opts.hasRemoveHandler;
	return { isSaved, showRemove };
}

// ── canEdit ──────────────────────────────────────────────────────────

describe("canEdit", () => {
	test("user with handler can edit", () => {
		expect(canEdit("user", true)).toBe(true);
	});

	test("user without handler cannot edit", () => {
		expect(canEdit("user", false)).toBe(false);
	});

	test("assistant cannot edit even with handler", () => {
		expect(canEdit("assistant", true)).toBe(false);
	});

	test("assistant without handler cannot edit", () => {
		expect(canEdit("assistant", false)).toBe(false);
	});
});

// ── canRegenerate ────────────────────────────────────────────────────

describe("canRegenerate", () => {
	test("assistant with handler can regenerate", () => {
		expect(canRegenerate("assistant", true)).toBe(true);
	});

	test("assistant without handler cannot regenerate", () => {
		expect(canRegenerate("assistant", false)).toBe(false);
	});

	test("user cannot regenerate even with handler", () => {
		expect(canRegenerate("user", true)).toBe(false);
	});

	test("user without handler cannot regenerate", () => {
		expect(canRegenerate("user", false)).toBe(false);
	});
});

// ── showRetryOnly ────────────────────────────────────────────────────

describe("showRetryOnly", () => {
	test("shows retry when isError and onretry provided", () => {
		expect(showRetryOnly(true, true)).toBe(true);
	});

	test("does not show retry when not error", () => {
		expect(showRetryOnly(false, true)).toBe(false);
	});

	test("does not show retry when no handler even if error", () => {
		expect(showRetryOnly(true, false)).toBe(false);
	});

	test("does not show retry when neither error nor handler", () => {
		expect(showRetryOnly(false, false)).toBe(false);
	});
});

// ── hasSaveMemory ────────────────────────────────────────────────────

describe("hasSaveMemory", () => {
	test("save memory button present when handler provided", () => {
		expect(hasSaveMemory(true)).toBe(true);
	});

	test("save memory button absent when no handler", () => {
		expect(hasSaveMemory(false)).toBe(false);
	});
});

// ── memoryButtonLabel ────────────────────────────────────────────────

describe("memoryButtonLabel", () => {
	test("justSaved wins over everything", () => {
		expect(memoryButtonLabel({ justSaved: true, showRemove: true, isSaved: true })).toBe("Saved to memory!");
	});

	test("showRemove shown when not justSaved", () => {
		expect(memoryButtonLabel({ justSaved: false, showRemove: true, isSaved: true })).toBe("Remove from memory");
	});

	test("isSaved shown when not justSaved and not showRemove", () => {
		expect(memoryButtonLabel({ justSaved: false, showRemove: false, isSaved: true })).toBe("Saved to memory");
	});

	test("default label when none of the flags are set", () => {
		expect(memoryButtonLabel({ justSaved: false, showRemove: false, isSaved: false })).toBe("Save to memory");
	});
});

// ── computeMemoryState ───────────────────────────────────────────────

describe("computeMemoryState", () => {
	test("isSaved true when savedAsMemory true and not justSaved", () => {
		const { isSaved } = computeMemoryState({
			savedAsMemory: true,
			justSaved: false,
			hoveringMemoryBtn: false,
			hasRemoveHandler: true,
		});
		expect(isSaved).toBe(true);
	});

	test("isSaved false when justSaved is true (flash state)", () => {
		const { isSaved } = computeMemoryState({
			savedAsMemory: true,
			justSaved: true,
			hoveringMemoryBtn: false,
			hasRemoveHandler: true,
		});
		expect(isSaved).toBe(false);
	});

	test("showRemove true when isSaved + hovering + has handler", () => {
		const { showRemove } = computeMemoryState({
			savedAsMemory: true,
			justSaved: false,
			hoveringMemoryBtn: true,
			hasRemoveHandler: true,
		});
		expect(showRemove).toBe(true);
	});

	test("showRemove false when not hovering", () => {
		const { showRemove } = computeMemoryState({
			savedAsMemory: true,
			justSaved: false,
			hoveringMemoryBtn: false,
			hasRemoveHandler: true,
		});
		expect(showRemove).toBe(false);
	});

	test("showRemove false when no remove handler", () => {
		const { showRemove } = computeMemoryState({
			savedAsMemory: true,
			justSaved: false,
			hoveringMemoryBtn: true,
			hasRemoveHandler: false,
		});
		expect(showRemove).toBe(false);
	});

	test("showRemove false when not saved", () => {
		const { showRemove } = computeMemoryState({
			savedAsMemory: false,
			justSaved: false,
			hoveringMemoryBtn: true,
			hasRemoveHandler: true,
		});
		expect(showRemove).toBe(false);
	});
});
