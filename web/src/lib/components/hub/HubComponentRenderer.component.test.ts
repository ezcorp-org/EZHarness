/**
 * HubComponentRenderer — DOM tests for every node type, action
 * dispatch, recursion, href re-check, and markdown sanitization.
 */
import { describe, test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import HubComponentRenderer from "./HubComponentRenderer.svelte";
import type { PageNode } from "$lib/hub";

function renderNodes(nodes: PageNode[], onAction = vi.fn()) {
	const utils = render(HubComponentRenderer, { props: { nodes, onAction } });
	return { ...utils, onAction };
}

describe("panel-vocabulary nodes", () => {
	test("header / text / badge / status / kv / counter / divider render", () => {
		const { getByTestId } = renderNodes([
			{ type: "header", title: "Head", subtitle: "Sub" },
			{ type: "text", content: "Body", variant: "muted" },
			{ type: "badge", label: "Beta", color: "purple" },
			{ type: "status", label: "Running", state: "running" },
			{ type: "kv", pairs: [{ key: "K", value: "V" }] },
			{ type: "counter", label: "Done", value: 3, total: 9 },
			{ type: "divider" },
		]);
		expect(getByTestId("hub-node-header")).toHaveTextContent("Head");
		expect(getByTestId("hub-node-header")).toHaveTextContent("Sub");
		expect(getByTestId("hub-node-text")).toHaveTextContent("Body");
		expect(getByTestId("hub-node-badge")).toHaveTextContent("Beta");
		expect(getByTestId("hub-node-status")).toHaveTextContent("Running");
		expect(getByTestId("hub-node-kv")).toHaveTextContent("K");
		expect(getByTestId("hub-node-counter")).toHaveTextContent("3/9");
		expect(getByTestId("hub-node-divider")).toBeInTheDocument();
	});

	test("progress renders a percentage bar; list renders items + statuses", () => {
		const { getByTestId } = renderNodes([
			{ type: "progress", value: 40, label: "Loading" },
			{
				type: "list",
				items: [
					{ label: "step one", status: "completed", detail: "done at 9am", badge: "ok", badgeColor: "green" },
					{ label: "step two", status: "failed" },
				],
			},
		]);
		expect(getByTestId("hub-node-progress")).toHaveTextContent("40%");
		const list = getByTestId("hub-node-list");
		expect(list).toHaveTextContent("step one");
		expect(list).toHaveTextContent("done at 9am");
		expect(list).toHaveTextContent("✓");
		expect(list).toHaveTextContent("✗");
	});
});

describe("page-only nodes", () => {
	test("heading levels map to h1/h2/h3", () => {
		const { container } = renderNodes([
			{ type: "heading", level: 1, text: "One" },
			{ type: "heading", level: 2, text: "Two" },
			{ type: "heading", level: 3, text: "Three" },
		]);
		expect(container.querySelector("h1")).toHaveTextContent("One");
		expect(container.querySelector("h2")).toHaveTextContent("Two");
		expect(container.querySelector("h3")).toHaveTextContent("Three");
	});

	test("stats grid renders label/value/hint", () => {
		const { getByTestId } = renderNodes([
			{ type: "stats", items: [{ label: "Runs", value: "12", hint: "today" }] },
		]);
		const stats = getByTestId("hub-node-stats");
		expect(stats).toHaveTextContent("Runs");
		expect(stats).toHaveTextContent("12");
		expect(stats).toHaveTextContent("today");
	});

	test("empty-state renders title + detail", () => {
		const { getByTestId } = renderNodes([
			{ type: "empty-state", title: "Nothing", detail: "Try later" },
		]);
		expect(getByTestId("hub-node-empty-state")).toHaveTextContent("Nothing");
		expect(getByTestId("hub-node-empty-state")).toHaveTextContent("Try later");
	});

	test("section recurses into child nodes", () => {
		const { getAllByTestId } = renderNodes([
			{
				type: "section",
				title: "Outer",
				nodes: [{ type: "section", nodes: [{ type: "text", content: "deep" }] }],
			},
		]);
		const sections = getAllByTestId("hub-node-section");
		expect(sections).toHaveLength(2); // outer + nested
		expect(sections[0]).toHaveTextContent("Outer");
		expect(sections[0]).toHaveTextContent("deep");
	});
});

describe("markdown node", () => {
	test("renders markdown through the sanitizing pipeline (script stripped, markup kept)", () => {
		const { getByTestId } = renderNodes([
			{ type: "markdown", content: "**bold** <script>window.__pwned = true;</script>" },
		]);
		const md = getByTestId("hub-node-markdown");
		expect(md.querySelector("strong")).toHaveTextContent("bold");
		expect(md.innerHTML).not.toContain("<script>");
		expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
	});
});

describe("actions", () => {
	test("button click dispatches its action", async () => {
		const action = { event: "demo:refresh", payload: { a: 1 } };
		const { getByTestId, onAction } = renderNodes([
			{ type: "button", label: "Refresh", action },
		]);
		await fireEvent.click(getByTestId("hub-node-button"));
		expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
	});

	test("button with a prompt fires onAction with the prompt-bearing action (renderer doesn't open the dialog)", async () => {
		const action = {
			event: "add-watchlist",
			prompt: { label: "Topic to watch", field: "topic", maxLength: 120 },
		};
		const { getByTestId, onAction, queryByTestId } = renderNodes([
			{ type: "button", label: "Add to watchlist", action },
		]);
		await fireEvent.click(getByTestId("hub-node-button"));
		// The renderer just forwards the action — the HOST page route owns
		// the prompt dialog, so no dialog appears in the renderer's DOM.
		expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
		expect(queryByTestId("hub-prompt-dialog")).toBeNull();
	});

	test("button styles map to variants", () => {
		const { getAllByTestId } = renderNodes([
			{ type: "button", label: "P", action: { event: "e" } },
			{ type: "button", label: "D", action: { event: "e" }, style: "danger" },
			{ type: "button", label: "S", action: { event: "e" }, style: "secondary" },
		]);
		const [primary, danger, secondary] = getAllByTestId("hub-node-button");
		expect(primary!.className).toContain("--color-accent");
		expect(danger!.className).toContain("bg-red-600");
		expect(secondary!.className).toContain("border");
	});

	test("table row with action dispatches on click; plain rows don't", async () => {
		const action = { event: "demo:open" };
		const { getAllByTestId, onAction } = renderNodes([
			{
				type: "table",
				columns: ["A"],
				rows: [{ cells: ["actionable"], action }, { cells: ["plain"] }],
			},
		]);
		const rows = getAllByTestId("hub-table-row");
		await fireEvent.click(rows[0]!);
		await fireEvent.click(rows[1]!);
		expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
	});

	test("row with BOTH href and action: anchor click navigates only — no action dispatch (stopPropagation)", async () => {
		const action = { event: "demo:open" };
		const { getByTestId, getAllByTestId, onAction } = renderNodes([
			{
				type: "table",
				columns: ["A"],
				rows: [{ cells: ["both"], href: "/project/p/chat/c", action }],
			},
		]);
		// Clicking the ANCHOR must not bubble to the tr onclick — the
		// action would otherwise fire mid-navigation.
		await fireEvent.click(getByTestId("hub-row-link"));
		expect(onAction).not.toHaveBeenCalled();
		// Clicking the row OUTSIDE the anchor still dispatches the action.
		await fireEvent.click(getAllByTestId("hub-table-row")[0]!);
		expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
	});

	test("no onAction prop → clicks are inert (no crash)", async () => {
		const { getByTestId } = render(HubComponentRenderer, {
			props: { nodes: [{ type: "button", label: "X", action: { event: "e" } }] as PageNode[] },
		});
		await fireEvent.click(getByTestId("hub-node-button"));
	});
});

describe("links + href re-check", () => {
	test("safe link renders an anchor", () => {
		const { getByTestId } = renderNodes([
			{ type: "link", label: "Open", href: "/hub/core:briefing" },
		]);
		expect(getByTestId("hub-node-link")).toHaveAttribute("href", "/hub/core:briefing");
	});

	test("unsafe link hrefs are not rendered (defense-in-depth)", () => {
		const { queryByTestId } = renderNodes([
			{ type: "link", label: "Evil", href: "//evil.com" },
		]);
		expect(queryByTestId("hub-node-link")).toBeNull();
	});

	test("table row href renders the first cell as a link; unsafe hrefs degrade to text", () => {
		const { getAllByTestId, queryAllByTestId } = renderNodes([
			{
				type: "table",
				columns: ["T", "C"],
				rows: [
					{ cells: ["Linked", "x"], href: "/project/p/chat/c" },
					{ cells: ["Unsafe", "y"], href: "javascript:alert(1)" },
				],
			},
		]);
		const links = queryAllByTestId("hub-row-link");
		expect(links).toHaveLength(1);
		expect(links[0]).toHaveAttribute("href", "/project/p/chat/c");
		expect(getAllByTestId("hub-table-row")[1]).toHaveTextContent("Unsafe");
	});

	test("table renders column headers", () => {
		const { getByTestId } = renderNodes([
			{ type: "table", columns: ["Name", "When"], rows: [] },
		]);
		const table = getByTestId("hub-node-table");
		expect(table).toHaveTextContent("Name");
		expect(table).toHaveTextContent("When");
	});
});
