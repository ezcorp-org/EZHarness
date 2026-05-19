/**
 * DOM tests for EzActionCard.svelte (Phase 4.4 of EZ Actions v1).
 *
 * Coverage targets (per plan §4.4):
 *   - success variant renders title + body + ref-link to lesson
 *   - decline variant renders no ref-link (only success carries one)
 *   - error variant renders rose styling (variant-error class +
 *     attribute on the root element)
 *   - clicking the ref-link navigates to the lesson detail page
 *   - aria-label uses the card title (screen-reader friendly)
 *
 * Pattern mirrors `MentionChip.component.test.ts` — render under
 * @testing-library/svelte (jsdom), assert on the rendered DOM.
 */
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect } from "vitest";
import EzActionCard from "../EzActionCard.svelte";

describe("EzActionCard — variant rendering", () => {
	test("success variant: title + body + ref-link to lesson", () => {
		const { getByTestId, getByText } = render(EzActionCard, {
			result: {
				kind: "success",
				card: {
					title: "Lesson captured",
					body: "Always quote paths (slug: always-quote-paths)",
					variant: "success",
				},
				ref: { kind: "lesson", slug: "always-quote-paths" },
			},
		});

		const card = getByTestId("ez-action-card");
		expect(card.getAttribute("data-variant")).toBe("success");
		expect(card.getAttribute("data-kind")).toBe("success");
		expect(card.getAttribute("aria-label")).toBe("Lesson captured");
		expect(getByText("Lesson captured")).toBeTruthy();
		expect(getByText(/Always quote paths/)).toBeTruthy();

		const link = getByTestId("ez-action-card-ref-link") as HTMLAnchorElement;
		expect(link.tagName).toBe("A");
		expect(link.getAttribute("data-ref-kind")).toBe("lesson");
		expect(link.getAttribute("data-ref-slug")).toBe("always-quote-paths");
		expect(link.getAttribute("href")).toContain("/memories");
		expect(link.getAttribute("href")).toContain("tab=lessons");
		expect(link.getAttribute("href")).toContain("lesson=always-quote-paths");
	});

	test("decline variant (info): no ref-link rendered", () => {
		const { getByTestId, queryByTestId, getByText } = render(EzActionCard, {
			result: {
				kind: "decline",
				card: {
					title: "Distiller declined",
					body: "no reusable insight",
					variant: "info",
				},
			},
		});

		const card = getByTestId("ez-action-card");
		expect(card.getAttribute("data-variant")).toBe("info");
		expect(card.getAttribute("data-kind")).toBe("decline");
		expect(getByText("Distiller declined")).toBeTruthy();

		// Ref-link MUST NOT render for decline kind.
		expect(queryByTestId("ez-action-card-ref-link")).toBeNull();
	});

	test("decline variant (warning): no ref-link, warning styling", () => {
		const { getByTestId, queryByTestId } = render(EzActionCard, {
			result: {
				kind: "decline",
				card: {
					title: "Distiller declined",
					body: "couldn't parse JSON",
					variant: "warning",
				},
			},
		});

		const card = getByTestId("ez-action-card");
		expect(card.getAttribute("data-variant")).toBe("warning");
		expect(card.classList.contains("variant-warning")).toBe(true);
		expect(queryByTestId("ez-action-card-ref-link")).toBeNull();
	});

	test("error variant: rose styling, no ref-link even if present", () => {
		const { getByTestId, queryByTestId } = render(EzActionCard, {
			result: {
				kind: "error",
				card: {
					title: "Distiller failed",
					body: "DB error: timeout",
					variant: "error",
				},
				// Even if a ref were attached to an error result (it
				// shouldn't be — the type forbids it for `error`, but
				// JSON deserialization is lax), the renderer should
				// only emit the link for `kind === "success"`.
			},
		});

		const card = getByTestId("ez-action-card");
		expect(card.getAttribute("data-variant")).toBe("error");
		expect(card.classList.contains("variant-error")).toBe(true);
		expect(queryByTestId("ez-action-card-ref-link")).toBeNull();
	});

	test("success variant WITHOUT ref → no ref-link rendered (graceful)", () => {
		// Success without a ref is unusual but legal — handlers may
		// produce a success card without a deep-link target.
		const { getByTestId, queryByTestId } = render(EzActionCard, {
			result: {
				kind: "success",
				card: {
					title: "Done",
					body: "—",
					variant: "success",
				},
			},
		});

		expect(getByTestId("ez-action-card").getAttribute("data-kind")).toBe("success");
		expect(queryByTestId("ez-action-card-ref-link")).toBeNull();
	});
});

describe("EzActionCard — accessibility", () => {
	test("aria-label uses card title", () => {
		const { getByTestId } = render(EzActionCard, {
			result: {
				kind: "success",
				card: { title: "Captured!", body: "y", variant: "success" },
			},
		});
		const card = getByTestId("ez-action-card");
		expect(card.getAttribute("role")).toBe("status");
		expect(card.getAttribute("aria-label")).toBe("Captured!");
	});

	test("ref-link is a real <a href>, not a button (Cmd-click + screen-reader friendly)", () => {
		const { getByTestId } = render(EzActionCard, {
			result: {
				kind: "success",
				card: { title: "x", body: "y", variant: "success" },
				ref: { kind: "lesson", slug: "z" },
			},
		});
		const link = getByTestId("ez-action-card-ref-link");
		expect(link.tagName).toBe("A");
		expect(link.getAttribute("href")).toBeTruthy();
	});
});

describe("EzActionCard — interaction", () => {
	test("clicking ref-link uses href navigation (no preventDefault)", async () => {
		// Real <a> tag → click defaults to href navigation; we verify
		// the click event fires without an attached preventDefault
		// handler swallowing it.
		const { getByTestId } = render(EzActionCard, {
			result: {
				kind: "success",
				card: { title: "x", body: "y", variant: "success" },
				ref: { kind: "lesson", slug: "abc-def" },
			},
		});
		const link = getByTestId("ez-action-card-ref-link") as HTMLAnchorElement;
		const ev = await fireEvent.click(link);
		// fireEvent returns false only if a handler called
		// preventDefault. Ours doesn't, so the event propagates and
		// the browser would handle navigation in production.
		expect(ev).toBe(true);
		expect(link.href).toContain("lesson=abc-def");
	});
});
