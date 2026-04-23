import { test, expect, describe } from "bun:test";
import { shouldAutofocusComposer } from "../lib/chat-input-logic";

describe("shouldAutofocusComposer", () => {
	test("false while conversation is still loading", () => {
		expect(
			shouldAutofocusComposer({ loaded: false, messageCount: 0, disabled: false }),
		).toBe(false);
	});

	test("false when conversation has any messages", () => {
		expect(
			shouldAutofocusComposer({ loaded: true, messageCount: 1, disabled: false }),
		).toBe(false);
	});

	test("false when input is disabled (e.g. streaming/disconnected)", () => {
		expect(
			shouldAutofocusComposer({ loaded: true, messageCount: 0, disabled: true }),
		).toBe(false);
	});

	test("true when loaded, empty, and enabled", () => {
		expect(
			shouldAutofocusComposer({ loaded: true, messageCount: 0, disabled: false }),
		).toBe(true);
	});

	test("boundary: messageCount: 1 → false even if loaded + enabled", () => {
		expect(
			shouldAutofocusComposer({ loaded: true, messageCount: 1, disabled: false }),
		).toBe(false);
	});

	test("boundary: large messageCount → false", () => {
		expect(
			shouldAutofocusComposer({ loaded: true, messageCount: 999, disabled: false }),
		).toBe(false);
	});

	test("not loaded + has messages + disabled → false (all gates closed)", () => {
		expect(
			shouldAutofocusComposer({ loaded: false, messageCount: 5, disabled: true }),
		).toBe(false);
	});
});
