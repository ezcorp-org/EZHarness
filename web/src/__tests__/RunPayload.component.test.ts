/**
 * The one renderer for a workflow run's payloads — a run's final output, a
 * step's output, a step's resolved input.
 *
 * `payloadView`'s four states are unit-tested next to the function. What
 * these assert is the half only the DOM can show: that each state gets a
 * VISUALLY distinct treatment, because the whole surface is built on not
 * letting "we did not store this" read like "the run produced nothing" and
 * not letting a truncation marker read like content.
 */
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import { describe, test, expect } from "vitest";
import RunPayload from "$lib/components/workflows/RunPayload.svelte";

const props = (value: unknown) => ({ props: { label: "Output", value, testId: "out" } });

describe("RunPayload — the four payload states", () => {
	test("an absent payload says so, and renders no code block", () => {
		const { getByTestId } = render(RunPayload, props(null));
		const el = getByTestId("out");
		expect(el).toHaveTextContent("not recorded");
		expect(el.tagName).not.toBe("PRE");
	});

	test("the truncation sentinel renders as a NOTICE, never as content", () => {
		// The stored value is a marker, not the payload. Rendering it in the
		// same block as real content would let a reader take
		// `{"__truncated":true}` for the run's answer.
		const { getByTestId } = render(RunPayload, props({ __truncated: true, bytes: 70011 }));
		const el = getByTestId("out");
		expect(el).toHaveTextContent("Too large to store");
		// Thousands-separated, so the size is readable at a glance.
		expect(el).toHaveTextContent("70,011 bytes");
		expect(el.tagName).not.toBe("PRE");
	});

	test("prose renders verbatim in a wrapping block", () => {
		const { getByTestId } = render(RunPayload, props("Shipped v2.\n\nHighlights:\n- faster"));
		const el = getByTestId("out");
		expect(el.tagName).toBe("PRE");
		expect(el.textContent).toContain("Highlights:");
		// Prose must WRAP — an agent's answer is not pre-formatted, and a
		// non-wrapping block turns a paragraph into one horizontal scroll.
		expect(el.className).toContain("whitespace-pre-wrap");
	});

	test("JSON renders in a block that does NOT wrap", () => {
		// Its indentation is the structure; re-flowing it destroys the
		// alignment a reader scans down.
		const { getByTestId } = render(RunPayload, props({ id: "d-1", ok: true }));
		const el = getByTestId("out");
		expect(el.tagName).toBe("PRE");
		expect(el.textContent).toContain('"id": "d-1"');
		expect(el.className).not.toContain("whitespace-pre-wrap");
	});

	test("the block is BORDERED and height-capped, not merely tinted", () => {
		// Two decisions the component's own comment calls load-bearing, and
		// neither shows up in the four-state split above.
		//
		// The tint alone is not a boundary: the run trace's Result card is
		// `bg-[var(--color-surface)]` too, so a payload rendered on the same
		// tint inside it reads as loose text rather than as a block. The
		// border is what survives that.
		//
		// The cap is what keeps ONE payload from being the whole page — a
		// workflow's output can be a document, and an uncapped block pushes
		// the run history, the graph and the step table below the fold.
		const { getByTestId } = render(RunPayload, props("x".repeat(4000)));
		const el = getByTestId("out");
		expect(el.className).toContain("border");
		expect(el.className).toContain("max-h-64");
		expect(el.className).toContain("overflow-auto");
	});

	test("an EMPTY string is called empty, not 'not recorded'", () => {
		// The distinction the whole surface exists to keep: a payload the
		// executor never stored and one that really is the empty string are
		// different facts about the run.
		const { getByTestId } = render(RunPayload, props(""));
		const el = getByTestId("out");
		expect(el).toHaveTextContent("empty");
		expect(el).not.toHaveTextContent("not recorded");
	});
});

describe("RunPayload — labelling", () => {
	test("shows the caller's label, and scopes the test id to the CONTENT", () => {
		// The id is on the payload rather than the wrapper so an assertion
		// reads the value and not the heading sitting above it.
		const { getByTestId, getByText } = render(RunPayload, {
			props: { label: "Resolved input", value: { topic: "release notes" }, testId: "in" },
		});
		expect(getByText("Resolved input")).toBeInTheDocument();
		expect(getByTestId("in").textContent).not.toContain("Resolved input");
		expect(getByTestId("in-pane")).toContainElement(getByTestId("in"));
	});
});
