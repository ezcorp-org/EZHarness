/**
 * Parity check between `MessageToolbar.svelte` and its two call sites.
 *
 * Background: `MessageToolbar` is rendered in two surfaces — the per-row
 * hover toolbar (`ChatMessage.svelte`) and the shift+click bulk action
 * bar (`SelectModeActionBar.svelte`). Twice now a callback prop has been
 * added to the toolbar and only wired in one surface, leaving bulk users
 * without the new button. This test reads the source of all three files
 * plus the central registry (`message-toolbar-registry.ts`) and asserts:
 *
 *   1. Every `on*` prop declared in `MessageToolbar.svelte`'s props type
 *      has a matching entry in the registry (no orphans).
 *   2. Every registry entry exists as a prop in `MessageToolbar.svelte`
 *      (no stale entries).
 *   3. Every prop is referenced in `ChatMessage.svelte` — the hover
 *      surface MUST wire all of them.
 *   4. Every prop with `bulkSupported: true` is referenced in
 *      `SelectModeActionBar.svelte`. Bulk-skipped props (`bulkSupported:
 *      false`) MUST NOT appear there — guards against accidental wiring
 *      without a registry update.
 *
 * The test is plain string-grep on the source files. It runs under
 * vitest (`*.unit.test.ts`) without the Svelte compiler — cheap, fast,
 * and catches the regression at the point of edit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MESSAGE_TOOLBAR_PROPS } from "./message-toolbar-registry.js";

const COMPONENTS_DIR = resolve(__dirname);

function read(path: string): string {
	return readFileSync(path, "utf8");
}

/** Pull every `onFoo` identifier out of the props type block of
 *  `MessageToolbar.svelte`. The block is bounded by `}: {` and
 *  `} = $props();` — match `on\w+?:` lines inside it. */
function extractToolbarProps(source: string): string[] {
	const start = source.indexOf("}: {");
	const end = source.indexOf("} = $props();", start);
	if (start < 0 || end < 0) {
		throw new Error(
			"Could not locate the props type block in MessageToolbar.svelte — the bounding tokens '}: {' and '} = $props();' were not both found",
		);
	}
	const block = source.slice(start, end);
	const matches = block.matchAll(/\b(on[A-Za-z]+)\?:/g);
	return [...new Set([...matches].map((m) => m[1]!))];
}

describe("MessageToolbar parity", () => {
	const toolbarSrc = read(
		resolve(COMPONENTS_DIR, "MessageToolbar.svelte"),
	);
	const chatMessageSrc = read(
		resolve(COMPONENTS_DIR, "ChatMessage.svelte"),
	);
	const selectBarSrc = read(
		resolve(COMPONENTS_DIR, "chat/SelectModeActionBar.svelte"),
	);

	const declaredProps = extractToolbarProps(toolbarSrc);
	const registryProps = MESSAGE_TOOLBAR_PROPS.map((p) => p.prop);

	it("registry covers every prop declared on MessageToolbar.svelte (no orphans)", () => {
		const orphans = declaredProps.filter(
			(p) => !registryProps.includes(p),
		);
		expect(
			orphans,
			`MessageToolbar.svelte declares ${orphans.join(", ")} but message-toolbar-registry.ts has no entry. Add one — see the file header for guidance.`,
		).toEqual([]);
	});

	it("registry has no stale entries (every entry exists on MessageToolbar.svelte)", () => {
		const stale = registryProps.filter(
			(p) => !declaredProps.includes(p),
		);
		expect(
			stale,
			`message-toolbar-registry.ts has entries for ${stale.join(", ")} but MessageToolbar.svelte no longer declares them.`,
		).toEqual([]);
	});

	it("ChatMessage.svelte wires every button-gating toolbar prop", () => {
		// Observer-only props (e.g. `oncopy`, which fires AFTER the
		// toolbar's own clipboard write) are optional — surfaces can
		// omit them. Only button-gating props are required.
		const required = MESSAGE_TOOLBAR_PROPS.filter(
			(p) => !p.observerOnly,
		).map((p) => p.prop);
		const missing = required.filter(
			(prop) => !chatMessageSrc.includes(`${prop}=`),
		);
		expect(
			missing,
			`ChatMessage.svelte is missing toolbar wiring for: ${missing.join(", ")}. The hover toolbar surfaces every button-gating prop — add the attribute on the <MessageToolbar /> invocation.`,
		).toEqual([]);
	});

	it("SelectModeActionBar.svelte wires every bulkSupported prop, and nothing more", () => {
		const bulkSupported = MESSAGE_TOOLBAR_PROPS.filter(
			(p) => p.bulkSupported,
		).map((p) => p.prop);
		const bulkSkipped = MESSAGE_TOOLBAR_PROPS.filter(
			(p) => !p.bulkSupported,
		).map((p) => p.prop);

		const missing = bulkSupported.filter(
			(prop) => !selectBarSrc.includes(`${prop}=`),
		);
		expect(
			missing,
			`SelectModeActionBar.svelte is missing wiring for bulk-supported props: ${missing.join(", ")}. Either wire it through or flip the registry entry's bulkSupported to false with a bulkSkipReason.`,
		).toEqual([]);

		const leaked = bulkSkipped.filter((prop) =>
			selectBarSrc.includes(`${prop}=`),
		);
		expect(
			leaked,
			`SelectModeActionBar.svelte forwards ${leaked.join(", ")} but the registry marks them bulkSupported=false. Update the registry (set bulkSupported=true) or remove the wiring.`,
		).toEqual([]);
	});

	it("the chat surface wires the bulk Re-run handler so onrerun is not dead-wired", () => {
		// Smoke check that the chat surface actually passes something to
		// onrerun on <SelectModeActionBar>; without it the bulk Re-run
		// button would render but no-op.
		//
		// Post-Phase-3 the main chat page is a thin shell that delegates
		// the entire feed + select-mode bar to <ChatThread> — so
		// <SelectModeActionBar> (and its onrerun wiring) moved OUT of
		// `+page.svelte` and INTO `ChatThread.svelte`. The contract is
		// unchanged (bulk Re-run still wired); only its host file moved.
		// This assertion follows the component to its real home rather
		// than asserting a location the refactor legitimately vacated.
		const chatThreadSrc = read(
			resolve(COMPONENTS_DIR, "ChatThread.svelte"),
		);
		expect(
			/<SelectModeActionBar[\s\S]*?onrerun=/.test(chatThreadSrc),
			"ChatThread.svelte does not pass `onrerun` to <SelectModeActionBar />. The bulk Re-run button will render with no handler.",
		).toBe(true);
	});
});
