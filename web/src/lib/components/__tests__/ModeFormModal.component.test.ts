/**
 * DOM tests for ModeFormModal.svelte — guards the Phase mode.extensionIds
 * UI swap that replaced the legacy Tool Restriction <select> with the
 * shared ExtensionSearchPicker.
 *
 * Coverage:
 *   1. Create flow — picker renders interactive (no readonly chip strip)
 *   2. View mode (custom) — readonly chip strip shows attached extensions,
 *      Close-only actions, header Edit button enabled
 *   3. View mode (builtin) — header Edit button disabled + wrapped in
 *      Tooltip; clicking does NOT flip into edit mode
 *   4. Submit (edit) — PUT body to /api/modes/[id] includes extensionIds
 *      from editMode
 *   5. Submit (create) — POST body to /api/modes always includes the
 *      extensionIds field (even when empty)
 *   6. View mode (custom) with extensionIds=null — italic
 *      "No extensions attached." line replaces the chip strip
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import ModeFormModal from "../ModeFormModal.svelte";
import type { Mode } from "$lib/api";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}

let fetchCalls: FetchCall[] = [];

beforeEach(() => {
	fetchCalls = [];
	// Single fetch stub:
	//   - /api/extensions  → list for the picker's onMount + chip-name lookup
	//   - POST/PUT /api/modes  → echo body so the modal's submit succeeds
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: any, init: any = {}) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input?.url ?? "";
			const method = (init.method ?? "GET").toUpperCase();
			let body: any = undefined;
			if (init.body) {
				try {
					body = JSON.parse(init.body);
				} catch {
					/* non-json body */
				}
			}
			fetchCalls.push({ url, method, body });

			if (url.includes("/api/extensions") && method === "GET") {
				return new Response(
					JSON.stringify([
						{ id: "a", name: "Extension A", manifest: { tools: [{ name: "summarize" }, { name: "tldr" }] } },
						{ id: "b", name: "Extension B", manifest: { tools: [{ name: "translate" }] } },
						{ id: "z", name: "Extension Z", manifest: { tools: [{ name: "zap" }] } },
					]),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}

			if (url.match(/\/api\/modes(\?|$)/) && method === "POST") {
				const echo: Mode = {
					id: "new-mode",
					name: body?.name ?? "",
					slug: body?.slug ?? "",
					icon: body?.icon ?? null,
					description: body?.description ?? "",
					systemPromptInstruction: body?.systemPromptInstruction ?? "",
					instructionPosition: body?.instructionPosition ?? "prepend",
					preferredModel: null,
					preferredProvider: null,
					preferredThinkingLevel: null,
					temperature: null,
					toolRestriction: "all",
					extensionIds: body?.extensionIds ?? null,
					extensionTools: body?.extensionTools ?? null,
					builtin: false,
				};
				return new Response(JSON.stringify(echo), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}

			if (url.match(/\/api\/modes\/[^/]+/) && method === "PUT") {
				const echo: Mode = {
					id: url.split("/").pop()!,
					name: body?.name ?? "edited",
					slug: body?.slug ?? "edited",
					icon: body?.icon ?? null,
					description: body?.description ?? "",
					systemPromptInstruction: body?.systemPromptInstruction ?? "",
					instructionPosition: body?.instructionPosition ?? "prepend",
					preferredModel: null,
					preferredProvider: null,
					preferredThinkingLevel: null,
					temperature: null,
					toolRestriction: "all",
					extensionIds: body?.extensionIds ?? null,
					extensionTools: body?.extensionTools ?? null,
					builtin: false,
				};
				return new Response(JSON.stringify(echo), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}

			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});

function makeMode(overrides: Partial<Mode> = {}): Mode {
	return {
		id: "m1",
		name: "Custom",
		slug: "custom",
		icon: null,
		description: "",
		systemPromptInstruction: "Be helpful.",
		instructionPosition: "prepend",
		preferredModel: null,
		preferredProvider: null,
		preferredThinkingLevel: null,
		temperature: null,
		toolRestriction: "all",
		extensionIds: null,
		extensionTools: null,
		builtin: false,
		...overrides,
	};
}

// Wait for the next microtask + render flush. Used after fireEvent.click
// to let the {effect} chain that calls the fetch stub settle before we
// inspect fetchCalls.
async function flush() {
	await new Promise((r) => setTimeout(r, 50));
}

describe("ModeFormModal — Tools & Extensions section structure", () => {
	test("create flow renders 'Tools & Extensions' label + interactive picker (no readonly chip strip)", () => {
		const { getByText, container, queryByTestId, queryByText } = render(
			ModeFormModal,
			{
				open: true,
				editMode: null,
				viewMode: false,
				onsaved: () => {},
				onclose: () => {},
			},
		);

		// Header is "Create Mode" (not Edit/View)
		const headers = container.querySelectorAll("h2");
		expect(headers[0]?.textContent).toContain("Create Mode");

		// "Tools & Extensions" label is present (verifies the swap from the old
		// "Tool Restriction" select label)
		expect(getByText(/Tools & Extensions/)).toBeInTheDocument();

		// Old label MUST be gone — guards against a regression that leaves
		// both fields side-by-side.
		expect(queryByText(/Tool Restriction/)).toBeNull();

		// Interactive picker is rendered (its outer chrome carries
		// data-testid="extension-picker-combobox").
		expect(
			container.querySelector('[data-testid="extension-picker-combobox"]'),
		).not.toBeNull();

		// Read-only chip strip is NOT rendered in the create flow.
		expect(queryByTestId("mode-readonly-extension-chips")).toBeNull();
	});

	test("view mode (custom, with extensionIds): chip strip shows N chips, no interactive picker, Close-only actions, Edit enabled", () => {
		const { getByTestId, getByText, container, queryByText } = render(
			ModeFormModal,
			{
				open: true,
				editMode: makeMode({
					id: "m-view",
					extensionIds: ["a", "b"],
					builtin: false,
				}),
				viewMode: true,
				onsaved: () => {},
				onclose: () => {},
			},
		);

		// Title
		expect(container.querySelector("h2")?.textContent).toContain("View Mode");

		// Read-only chip strip with 2 chips (one per extensionId).
		const chips = getByTestId("mode-readonly-extension-chips");
		expect(chips).toBeInTheDocument();
		expect(chips.children).toHaveLength(2);

		// Interactive picker MUST NOT mount in readonly view.
		expect(
			container.querySelector('[data-testid="extension-picker-combobox"]'),
		).toBeNull();

		// Close button visible; no Cancel / no Save Changes (those belong to the
		// editable layout).
		expect(getByText("Close")).toBeInTheDocument();
		expect(queryByText("Cancel")).toBeNull();
		expect(queryByText("Save Changes")).toBeNull();

		// Header Edit button is enabled (custom mode, viewMode=true).
		const editBtn = container.querySelector(
			'button[aria-label="Edit mode"]',
		) as HTMLButtonElement | null;
		expect(editBtn).not.toBeNull();
		expect(editBtn!.disabled).toBe(false);
	});

	test("view mode (custom, extensionIds=null): renders italic 'No extensions attached.' fallback", () => {
		const { getByText, queryByTestId } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({ extensionIds: null, builtin: false }),
			viewMode: true,
			onsaved: () => {},
			onclose: () => {},
		});

		// Fallback line, not the chip strip.
		expect(getByText("No extensions attached.")).toBeInTheDocument();
		expect(queryByTestId("mode-readonly-extension-chips")).toBeNull();
	});

	test("view mode (builtin allowlist): renders the read-only tool-name chip list, not the extensions fallback", async () => {
		const { getByTestId, getByText, queryByText, queryByTestId } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "m-ez",
				name: "Ez",
				builtin: true,
				toolRestriction: "allowlist",
				allowedTools: ["summarize_conversation", "fill_form", "read_page"],
				extensionIds: null,
			}),
			viewMode: true,
			onsaved: () => {},
			onclose: () => {},
		});

		expect(getByText("Built-in tool allowlist")).toBeInTheDocument();
		const chips = getByTestId("mode-allowlist-tools");
		expect(chips.children).toHaveLength(3);
		expect(getByText("read_page")).toBeInTheDocument();
		// The extensions fallback / chip strip must NOT appear for allowlist modes.
		expect(queryByText("No extensions attached.")).toBeNull();
		expect(queryByTestId("mode-readonly-extension-chips")).toBeNull();
	});

	test("view mode (builtin): Edit button is disabled, click does not flip into edit mode", async () => {
		const { container, queryByText } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "builtin-plan",
				name: "Plan",
				builtin: true,
				extensionIds: null,
			}),
			viewMode: true,
			onsaved: () => {},
			onclose: () => {},
		});

		// The disabled-edit button uses a distinct aria-label to make
		// the disabled state machine-readable.
		const editBtn = container.querySelector(
			'button[aria-label="Edit (disabled — built-in mode)"]',
		) as HTMLButtonElement | null;
		expect(editBtn).not.toBeNull();
		expect(editBtn!.disabled).toBe(true);

		// Tooltip wrap: the disabled button is nested inside a Tooltip-managed
		// <span class="relative inline-flex"> (per Tooltip.svelte's chrome).
		// Walking up the DOM proves the disabled button is wrapped, not bare.
		const tooltipSpan = editBtn!.closest("span.relative.inline-flex");
		expect(tooltipSpan).not.toBeNull();

		// Click attempt — disabled button must not flip the modal into edit mode.
		// Edit-mode flips would mount the interactive picker; readonly-mode keeps
		// the chip strip / fallback. We assert the readonly fallback persists.
		await fireEvent.click(editBtn!);
		expect(
			container.querySelector('[data-testid="extension-picker-combobox"]'),
		).toBeNull();
		// Save Changes button (the edit-mode submit) must NOT appear.
		expect(queryByText("Save Changes")).toBeNull();
	});
});

