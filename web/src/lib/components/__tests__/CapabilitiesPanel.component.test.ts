/**
 * DOM tests for CapabilitiesPanel (Phase 3 §5.2): the per-capability
 * Inherit / Custom / Disabled control on the extension detail page.
 *
 *   - renders only when the extension HOLDS a capability (empty → nothing)
 *   - Inherit shows the instance-default effective values
 *   - Custom reveals prefilled schema fields and saves a FIELD-LEVEL
 *     partial override (quota 500 → { quota: 500 })
 *   - Disabled saves `false`
 *   - a non-admin sees it READ-ONLY (controls disabled, no Save), the
 *     "admin-managed" hint shows
 *   - a failed save flashes the error
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import CapabilitiesPanel from "../extensions/CapabilitiesPanel.svelte";
import type { HeldCapabilityView } from "$lib/capability-policy-ui.js";

const SCHEMA = [
	{
		key: "providers",
		field: {
			type: "select" as const,
			label: "Allowed providers",
			options: [
				{ value: "inherit", label: "Inherit (instance default)" },
				{ value: "searxng", label: "searxng" },
				{ value: "brave", label: "brave" },
				{ value: "tavily", label: "tavily" },
			],
			default: "inherit",
		},
	},
	{ key: "quota", field: { type: "number" as const, label: "Daily quota", default: 100, min: 1 } },
	{ key: "maxResults", field: { type: "number" as const, label: "Max results", default: 5, min: 1 } },
];

function held(over: Partial<HeldCapabilityView> = {}): HeldCapabilityView {
	return {
		cap: "search",
		schema: SCHEMA,
		effective: { denied: false, quota: 100, maxResults: 5, providers: "all" },
		grant: "inherit",
		...over,
	};
}

describe("CapabilitiesPanel render gating", () => {
	test("renders nothing when no capabilities held", () => {
		const { queryByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [], isAdmin: true, onsave: vi.fn() },
		});
		expect(queryByTestId("capabilities-panel")).toBeNull();
	});

	test("renders the section + a row per held capability", () => {
		const { getByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held()], isAdmin: true, onsave: vi.fn() },
		});
		expect(getByTestId("capabilities-panel")).toBeInTheDocument();
		expect(getByTestId("capability-row-search")).toBeInTheDocument();
	});
});

describe("CapabilitiesPanel — Inherit mode", () => {
	test("shows the instance-default effective values", () => {
		const { getByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held({ grant: "inherit" })], isAdmin: true, onsave: vi.fn() },
		});
		expect(getByTestId("capability-search-mode-inherit").getAttribute("aria-checked")).toBe("true");
		expect(getByTestId("capability-search-inherit-summary")).toHaveTextContent("quota 100");
	});
});

describe("CapabilitiesPanel — Custom mode (admin)", () => {
	test("reveals prefilled fields and saves a field-level partial override (quota 500)", async () => {
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held()], isAdmin: true, onsave },
		});

		await fireEvent.click(getByTestId("capability-search-mode-custom"));
		await waitFor(() => expect(getByTestId("capability-search-custom-fields")).toBeInTheDocument());

		// Prefilled with the inherited values.
		expect((getByTestId("capability-search-field-quota") as HTMLInputElement).value).toBe("100");

		const quota = getByTestId("capability-search-field-quota") as HTMLInputElement;
		await fireEvent.input(quota, { target: { value: "500" } });
		await fireEvent.click(getByTestId("capability-search-save"));

		await waitFor(() => expect(onsave).toHaveBeenCalledWith("search", { quota: 500 }));
	});

	test("toggling to a 2-provider subset saves { providers: [searxng, brave] }", async () => {
		// SCHEMA offers searxng + brave (2 of the known set). Effective is
		// "all" → both seed checked. Unchecking neither but the effective
		// "all" === full set, so we must change the set to produce an
		// override: uncheck none would collapse to inherit. Instead start
		// from a grant that pins one, then check the second.
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: {
				capabilities: [
					held({
						grant: { providers: ["searxng"] },
						effective: { denied: false, quota: 100, maxResults: 5, providers: ["searxng"] },
					}),
				],
				isAdmin: true,
				onsave,
			},
		});
		await waitFor(() => expect(getByTestId("capability-search-providers-group")).toBeInTheDocument());

		// searxng seeded checked; brave unchecked. Check brave → both.
		expect((getByTestId("capability-search-provider-searxng") as HTMLInputElement).checked).toBe(true);
		expect((getByTestId("capability-search-provider-brave") as HTMLInputElement).checked).toBe(false);
		await fireEvent.change(getByTestId("capability-search-provider-brave"), { target: { checked: true } });
		await fireEvent.click(getByTestId("capability-search-save"));

		await waitFor(() => expect(onsave).toHaveBeenCalledWith("search", { providers: ["searxng", "brave"] }));
	});

	test("unchecking to a single provider saves { providers: [searxng] }", async () => {
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: {
				capabilities: [
					held({
						grant: { providers: ["searxng", "brave"] },
						effective: { denied: false, quota: 100, maxResults: 5, providers: ["searxng", "brave"] },
					}),
				],
				isAdmin: true,
				onsave,
			},
		});
		await waitFor(() => expect(getByTestId("capability-search-providers-group")).toBeInTheDocument());

		await fireEvent.change(getByTestId("capability-search-provider-brave"), { target: { checked: false } });
		await fireEvent.click(getByTestId("capability-search-save"));

		await waitFor(() => expect(onsave).toHaveBeenCalledWith("search", { providers: ["searxng"] }));
	});

	test("unchecking ALL providers blocks save with a validation error", async () => {
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: {
				capabilities: [
					held({
						grant: { providers: ["searxng"] },
						effective: { denied: false, quota: 100, maxResults: 5, providers: ["searxng"] },
					}),
				],
				isAdmin: true,
				onsave,
			},
		});
		await waitFor(() => expect(getByTestId("capability-search-providers-group")).toBeInTheDocument());

		// Uncheck the only checked provider → empty selection.
		await fireEvent.change(getByTestId("capability-search-provider-searxng"), { target: { checked: false } });
		await fireEvent.click(getByTestId("capability-search-save"));

		await waitFor(() => expect(getByTestId("capability-search-providers-error")).toBeInTheDocument());
		expect(onsave).not.toHaveBeenCalled();
	});

	test("a pre-existing 2-provider grant renders 2 checked boxes (silent-collapse regression is impossible)", async () => {
		const { getByTestId } = render(CapabilitiesPanel, {
			props: {
				capabilities: [
					held({
						grant: { providers: ["searxng", "brave"] },
						effective: { denied: false, quota: 100, maxResults: 5, providers: ["searxng", "brave"] },
					}),
				],
				isAdmin: true,
				onsave: vi.fn(),
			},
		});
		await waitFor(() => expect(getByTestId("capability-search-providers-group")).toBeInTheDocument());
		expect((getByTestId("capability-search-provider-searxng") as HTMLInputElement).checked).toBe(true);
		expect((getByTestId("capability-search-provider-brave") as HTMLInputElement).checked).toBe(true);
	});

	test("editing quota leaves the provider selection intact", async () => {
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: {
				capabilities: [
					held({
						grant: { providers: ["searxng", "brave"] },
						effective: { denied: false, quota: 100, maxResults: 5, providers: ["searxng", "brave"] },
					}),
				],
				isAdmin: true,
				onsave,
			},
		});
		await waitFor(() => expect(getByTestId("capability-search-field-quota")).toBeInTheDocument());

		await fireEvent.input(getByTestId("capability-search-field-quota"), { target: { value: "250" } });
		await fireEvent.click(getByTestId("capability-search-save"));

		await waitFor(() =>
			expect(onsave).toHaveBeenCalledWith("search", { providers: ["searxng", "brave"], quota: 250 }),
		);
	});
});

describe("CapabilitiesPanel — Disabled mode (admin)", () => {
	test("saves false", async () => {
		const onsave = vi.fn(async () => {});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held()], isAdmin: true, onsave },
		});
		await fireEvent.click(getByTestId("capability-search-mode-disabled"));
		await waitFor(() => expect(getByTestId("capability-search-disabled-summary")).toBeInTheDocument());
		await fireEvent.click(getByTestId("capability-search-save"));
		await waitFor(() => expect(onsave).toHaveBeenCalledWith("search", false));
	});

	test("a disabled (false) grant renders in Disabled mode initially", () => {
		const { getByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held({ grant: false, effective: { denied: true } })], isAdmin: true, onsave: vi.fn() },
		});
		expect(getByTestId("capability-search-mode-disabled").getAttribute("aria-checked")).toBe("true");
	});
});

describe("CapabilitiesPanel — non-admin (read-only)", () => {
	test("controls disabled, Save absent, admin-managed hint shown; cannot write", async () => {
		const onsave = vi.fn(async () => {});
		const { getByTestId, queryByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held()], isAdmin: false, onsave },
		});
		expect(getByTestId("capability-search-readonly")).toBeInTheDocument();
		expect(getByTestId("capability-search-mode-custom")).toBeDisabled();
		expect(queryByTestId("capability-search-save")).toBeNull();

		// Even forcing a click on the disabled mode button does nothing.
		await fireEvent.click(getByTestId("capability-search-mode-custom"));
		expect(onsave).not.toHaveBeenCalled();
	});
});

describe("CapabilitiesPanel — save failure", () => {
	test("flashes the error when onsave rejects", async () => {
		const onsave = vi.fn(async () => {
			throw new Error("403");
		});
		const { getByTestId } = render(CapabilitiesPanel, {
			props: { capabilities: [held()], isAdmin: true, onsave },
		});
		await fireEvent.click(getByTestId("capability-search-save"));
		await waitFor(() => expect(getByTestId("capability-search-error")).toBeInTheDocument());
	});
});
