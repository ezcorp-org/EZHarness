/**
 * DOM tests for DefaultCard.svelte's COLLAPSED header.
 *
 * The defect: a failed tool call rendered a red ✗, the tool name, and
 * nothing else. `extractInputSummary` did not know the extension-author
 * input keys, and `outputPreview` was gated on `status === 'complete'`,
 * so the failure reason — including the machine `code` the host works
 * to produce — was only visible after expanding. Load / permission /
 * execution / bad-response / cannot-display were one identical grey row.
 *
 * These tests pin what a user can tell apart WITHOUT clicking.
 */

import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import DefaultCard from "./DefaultCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

beforeAll(() => {
	if (typeof Element.prototype.animate !== "function") {
		(Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
			cancel: () => {},
			finished: Promise.resolve(),
			finish: () => {},
			pause: () => {},
			play: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
		});
	}
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderCard(overrides: Partial<ToolCallState> = {}) {
	return render(DefaultCard, {
		toolCall: {
			id: "tc-1",
			toolName: "install_draft",
			status: "error",
			input: { draftId: "draft-abc" },
			startedAt: 0,
			...overrides,
		} as ToolCallState,
	});
}

function failure(code: string, error: string): string {
	return JSON.stringify({ ok: false, code, error });
}

test("expansion loads complete output once and retains typed input and duration", async () => {
	let release!: (response: Response) => void;
	const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
	vi.stubGlobal("fetch", fetch);
	const ui = renderCard({ status: "complete", output: "Preview", duration: 1200 });
	const header = ui.getByRole("button", { expanded: false });
	await fireEvent.click(header);
	expect(ui.getByText("Loading full output...")).toBeVisible();
	expect(fetch).toHaveBeenCalledWith("/api/tool-calls/tc-1/output");
	release(Response.json({ output: { answer: "Saved full result" } }));
	await waitFor(() => expect(ui.getByText(/Saved full result/)).toBeVisible());
	expect(ui.getByText("Duration: 1.2s")).toBeVisible();
	expect(ui.getByText("Input")).toBeVisible();
	await fireEvent.click(header);
	await fireEvent.click(header);
	expect(fetch).toHaveBeenCalledOnce();
});

test.each([false, true])("failed expansion retains inline output and permits retry (network=%s)", async (network) => {
	const fetch = vi.fn<() => Promise<Response>>()
		.mockImplementationOnce(() => network ? Promise.reject(new Error("Offline")) : Promise.resolve(new Response(null, { status: 503 })))
		.mockResolvedValueOnce(Response.json({ output: "Recovered output" }));
	vi.stubGlobal("fetch", fetch);
	const ui = renderCard({ status: "complete", output: "Retained preview" });
	const header = ui.getByRole("button", { expanded: false });
	await fireEvent.click(header);
	await waitFor(() => expect(ui.queryByText("Loading full output...")).toBeNull());
	expect(ui.getByText("Retained preview")).toBeVisible();
	await fireEvent.click(header);
	await fireEvent.click(header);
	await waitFor(() => expect(ui.getByText("Recovered output")).toBeVisible());
	expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([false, true])("image output eagerly loads the complete image without losing a failed preview (failure=%s)", async (failure) => {
	const fetch = vi.fn(() => failure
		? Promise.reject(new Error("Offline"))
		: Promise.resolve(Response.json({ output: "![Full image](/full.png)" })));
	vi.stubGlobal("fetch", fetch);
	const ui = renderCard({ status: "complete", output: "![Preview image](/preview.png)" });
	await waitFor(() => expect(ui.getByRole("img", { name: failure ? "Preview image" : "Full image" })).toBeInTheDocument());
	expect(fetch).toHaveBeenCalledOnce();
});

describe("DefaultCard — failure class is visible while collapsed", () => {
	test("execution failure shows the class chip, the draft, and the reason", () => {
		const { getByTestId } = renderCard({
			error: failure("VERIFY_FAILED", "smoke-test-roundtrip: boom"),
		});
		const chip = getByTestId("tool-card-failure-class");
		expect(chip).toHaveAttribute("data-failure-class", "execution");
		expect(chip).toHaveTextContent("Run failed · VERIFY_FAILED");
		// The draft id reaches the header now that extractInputSummary
		// knows the extension-author keys.
		expect(getByTestId("tool-card-default")).toHaveTextContent("draft-abc");
		expect(getByTestId("tool-card-failure-message")).toHaveTextContent(
			"smoke-test-roundtrip: boom",
		);
		// All of it before any expansion.
		expect(
			getByTestId("tool-card-default").querySelector("[aria-expanded='false']"),
		).not.toBeNull();
	});

	test("the four host classes render four different chips", () => {
		const seen = new Map<string, string>();
		for (const code of [
			"MANIFEST_INVALID",
			"NOT_ALLOWLISTED",
			"VERIFY_FAILED",
			"BAD_HOST_RESPONSE",
		]) {
			const { getByTestId, unmount } = renderCard({ error: failure(code, "x") });
			const chip = getByTestId("tool-card-failure-class");
			seen.set(code, `${chip.getAttribute("data-failure-class")}|${chip.textContent}`);
			unmount();
		}
		expect(new Set(seen.values()).size).toBe(4);
		expect(seen.get("MANIFEST_INVALID")).toContain("load");
		expect(seen.get("NOT_ALLOWLISTED")).toContain("permission");
		expect(seen.get("VERIFY_FAILED")).toContain("execution");
		expect(seen.get("BAD_HOST_RESPONSE")).toContain("response");
	});

	test("the payload can arrive on `output` instead of `error`", () => {
		const { getByTestId } = renderCard({
			error: undefined,
			output: failure("ENV_KEY_LEAK", "MY_API_KEY"),
		});
		expect(getByTestId("tool-card-failure-class")).toHaveAttribute(
			"data-failure-class",
			"permission",
		);
	});

	test("a plain-text error still gets a class chip and keeps its text", () => {
		const { getByTestId } = renderCard({ error: "Tool timed out after 30s" });
		const chip = getByTestId("tool-card-failure-class");
		expect(chip).toHaveTextContent("Run failed");
		expect(chip).not.toHaveTextContent("·");
		expect(getByTestId("tool-card-failure-message")).toHaveTextContent(
			"Tool timed out after 30s",
		);
	});
});

describe("DefaultCard — rendering fallback is its own class", () => {
	test("a completed call whose declared card could not render says so", () => {
		// `ez-install` routes to EzToolResultCard; reaching DefaultCard
		// means that card's parser rejected the payload.
		const { getByTestId } = renderCard({
			status: "complete",
			error: undefined,
			cardType: "ez-install",
			output: JSON.stringify({ ok: true, extensionId: "e1" }),
		});
		const chip = getByTestId("tool-card-failure-class");
		expect(chip).toHaveAttribute("data-failure-class", "render");
		expect(chip).toHaveTextContent("Cannot display · ez-install");
	});

	test("a tool with no custom card is NOT flagged", () => {
		const { queryByTestId } = renderCard({
			status: "complete",
			error: undefined,
			cardType: undefined,
			output: "plain output",
		});
		expect(queryByTestId("tool-card-failure-class")).toBeNull();
	});

	test("an explicit cardType:'default' is NOT flagged", () => {
		const { queryByTestId } = renderCard({
			status: "complete",
			error: undefined,
			cardType: "default",
			output: "plain output",
		});
		expect(queryByTestId("tool-card-failure-class")).toBeNull();
	});

	test("a RUNNING call with a custom cardType is NOT flagged (still streaming)", () => {
		const { queryByTestId } = renderCard({
			status: "running",
			error: undefined,
			cardType: "ez-install",
			output: undefined,
		});
		expect(queryByTestId("tool-card-failure-class")).toBeNull();
	});
});

describe("DefaultCard — non-failure header is unchanged", () => {
	test("a successful call still shows the input summary", () => {
		const { getByTestId, queryByTestId } = renderCard({
			status: "complete",
			error: undefined,
			output: JSON.stringify({ ok: true }),
		});
		expect(queryByTestId("tool-card-failure-class")).toBeNull();
		expect(getByTestId("tool-card-default")).toHaveTextContent("draft-abc");
	});
});