describe("ModeFormModal — submit payload", () => {
	test("submit (edit) PUTs /api/modes/[id] with extensionIds carried from editMode", async () => {
		const onsaved = vi.fn();
		const { container } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "edit-target",
				extensionIds: ["z"],
				builtin: false,
			}),
			viewMode: false,
			onsaved,
			onclose: () => {},
		});

		// The Save Changes button is the only blue button in the modal.
		const submitBtn = container.querySelector(
			"button.bg-blue-600",
		) as HTMLButtonElement | null;
		expect(submitBtn).not.toBeNull();
		expect(submitBtn!.textContent?.trim()).toBe("Save Changes");

		await fireEvent.click(submitBtn!);
		await flush();

		const putCall = fetchCalls.find(
			(c) => c.method === "PUT" && c.url.includes("/api/modes/edit-target"),
		);
		expect(putCall).toBeDefined();
		expect(putCall!.body).toBeDefined();
		// Critical: the form persisted the editMode.extensionIds and
		// passed them through to the API.
		expect(putCall!.body.extensionIds).toEqual(["z"]);
		// And the legacy field is NOT submitted (modal stopped surfacing it).
		expect(putCall!.body.toolRestriction).toBeUndefined();

		// onsaved fired after a 200 response.
		expect(onsaved).toHaveBeenCalledTimes(1);
	});

	test("submit (create) POSTs /api/modes with extensionIds field present (default [])", async () => {
		// In the create flow the form initializes `extensionIds: []`. Even
		// when the user doesn't touch the picker, the submit body must
		// include the field — otherwise an API client could mistake the
		// absence for "carry over a default" and surprise the server.
		const onsaved = vi.fn();
		const { container } = render(ModeFormModal, {
			open: true,
			editMode: null,
			viewMode: false,
			onsaved,
			onclose: () => {},
		});

		// Fill required fields. Name's `oninput` autopopulates slug.
		const nameInput = container.querySelector(
			"#mode-form-name",
		) as HTMLInputElement;
		const promptInput = container.querySelector(
			"#mode-form-system-prompt",
		) as HTMLTextAreaElement;
		expect(nameInput).not.toBeNull();
		expect(promptInput).not.toBeNull();

		await fireEvent.input(nameInput, { target: { value: "Test Mode" } });
		await fireEvent.input(promptInput, {
			target: { value: "Be helpful in tests." },
		});

		const submitBtn = container.querySelector(
			"button.bg-blue-600",
		) as HTMLButtonElement;
		expect(submitBtn.textContent?.trim()).toBe("Create Mode");
		expect(submitBtn.disabled).toBe(false);

		await fireEvent.click(submitBtn);
		await flush();

		const postCall = fetchCalls.find(
			(c) => c.method === "POST" && /\/api\/modes(\?|$)/.test(c.url),
		);
		expect(postCall).toBeDefined();
		expect(postCall!.body).toBeDefined();
		// extensionIds must be present (as an array) in the submit body.
		expect(postCall!.body).toHaveProperty("extensionIds");
		expect(Array.isArray(postCall!.body.extensionIds)).toBe(true);
		// And toolRestriction must NOT appear — proves the legacy field
		// was fully dropped from the form payload.
		expect(postCall!.body.toolRestriction).toBeUndefined();

		expect(onsaved).toHaveBeenCalledTimes(1);
	});
});

