/**
 * Phase 49.4 — AgentConfigForm + ExtensionAttachPicker wiring test.
 *
 * Renders `AgentConfigForm` and verifies the visual modal picker is
 * triggerable via the new "Browse extensions" button. The picker
 * itself is exercised in `extension-attach-picker.component.test.ts`;
 * here we only need to confirm the wiring contract:
 *   - Button exists and opens the modal.
 *   - Selecting + submitting in the modal updates the form's
 *     `extensions` array (asserted indirectly: the inline picker's
 *     pill list reflects the new ids).
 *   - Initial extensions on the form pre-populate the modal when
 *     reopened.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/api", () => ({
	CURRENT_MODEL_SENTINEL: "current",
}));

// The inline ExtensionSearchPicker also calls /api/extensions on
// mount — both pickers share the same endpoint. A single fetch mock
// services both consumers.
const installedExtensions = [
	{ id: "ext-1", name: "summarizer", description: "summarize text", manifest: { tools: [{ name: "summarize" }] } },
	{ id: "ext-2", name: "translator", description: "translate prose", manifest: { tools: [{ name: "translate" }] } },
];

beforeEach(() => {
	vi.restoreAllMocks();
	const fetchMock = vi.fn(async (url: string) => {
		if (url === "/api/extensions") {
			return new Response(JSON.stringify({ extensions: installedExtensions }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		// Other endpoints (model picker, etc.) — return empty so the form
		// renders without errors. ModelSearchPicker hits /api/models.
		return new Response(JSON.stringify({}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	(globalThis as { fetch: typeof fetch }).fetch =
		fetchMock as unknown as typeof fetch;
});

import AgentConfigForm from "$lib/components/AgentConfigForm.svelte";

describe("AgentConfigForm — Phase 49.4 attach picker wiring", () => {
	test("'Browse extensions' button opens the visual picker modal", async () => {
		const { findByTestId, queryByTestId } = render(AgentConfigForm, {
			initial: {},
			onsubmit: vi.fn(),
		});
		// Modal not open initially.
		expect(queryByTestId("extension-attach-picker")).toBeNull();
		const trigger = await findByTestId("open-extension-attach-picker");
		await fireEvent.click(trigger);
		expect(await findByTestId("extension-attach-picker")).toBeInTheDocument();
	});

	test("selecting + submitting in the picker updates the form's extensions", async () => {
		const onsubmit = vi.fn();
		const { findByTestId, findAllByTestId } = render(AgentConfigForm, {
			initial: { name: "x", prompt: "y", extensions: [] },
			onsubmit,
		});
		await fireEvent.click(await findByTestId("open-extension-attach-picker"));
		// Wait for the picker's /api/extensions fetch to resolve and
		// cards to render.
		const cards = await findAllByTestId("extension-attach-picker-card");
		await fireEvent.click(cards[0]!); // ext-1
		await fireEvent.click(cards[1]!); // ext-2
		await fireEvent.click(await findByTestId("extension-attach-picker-submit"));
		// Modal closes.
		await waitFor(() => {
			expect(document.querySelector('[data-testid="extension-attach-picker"]')).toBeNull();
		});
		// Now submit the form. The onsubmit payload should include both
		// extension ids — the wiring contract.
		const form = document.querySelector("form")!;
		await fireEvent.submit(form);
		await waitFor(() => expect(onsubmit).toHaveBeenCalled());
		const payload = onsubmit.mock.calls[0]![0] as { extensions: string[] };
		expect(payload.extensions.sort()).toEqual(["ext-1", "ext-2"].sort());
	});

	test("initial extensions are reflected when the picker is opened", async () => {
		const { findByTestId, findAllByTestId } = render(AgentConfigForm, {
			initial: { name: "x", prompt: "y", extensions: ["ext-2"] },
			onsubmit: vi.fn(),
		});
		await fireEvent.click(await findByTestId("open-extension-attach-picker"));
		const cards = await findAllByTestId("extension-attach-picker-card");
		const card2 = cards.find((c) => c.getAttribute("data-ext-id") === "ext-2");
		expect(card2).toBeDefined();
		expect(card2!.getAttribute("data-selected")).toBe("true");
	});

	test("Cancel doesn't mutate the form's extensions", async () => {
		const onsubmit = vi.fn();
		const { findByTestId, findAllByTestId, findByText } = render(AgentConfigForm, {
			initial: { name: "x", prompt: "y", extensions: ["ext-1"] },
			onsubmit,
		});
		await fireEvent.click(await findByTestId("open-extension-attach-picker"));
		const cards = await findAllByTestId("extension-attach-picker-card");
		// Toggle ext-1 OFF then ext-2 ON in the modal — but cancel without saving.
		await fireEvent.click(cards.find((c) => c.getAttribute("data-ext-id") === "ext-1")!);
		await fireEvent.click(cards.find((c) => c.getAttribute("data-ext-id") === "ext-2")!);
		await fireEvent.click(await findByText("Cancel"));
		// Submit the form — initial extensions ["ext-1"] still attached.
		const form = document.querySelector("form")!;
		await fireEvent.submit(form);
		await waitFor(() => expect(onsubmit).toHaveBeenCalled());
		const payload = onsubmit.mock.calls[0]![0] as { extensions: string[] };
		expect(payload.extensions).toEqual(["ext-1"]);
	});
});
