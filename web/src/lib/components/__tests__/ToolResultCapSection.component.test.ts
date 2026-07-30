/**
 * DOM tests for ToolResultCapSection.svelte — the `compaction:toolResultCap`
 * editor (Settings → Models).
 *
 * The interesting behaviour is that this control saves on COMMIT, not per
 * keystroke, and refuses a bad value locally with the SAME message the settings
 * API would return — so the tests cover:
 *   - the cap is shown in characters and restated in tokens;
 *   - typing does not write; leaving the field does;
 *   - 0 saves and the copy switches to "the cap is off";
 *   - a fractional / blank value is refused inline and nothing is written;
 *   - a failed save rolls both the value and the field back.
 */
import { render, fireEvent, screen, waitFor, cleanup } from "@testing-library/svelte";
import { describe, test, expect, vi, afterEach } from "vitest";
import ToolResultCapSection from "../settings/ToolResultCapSection.svelte";

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

function input(): HTMLInputElement {
	return screen.getByTestId("tool-result-cap-input") as HTMLInputElement;
}

/** Type a value and leave the field — the component's commit gesture. */
async function commit(value: string) {
	await fireEvent.input(input(), { target: { value } });
	await fireEvent.change(input());
}

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
});

describe("ToolResultCapSection", () => {
	test("shows the stored cap in characters and restates it in tokens", () => {
		stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		expect(input().value).toBe("32000");
		expect(screen.getByTestId("tool-result-cap-effect")).toHaveTextContent("About 8,000 tokens");
	});

	test("typing alone does not write — only leaving the field does", async () => {
		const calls = stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await fireEvent.input(input(), { target: { value: "1" } });
		await fireEvent.input(input(), { target: { value: "16" } });
		expect(calls).toHaveLength(0);

		await fireEvent.input(input(), { target: { value: "16000" } });
		await fireEvent.change(input());

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url).toContain("/api/settings/compaction:toolResultCap");
		expect(calls[0]!.body).toEqual({ value: 16_000 });
		expect(await screen.findByTestId("save-indicator-saved")).toBeInTheDocument();
	});

	test("committing the value already stored writes nothing", async () => {
		const calls = stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await commit("32000");

		expect(calls).toHaveLength(0);
		expect(screen.queryByTestId("tool-result-cap-refusal")).not.toBeInTheDocument();
	});

	test("0 saves and the copy says the cap is off", async () => {
		const calls = stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await commit("0");

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.body).toEqual({ value: 0 });
		await waitFor(() =>
			expect(screen.getByTestId("tool-result-cap-effect")).toHaveTextContent("The cap is off"),
		);
	});

	test("a fractional cap is refused inline, with the reason, and never sent", async () => {
		const calls = stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await commit("1000.5");

		expect(calls).toHaveLength(0);
		expect(screen.getByTestId("tool-result-cap-refusal")).toHaveTextContent("whole number");
	});

	test("a blank field is a mistake, not a request to disable the cap", async () => {
		const calls = stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await commit("");

		expect(calls).toHaveLength(0);
		expect(screen.getByTestId("tool-result-cap-refusal")).toHaveTextContent(
			"whole number of characters",
		);
		// The stored value is untouched, so the effect line still describes it.
		expect(screen.getByTestId("tool-result-cap-effect")).toHaveTextContent("About 8,000 tokens");
	});

	test("a refusal clears once an acceptable value is committed", async () => {
		const calls = stubFetch();
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await commit("-1");
		expect(screen.getByTestId("tool-result-cap-refusal")).toHaveTextContent("use 0 to disable");

		await commit("8000");

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(screen.queryByTestId("tool-result-cap-refusal")).not.toBeInTheDocument();
	});

	test("a failed save rolls both the value and the field back", async () => {
		const calls = stubFetch({ reject: true });
		render(ToolResultCapSection, { toolResultCap: 32_000 });

		await commit("4000");

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(await screen.findByTestId("save-indicator-error")).toBeInTheDocument();
		await waitFor(() => expect(input().value).toBe("32000"));
		expect(screen.getByTestId("tool-result-cap-effect")).toHaveTextContent("About 8,000 tokens");
	});
});