describe("ModeFormModal — interactions & branches", () => {
	test("Edit button (view mode) flips into the interactive edit layout", async () => {
		const { container } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({ id: "m-edit", extensionIds: ["a"], builtin: false }),
			viewMode: true,
			onsaved: () => {},
			onclose: () => {},
		});
		const editBtn = container.querySelector('button[aria-label="Edit mode"]') as HTMLButtonElement;
		expect(editBtn).not.toBeNull();
		await fireEvent.click(editBtn); // isEditing = true
		await flush();
		expect(container.querySelector('[data-testid="extension-picker-combobox"]')).not.toBeNull();
	});

	test("opening then closing the extension attach picker toggles it", async () => {
		const { container, getByLabelText, queryByLabelText } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({ id: "m-ap", extensionIds: ["a"], builtin: false }),
			viewMode: false,
			onsaved: () => {},
			onclose: () => {},
		});
		const openBtn = container.querySelector(
			'[data-testid="open-extension-attach-picker"]',
		) as HTMLButtonElement;
		expect(openBtn).not.toBeNull();
		await fireEvent.click(openBtn); // attachPickerOpen = true
		await flush();

		// The picker's "Close picker" fires the modal's onclose handler for the
		// nested picker → attachPickerOpen = false.
		await fireEvent.click(getByLabelText("Close picker"));
		await flush();
		expect(queryByLabelText("Close picker")).toBeNull();
	});

	test("Escape closes the modal (reset + onclose)", async () => {
		const onclose = vi.fn();
		const { container } = render(ModeFormModal, {
			open: true,
			editMode: null,
			viewMode: false,
			onsaved: () => {},
			onclose,
		});
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
		await fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("a failed save surfaces the error message (submit catch)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: any, init: any = {}) => {
				const url = typeof input === "string" ? input : (input?.url ?? "");
				const method = (init.method ?? "GET").toUpperCase();
				if (url.includes("/api/extensions") && method === "GET") {
					return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
				}
				if (/\/api\/modes(\?|$)/.test(url) && method === "POST") {
					return new Response(JSON.stringify({ error: "duplicate slug" }), {
						status: 409,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
			}),
		);
		const { container, findByText } = render(ModeFormModal, {
			open: true,
			editMode: null,
			viewMode: false,
			onsaved: vi.fn(),
			onclose: () => {},
		});
		await fireEvent.input(container.querySelector("#mode-form-name") as HTMLInputElement, {
			target: { value: "Dup" },
		});
		await fireEvent.input(container.querySelector("#mode-form-system-prompt") as HTMLTextAreaElement, {
			target: { value: "prompt" },
		});
		await fireEvent.click(container.querySelector("button.bg-blue-600") as HTMLButtonElement);
		await flush();
		expect(await findByText(/duplicate slug|Failed to save mode/)).toBeInTheDocument();
	});
});

