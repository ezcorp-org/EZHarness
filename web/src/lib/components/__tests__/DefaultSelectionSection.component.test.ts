/**
 * DOM tests for DefaultSelectionSection.svelte — the `provider:defaultSelection`
 * editor (Settings → Models).
 *
 * This control is the no-deploy REVERT for routed-by-default traffic, so the
 * tests assert the things an operator relies on:
 *   - both choices are rendered WITH the consequence spelled out (not a bare
 *     toggle named after a settings key);
 *   - the stored mode is the checked one;
 *   - picking the other mode PUTs it and flashes Saved;
 *   - re-picking the current mode writes nothing;
 *   - a failed save rolls the selection back so the screen matches the DB.
 */
import { render, fireEvent, screen, waitFor, cleanup } from "@testing-library/svelte";
import { describe, test, expect, vi, afterEach } from "vitest";
import DefaultSelectionSection from "../settings/DefaultSelectionSection.svelte";

interface PutCall {
	url: string;
	body: unknown;
}

function stubFetch(opts: { reject?: boolean } = {}): PutCall[] {
	const calls: PutCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
			const status = opts.reject ? 500 : 200;
			return new Response(JSON.stringify(opts.reject ? { error: "nope" } : { ok: true }), {
				status,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
});

describe("DefaultSelectionSection", () => {
	test("offers both modes and explains what each one does", () => {
		stubFetch();
		render(DefaultSelectionSection, { defaultSelection: "auto" });

		const auto = screen.getByTestId("default-selection-auto");
		const first = screen.getByTestId("default-selection-first");

		expect(auto).toHaveTextContent("Auto (smart routing)");
		expect(auto).toHaveTextContent("picks the tier for the first turn");
		expect(first).toHaveTextContent("First available model");
		expect(first).toHaveTextContent("before routing existed");
	});

	test("the stored mode is the checked radio", () => {
		stubFetch();
		render(DefaultSelectionSection, { defaultSelection: "first" });

		expect(screen.getByTestId("default-selection-first")).toHaveAttribute("aria-checked", "true");
		expect(screen.getByTestId("default-selection-auto")).toHaveAttribute("aria-checked", "false");
	});

	test('choosing "first" PUTs the revert and confirms it saved', async () => {
		const calls = stubFetch();
		render(DefaultSelectionSection, { defaultSelection: "auto" });

		await fireEvent.click(screen.getByTestId("default-selection-first"));

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url).toContain("/api/settings/provider:defaultSelection");
		expect(calls[0]!.body).toEqual({ value: "first" });
		await waitFor(() =>
			expect(screen.getByTestId("default-selection-first")).toHaveAttribute("aria-checked", "true"),
		);
		expect(await screen.findByTestId("save-indicator-saved")).toBeInTheDocument();
	});

	test("re-picking the mode already in effect writes nothing", async () => {
		const calls = stubFetch();
		render(DefaultSelectionSection, { defaultSelection: "auto" });

		await fireEvent.click(screen.getByTestId("default-selection-auto"));

		expect(calls).toHaveLength(0);
		expect(screen.queryByTestId("save-indicator-saved")).not.toBeInTheDocument();
	});

	test("a failed save rolls the choice back instead of lying about it", async () => {
		const calls = stubFetch({ reject: true });
		render(DefaultSelectionSection, { defaultSelection: "auto" });

		await fireEvent.click(screen.getByTestId("default-selection-first"));

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(await screen.findByTestId("save-indicator-error")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByTestId("default-selection-auto")).toHaveAttribute("aria-checked", "true"),
		);
		expect(screen.getByTestId("default-selection-first")).toHaveAttribute("aria-checked", "false");
	});
});
