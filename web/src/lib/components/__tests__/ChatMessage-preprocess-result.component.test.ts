/**
 * DOM tests for the `preprocess-result` branch in ChatMessage.svelte
 * (deterministic extension pre-processing).
 *
 * Coverage targets:
 *   - ok:true row with cardType grade-delta-chart → GradeDeltaCard
 *     mounts through the tool-card router.
 *   - ok:true row WITHOUT cardType → DefaultCard fallback.
 *   - ok:false row → DefaultCard in its error state (red X + status).
 *   - Malformed JSON → "Preprocess result unreadable." fallback pill
 *     (never a blank turn, never a throw) — same defensive shape as the
 *     ez-action-result branch.
 */
import { render, cleanup } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ChatMessage from "../ChatMessage.svelte";
import type { Message } from "$lib/api.js";

beforeEach(() => {
	// MarkdownRenderer + sub-components fire fetches on mount; stub.
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
});

afterEach(() => cleanup());

function makePreprocessMessage(content: string): Message {
	return {
		id: "msg-pp-1",
		conversationId: "conv-1",
		role: "preprocess-result",
		content,
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: "user-msg-id",
		excluded: false,
		createdAt: "2026-07-09T00:00:00.000Z",
	};
}

const GRADE_PAYLOAD = JSON.stringify({
	extensionName: "graded-card-scanner",
	toolName: "identify_slab",
	cardType: "grade-delta-chart",
	ok: true,
	output: JSON.stringify({
		cert: "49392223",
		grader: "PSA",
		identity: {
			subject: "Charizard",
			year: "1999",
			set: "Pokemon Base Set",
			cardNo: "4",
			variety: "",
			grade: "PSA 9",
		},
		grades: { PSA: { "9": 2587.5, "10": 30100 } },
		deltas: [
			{
				company: "PSA",
				steps: [{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 }],
			},
		],
		sources: {},
	}),
});

describe("ChatMessage — preprocess-result rendering", () => {
	test("ok row with grade-delta-chart cardType routes to GradeDeltaCard", () => {
		const { getByTestId } = render(ChatMessage, {
			message: makePreprocessMessage(GRADE_PAYLOAD),
		});
		const row = getByTestId("preprocess-result-row");
		expect(row.getAttribute("data-preprocess-status")).toBe("complete");
		// The routed card rendered with the payload's data.
		expect(getByTestId("grade-delta-card")).toBeTruthy();
		expect(getByTestId("grade-delta-grader").textContent).toContain("PSA");
		expect(getByTestId("grade-delta-cert").textContent).toContain("49392223");
	});

	test("ok row WITHOUT cardType falls back to DefaultCard", () => {
		const payload = JSON.stringify({
			extensionName: "some-ext",
			toolName: "summarize_doc",
			ok: true,
			output: "a plain text summary",
		});
		const { getByTestId, queryByTestId } = render(ChatMessage, {
			message: makePreprocessMessage(payload),
		});
		expect(queryByTestId("grade-delta-card")).toBeNull();
		const card = getByTestId("tool-card-default");
		expect(card.textContent).toContain("some-ext__summarize_doc");
	});

	test("ok:false row renders DefaultCard's ERROR state (no chart card)", () => {
		const payload = JSON.stringify({
			extensionName: "graded-card-scanner",
			toolName: "identify_slab",
			cardType: "grade-delta-chart",
			ok: false,
			output: "decode failed: no barcode found",
		});
		const { getByTestId, queryByTestId } = render(ChatMessage, {
			message: makePreprocessMessage(payload),
		});
		const row = getByTestId("preprocess-result-row");
		expect(row.getAttribute("data-preprocess-status")).toBe("error");
		// cardType is deliberately dropped on failures — DefaultCard owns
		// the honest error rendering.
		expect(queryByTestId("grade-delta-card")).toBeNull();
		expect(queryByTestId("grade-delta-missing")).toBeNull();
		expect(getByTestId("tool-card-default")).toBeTruthy();
	});

	test("malformed JSON → fallback pill, no thrown error", () => {
		const { container, queryByTestId } = render(ChatMessage, {
			message: makePreprocessMessage("{not-valid-json"),
		});
		expect(queryByTestId("preprocess-result-row")).toBeNull();
		expect(container.textContent).toContain("Preprocess result unreadable");
	});

	test("shape-violating JSON (missing ok flag) also falls back", () => {
		const payload = JSON.stringify({
			extensionName: "x",
			toolName: "y",
			output: "z",
		});
		const { container, queryByTestId } = render(ChatMessage, {
			message: makePreprocessMessage(payload),
		});
		expect(queryByTestId("preprocess-result-row")).toBeNull();
		expect(container.textContent).toContain("Preprocess result unreadable");
	});
});