describe("ModeFormModal — per-tool subset (extensionTools)", () => {
	test("edit mode renders the per-tool selector; subset checks only selected tools", async () => {
		const { findByTestId } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "subset-target",
				extensionIds: ["a"],
				extensionTools: { a: ["summarize"] },
			}),
			viewMode: false,
			onsaved: () => {},
			onclose: () => {},
		});
		const summarize = (await findByTestId("tool-a-summarize")) as HTMLInputElement;
		const tldr = (await findByTestId("tool-a-tldr")) as HTMLInputElement;
		expect(summarize.checked).toBe(true);
		expect(tldr.checked).toBe(false);
	});

	test("submit (edit) carries the extensionTools subset to the PUT body", async () => {
		const { findByTestId, container } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "subset-put",
				extensionIds: ["a"],
				extensionTools: null, // starts as "all tools"
			}),
			viewMode: false,
			onsaved: vi.fn(),
			onclose: () => {},
		});

		// Deselect tldr → narrows ext a to [summarize].
		const tldr = (await findByTestId("tool-a-tldr")) as HTMLInputElement;
		await fireEvent.click(tldr);

		const submitBtn = container.querySelector("button.bg-blue-600") as HTMLButtonElement;
		await fireEvent.click(submitBtn);
		await flush();

		const putCall = fetchCalls.find(
			(c) => c.method === "PUT" && c.url.includes("/api/modes/subset-put"),
		);
		expect(putCall).toBeDefined();
		expect(putCall!.body.extensionTools).toEqual({ a: ["summarize"] });
	});

	test("removing an extension prunes its stale subset key from the PUT body", async () => {
		const { findByLabelText, container } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "prune-target",
				extensionIds: ["a", "b"],
				extensionTools: { a: ["summarize"], b: ["translate"] },
			}),
			viewMode: false,
			onsaved: vi.fn(),
			onclose: () => {},
		});

		// Remove Extension B via its chip × (SelectedPill fires on mousedown).
		const removeBtn = await findByLabelText("Remove Extension B");
		await fireEvent.mouseDown(removeBtn);

		const submitBtn = container.querySelector("button.bg-blue-600") as HTMLButtonElement;
		await fireEvent.click(submitBtn);
		await flush();

		const putCall = fetchCalls.find(
			(c) => c.method === "PUT" && c.url.includes("/api/modes/prune-target"),
		);
		expect(putCall).toBeDefined();
		expect(putCall!.body.extensionIds).toEqual(["a"]);
		// b's subset key must have been pruned.
		expect(putCall!.body.extensionTools).toEqual({ a: ["summarize"] });
	});

	test("view (readonly) mode summarizes per-extension tool selection", async () => {
		const { findByText, queryByTestId } = render(ModeFormModal, {
			open: true,
			editMode: makeMode({
				id: "subset-view",
				extensionIds: ["a"],
				extensionTools: { a: ["summarize"] },
			}),
			viewMode: true,
			onsaved: () => {},
			onclose: () => {},
		});
		// Readonly summary text, not an interactive checkbox.
		expect(await findByText("summarize")).toBeInTheDocument();
		expect(queryByTestId("tool-a-summarize")).toBeNull();
	});
});
