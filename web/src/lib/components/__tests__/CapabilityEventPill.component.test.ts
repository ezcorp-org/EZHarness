/**
 * Phase 52.5 — DOM tests for CapabilityEventPill.svelte.
 *
 * Coverage targets (per spec §52.5.1):
 *   - LLM call: "[name] called <model> · $cost"
 *   - Memory read: "[name] read <resourceType> <resourceId>"
 *   - Schedule register: "[name] scheduled <resource>"
 *   - Denial: "[name] denied: <action>" + 🚫 icon
 *   - Malformed JSON content → unreadable fallback (not blank, not throw)
 *   - extensionName from prop overrides the payload's name
 */
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";
import CapabilityEventPill from "../CapabilityEventPill.svelte";

beforeEach(() => {
	// Defensive — the pill only fetches on expand-detail click.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })),
	);
});

function makeMessage(payload: Record<string, unknown>) {
	return {
		id: "msg-cap-1",
		role: "capability-event",
		content: JSON.stringify(payload),
	};
}

describe("CapabilityEventPill — variant rendering", () => {
	test("LLM call success", () => {
		const { getByTestId, getByText } = render(CapabilityEventPill, {
			message: makeMessage({
				__ezcorp_capability_event: true,
				sdkCapabilityCallId: "call-1",
				capability: "llm",
				action: "complete",
				success: true,
				model: "gpt-4o-mini",
				costUsd: 0.003,
				durationMs: 1200,
				extensionName: "lessons-keeper",
			}),
		});
		const pill = getByTestId("capability-pill");
		expect(pill.getAttribute("data-capability")).toBe("llm");
		expect(pill.getAttribute("data-success")).toBe("true");
		expect(getByText("lessons-keeper")).toBeTruthy();
		expect(getByText("called")).toBeTruthy();
		expect(getByText(/gpt-4o-mini/)).toBeTruthy();
		expect(getByText(/\$0\.003/)).toBeTruthy();
	});

	test("Memory read", () => {
		const { getByText, getByTestId } = render(CapabilityEventPill, {
			message: makeMessage({
				__ezcorp_capability_event: true,
				sdkCapabilityCallId: "call-2",
				capability: "memory",
				action: "read",
				resourceType: "lesson",
				resourceId: "lesson-abc-123",
				success: true,
				durationMs: 5,
				extensionName: "memory-extractor",
			}),
		});
		expect(getByTestId("capability-pill").getAttribute("data-capability")).toBe("memory");
		expect(getByText("memory-extractor")).toBeTruthy();
		expect(getByText("read")).toBeTruthy();
		// Truncated id (8 chars) — "lesson-a"
		expect(getByText(/lesson · lesson-a/)).toBeTruthy();
	});

	test("Schedule register", () => {
		const { getByText, getByTestId } = render(CapabilityEventPill, {
			message: makeMessage({
				__ezcorp_capability_event: true,
				sdkCapabilityCallId: "call-3",
				capability: "schedule",
				action: "register",
				resourceType: "cron 0 */6 * * *",
				success: true,
				durationMs: 1,
				extensionName: "scheduler-ext",
			}),
		});
		expect(getByTestId("capability-pill").getAttribute("data-capability")).toBe("schedule");
		expect(getByText("scheduled")).toBeTruthy();
		expect(getByText(/cron 0 \*\/6 \* \* \*/)).toBeTruthy();
	});

	test("Denial", () => {
		const { getByText, getByTestId } = render(CapabilityEventPill, {
			message: makeMessage({
				__ezcorp_capability_event: true,
				sdkCapabilityCallId: "call-4",
				capability: "llm",
				action: "complete",
				success: false,
				durationMs: 2,
				extensionName: "rate-limited-ext",
			}),
		});
		expect(getByTestId("capability-pill").getAttribute("data-success")).toBe("false");
		expect(getByText(/denied: complete/)).toBeTruthy();
	});

	test("Malformed JSON → unreadable fallback", () => {
		const { getByTestId } = render(CapabilityEventPill, {
			message: { id: "x", role: "capability-event", content: "{not valid" },
		});
		expect(getByTestId("capability-pill-unreadable")).toBeTruthy();
	});

	test("Missing __ezcorp_capability_event sentinel → unreadable fallback", () => {
		const { getByTestId } = render(CapabilityEventPill, {
			message: { id: "x", role: "capability-event", content: JSON.stringify({ wrong: "shape" }) },
		});
		expect(getByTestId("capability-pill-unreadable")).toBeTruthy();
	});

	test("extensionName prop overrides the payload-embedded name", () => {
		const { getByText } = render(CapabilityEventPill, {
			message: makeMessage({
				__ezcorp_capability_event: true,
				sdkCapabilityCallId: "call-5",
				capability: "llm",
				action: "complete",
				success: true,
				extensionName: "from-payload",
			}),
			extensionName: "from-prop",
		});
		expect(getByText("from-prop")).toBeTruthy();
	});

	test("clicking pill expands detail row + fetches the linked sdk row", async () => {
		const { getByTestId, queryByTestId } = render(CapabilityEventPill, {
			message: makeMessage({
				__ezcorp_capability_event: true,
				sdkCapabilityCallId: "call-fetch-1",
				capability: "llm",
				action: "complete",
				success: true,
				durationMs: 5,
				extensionName: "lessons-keeper",
			}),
		});
		expect(queryByTestId("capability-pill-detail")).toBeNull();
		await fireEvent.click(getByTestId("capability-pill").querySelector("button")!);
		expect(getByTestId("capability-pill-detail")).toBeTruthy();
		expect(globalThis.fetch).toHaveBeenCalledWith(
			expect.stringContaining("call-fetch-1"),
		);
	});
});
