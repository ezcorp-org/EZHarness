/**
 * DOM tests for the unified save model (locked decision 5):
 *   - DefaultTierSection: tier click PUTs immediately (no Save button),
 *     inline "Saved ✓" confirmation
 *   - PreferenceOrderSection: arrow move PUTs the new order immediately
 *   - AdvancedSection: toggle PUTs immediately with confirmation
 *   - GlobalInstructionsSection: explicit Save disabled until dirty,
 *     disabled again after a successful save
 *   - SecuritySettings: explicit Save disabled until dirty
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import DefaultTierSection from "../settings/DefaultTierSection.svelte";
import PreferenceOrderSection from "../settings/PreferenceOrderSection.svelte";
import AdvancedSection from "../settings/AdvancedSection.svelte";
import GlobalInstructionsSection from "../settings/GlobalInstructionsSection.svelte";
import SecuritySettings from "../settings/SecuritySettings.svelte";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(getJson: (url: string) => unknown = () => ({ ok: true })) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			fetchCalls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return Response.json(getJson(url));
		}),
	);
}

const puts = () => fetchCalls.filter((c) => c.method === "PUT");

afterEach(() => vi.unstubAllGlobals());

describe("DefaultTierSection auto-save", () => {
	test("tier click PUTs without a Save button and flashes Saved ✓", async () => {
		stubFetch();
		const { getByText, queryByText, getByTestId } = render(DefaultTierSection, {
			props: { defaultTier: "balanced" },
		});

		expect(queryByText("Save Tier")).not.toBeInTheDocument();

		await fireEvent.click(getByText("Powerful"));

		await waitFor(() => {
			expect(getByTestId("save-indicator-saved")).toBeInTheDocument();
		});
		expect(puts()).toHaveLength(1);
		expect(puts()[0]!.url).toContain("/api/settings/provider:defaultTier");
		expect(puts()[0]!.body).toEqual({ value: "powerful" });
	});

	test("clicking the already-selected tier is a no-op", async () => {
		stubFetch();
		const { getByText } = render(DefaultTierSection, { props: { defaultTier: "balanced" } });
		await fireEvent.click(getByText("Balanced"));
		expect(puts()).toHaveLength(0);
	});
});

describe("PreferenceOrderSection auto-save", () => {
	test("arrow move PUTs the new order without a Save button", async () => {
		stubFetch();
		const { getAllByTitle, queryByText, getByTestId } = render(PreferenceOrderSection, {
			props: { preferenceOrder: ["anthropic", "openai", "google"] },
		});

		expect(queryByText("Save Order")).not.toBeInTheDocument();

		await fireEvent.click(getAllByTitle("Move down")[0]!);

		await waitFor(() => {
			expect(getByTestId("save-indicator-saved")).toBeInTheDocument();
		});
		expect(puts()).toHaveLength(1);
		expect(puts()[0]!.url).toContain("/api/settings/provider:preferenceOrder");
		expect(puts()[0]!.body).toEqual({ value: ["openai", "anthropic", "google"] });
	});

	test("move past the boundary is a no-op", async () => {
		stubFetch();
		const { getAllByTitle } = render(PreferenceOrderSection, {
			props: { preferenceOrder: ["anthropic", "openai"] },
		});
		await fireEvent.click(getAllByTitle("Move up")[0]!);
		expect(puts()).toHaveLength(0);
	});
});

describe("AdvancedSection auto-save", () => {
	test("toggle PUTs immediately with confirmation", async () => {
		stubFetch();
		const { getByLabelText, getByTestId } = render(AdvancedSection, {
			props: { showObservability: false, agentAutonomyEnabled: true },
		});

		await fireEvent.click(getByLabelText("Toggle observability"));

		await waitFor(() => {
			expect(getByTestId("save-indicator-saved")).toBeInTheDocument();
		});
		expect(puts()[0]!.url).toContain("/api/settings/global:showObservability");
		expect(puts()[0]!.body).toEqual({ value: true });
	});
});

describe("GlobalInstructionsSection dirty tracking", () => {
	test("Save disabled until dirty, disabled again after save", async () => {
		stubFetch();
		const { getByText, getByLabelText, getByTestId } = render(GlobalInstructionsSection, {
			props: { globalPrompt: "original" },
		});

		const save = getByText("Save Global Instructions").closest("button")!;
		expect(save).toBeDisabled();

		await fireEvent.input(getByLabelText("Global custom instructions"), {
			target: { value: "updated prompt" },
		});
		expect(save).not.toBeDisabled();

		await fireEvent.click(save);
		await waitFor(() => {
			expect(getByTestId("save-indicator-saved")).toBeInTheDocument();
		});
		expect(save).toBeDisabled();
		expect(puts()[0]!.body).toEqual({ value: "updated prompt" });
	});

	test("reverting to the baseline disables Save again", async () => {
		stubFetch();
		const { getByText, getByLabelText } = render(GlobalInstructionsSection, {
			props: { globalPrompt: "original" },
		});
		const textarea = getByLabelText("Global custom instructions");
		const save = getByText("Save Global Instructions").closest("button")!;

		await fireEvent.input(textarea, { target: { value: "changed" } });
		expect(save).not.toBeDisabled();
		await fireEvent.input(textarea, { target: { value: "original" } });
		expect(save).toBeDisabled();
	});
});

describe("SecuritySettings dirty tracking", () => {
	test("Save disabled until a field changes, disabled after saving", async () => {
		stubFetch(() => ({}));
		const { getByText, container } = render(SecuritySettings);

		await waitFor(() => {
			expect(getByText("Save Security Settings")).toBeInTheDocument();
		});
		const save = getByText("Save Security Settings").closest("button")!;
		expect(save).toBeDisabled();

		const tokenInput = container.querySelector('input[step="1000"]')!;
		await fireEvent.input(tokenInput, { target: { value: "250000" } });
		expect(save).not.toBeDisabled();

		await fireEvent.click(save);
		await waitFor(() => {
			expect(save).toBeDisabled();
		});
		const tokenPut = puts().find((c) => c.url.includes("limits:dailyTokens"));
		expect(tokenPut?.body).toEqual({ value: 250000 });
	});
});
