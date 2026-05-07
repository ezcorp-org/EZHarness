/**
 * DOM tests for the `ez-action-result` branch in ChatMessage.svelte
 * (renders an EzActionCard inline when the row's role is the
 * synthetic ez-action-result kind persisted by the dispatcher endpoint
 * and the submit-time path).
 *
 * Coverage targets:
 *   - Valid JSON content → EzActionCard mounts with the parsed result
 *     (we verify the card renders by selecting the data-testid the
 *     real EzActionCard exposes — `ez-action-card`).
 *   - Malformed JSON → silent fallback ("EZ action result unreadable.")
 *     instead of a blank row or a thrown error.
 *
 * Pre-fix: this branch was only exercised by the Playwright E2E spec.
 * A jsdom-level test pins the parse + render contract so a future
 * refactor of `parseEzActionResult` (lenient shape match) can't
 * silently break the renderer.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ChatMessage from "../ChatMessage.svelte";
import type { Message } from "$lib/api.js";

beforeEach(() => {
	// MarkdownRenderer + sub-components fire fetches on mount; stub.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		),
	);
});

function makeEzMessage(content: string): Message {
	return {
		id: "msg-ez-1",
		conversationId: "conv-1",
		role: "ez-action-result",
		content,
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: "parent-msg-id",
		excluded: false,
		createdAt: "2026-05-06T00:00:00.000Z",
	};
}

describe("ChatMessage — ez-action-result rendering", () => {
	test("valid JSON content → EzActionCard renders with the parsed result", () => {
		const payload = {
			kind: "success" as const,
			card: {
				title: "Lesson captured",
				body: "always-quote-paths",
				variant: "success" as const,
			},
			ref: { kind: "lesson" as const, slug: "always-quote-paths" },
		};
		const { getByTestId } = render(ChatMessage, {
			message: makeEzMessage(JSON.stringify(payload)),
		});

		const card = getByTestId("ez-action-card");
		expect(card).toBeTruthy();
		// Pin the parsed values made it through `parseEzActionResult`
		// + `EzActionCard` to the rendered DOM. The card's
		// `data-variant` mirrors the result's variant; aria-label
		// mirrors the title.
		expect(card.getAttribute("data-variant")).toBe("success");
		expect(card.getAttribute("aria-label")).toBe("Lesson captured");
	});

	test("malformed JSON content → fallback pill ('EZ action result unreadable.'), no thrown error", () => {
		// `parseEzActionResult` swallows JSON.parse errors and returns
		// null. ChatMessage's template branches on the null and
		// renders a minimal italic notice instead of a blank row.
		const { container, queryByTestId } = render(ChatMessage, {
			message: makeEzMessage("{not-valid-json"),
		});

		// EzActionCard MUST NOT mount.
		expect(queryByTestId("ez-action-card")).toBeNull();
		// Fallback notice is present.
		expect(container.textContent).toContain("EZ action result unreadable");
	});

	test("JSON with missing card.variant → fallback pill (lenient parse rejects malformed shapes)", () => {
		// `parseEzActionResult` requires card.title + card.body +
		// card.variant. A missing/unknown variant fails the shape
		// match, so the row falls back to the unreadable notice.
		const halfShaped = JSON.stringify({
			kind: "success",
			card: { title: "x", body: "y" }, // no variant
		});
		const { container, queryByTestId } = render(ChatMessage, {
			message: makeEzMessage(halfShaped),
		});
		expect(queryByTestId("ez-action-card")).toBeNull();
		expect(container.textContent).toContain("EZ action result unreadable");
	});
});
