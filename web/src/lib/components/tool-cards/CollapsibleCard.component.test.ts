/**
 * DOM tests for CollapsibleCard.svelte — the disclosure wrapper that keeps
 * noisy dev-command cards (Bash / grep / diff) collapsed in the chat thread.
 *
 * Pins the user-visible contract:
 *  - collapsed by default for EVERY status, including `running`
 *  - a running call still shows the spinner + "Running…" so the user knows
 *    work is in flight even though the body is hidden
 *  - clicking the header reveals the slotted body; clicking again hides it
 *  - the tool name + the FULL command (verbatim, in a code block) are
 *    always visible — collapsed AND expanded — never truncated, so the
 *    shown command always matches the command the tool was invoked with
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { createRawSnippet } from "svelte";
import CollapsibleCard from "./CollapsibleCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

beforeAll(() => {
	// jsdom lacks the Web Animations API; svelte/transition's `slide` calls
	// Element.animate on expand. Stub it so the expanded branch renders.
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

afterEach(() => cleanup());

/** A trivial body so we can assert it's hidden until the card is expanded. */
const bodySnippet = createRawSnippet(() => ({
	render: () => `<div data-testid="card-body">BODY CONTENT</div>`,
}));

function baseToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: "tc-1",
		toolName: "Bash",
		status: "complete",
		input: { command: "grep -rn foo src" },
		startedAt: 0,
		duration: 1200,
		...overrides,
	};
}

function renderCard(overrides: Partial<ToolCallState> = {}) {
	return render(CollapsibleCard, {
		toolCall: baseToolCall(overrides),
		children: bodySnippet,
	});
}

describe("CollapsibleCard — collapsed by default", () => {
	test("complete: body hidden until the header is clicked", async () => {
		const { queryByTestId, getByTestId } = renderCard({ status: "complete" });

		const toggle = getByTestId("collapsible-card-toggle");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(queryByTestId("card-body")).toBeNull();

		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(getByTestId("card-body")).toBeInTheDocument();

		// Clicking again collapses the disclosure state back. (We assert the
		// state, not DOM removal — the slide outro is async and not driven by
		// the jsdom Web-Animations stub.)
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
	});

	test("running: still collapsed, but spinner + 'Running…' signal in-flight work", () => {
		const { container, queryByTestId, getByTestId, getByText } = renderCard({
			status: "running",
			duration: undefined,
		});

		// Body hidden even while running.
		expect(queryByTestId("card-body")).toBeNull();

		const toggle = getByTestId("collapsible-card-toggle");
		expect(toggle).toHaveAttribute("aria-busy", "true");

		// Spinner icon (animate-spin) present; not the check / X.
		const icon = container.querySelector("button svg") as SVGElement;
		expect(icon.classList.contains("animate-spin")).toBe(true);
		expect(icon.classList.contains("text-green-500")).toBe(false);
		expect(icon.classList.contains("text-red-500")).toBe(false);

		expect(getByText("Running…")).toBeInTheDocument();
	});

	test("running: can still be expanded on demand", async () => {
		const { getByTestId } = renderCard({ status: "running", duration: undefined });
		const toggle = getByTestId("collapsible-card-toggle");
		await fireEvent.click(toggle);
		expect(getByTestId("card-body")).toBeInTheDocument();
	});
});

describe("CollapsibleCard — full command code block", () => {
	const LONG_CMD =
		"grep -rn --line-buffered 'needle' src | awk '{print $1}' | sort -u | " +
		'xargs -I{} sh -c \'echo "processing {}"; cat {} | head -n 50\' | ' +
		"tee /tmp/out.log && echo 'done — this command is far longer than any header preview budget'";

	test("collapsed: renders the FULL command verbatim in a <code> block (no truncation)", () => {
		const { getByTestId } = renderCard({
			toolName: "Bash",
			input: { command: LONG_CMD },
			status: "complete",
		});

		const toggle = getByTestId("collapsible-card-toggle");
		expect(toggle).toHaveAttribute("aria-expanded", "false"); // still collapsed

		const code = getByTestId("collapsible-card-command");
		// Exact match — the rendered command IS the command used.
		expect(code.textContent).toBe(LONG_CMD);
		// It's an actual code block, monospace, wraps (never truncates).
		expect(code.tagName).toBe("CODE");
		expect(code.className).toContain("font-mono");
		expect(code.className).toContain("whitespace-pre-wrap");
		expect(code.className).not.toContain("truncate");
	});

	test("the command block stays present & identical after expanding", async () => {
		const { getByTestId } = renderCard({
			toolName: "Bash",
			input: { command: LONG_CMD },
			status: "complete",
		});

		expect(getByTestId("collapsible-card-command").textContent).toBe(LONG_CMD);

		await fireEvent.click(getByTestId("collapsible-card-toggle"));

		// Body now shown AND the command block is still there, unchanged.
		expect(getByTestId("card-body")).toBeInTheDocument();
		expect(getByTestId("collapsible-card-command").textContent).toBe(LONG_CMD);
	});

	test("cmd always matches cmd used: quotes / pipes / $() / newlines preserved exactly", () => {
		const command = `for f in $(ls *.ts); do\n  echo "file: \${f}" | grep -E 'a|b';\ndone`;
		const { getByTestId } = renderCard({
			toolName: "Bash",
			input: { command },
			status: "running",
			duration: undefined,
		});
		// Verbatim even while running (collapsed, spinner showing).
		expect(getByTestId("collapsible-card-command").textContent).toBe(command);
	});

	test("diff card: shows the full file_path in the code block", () => {
		const file_path =
			"/home/dev/work/EZCorp/ez-corp-ai/web/src/lib/components/tool-cards/CollapsibleCard.svelte";
		const { getByTestId } = renderCard({
			toolName: "Edit",
			input: { file_path, old_string: "a", new_string: "b" },
			status: "complete",
		});
		expect(getByTestId("collapsible-card-command").textContent).toBe(file_path);
	});

	test("no usable arg → no command code block rendered", () => {
		const { queryByTestId } = renderCard({
			toolName: "weird-tool",
			input: { foo: "bar" },
			status: "complete",
		});
		expect(queryByTestId("collapsible-card-command")).toBeNull();
	});
});

describe("CollapsibleCard — header content", () => {
	test("shows the tool name", () => {
		const { getByText } = renderCard({ toolName: "Grep", status: "complete" });
		expect(getByText("Grep")).toBeInTheDocument();
	});

	test("complete: shows the formatted duration", () => {
		const { getByText } = renderCard({ status: "complete", duration: 2500 });
		expect(getByText("2.5s")).toBeInTheDocument();
	});

	test("error: shows the red X icon (not the green check)", () => {
		const { container } = renderCard({ status: "error", error: "boom" });
		const icon = container.querySelector("button svg") as SVGElement;
		expect(icon.classList.contains("text-red-500")).toBe(true);
		expect(icon.classList.contains("text-green-500")).toBe(false);
	});
});
