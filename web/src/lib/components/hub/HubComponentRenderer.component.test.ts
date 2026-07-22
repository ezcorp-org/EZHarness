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

	test("toned cells render their text + the matching status colour class; neutral stays plain", () => {
		const { getAllByTestId } = renderNodes([
			{
				type: "table",
				columns: ["Run", "Status"],
				rows: [
					{ cells: ["r1", { text: "failed", tone: "danger" }] },
					{ cells: ["r2", { text: "completed", tone: "success" }] },
					{ cells: ["r3", { text: "awaiting", tone: "warning" }] },
					{ cells: ["r4", "running"] },
				],
			},
		]);
		const cells = getAllByTestId("hub-table-cell");
		// Two cells per row, four rows → the status cell is every odd index.
		const status = [cells[1]!, cells[3]!, cells[5]!, cells[7]!];
		expect(status[0]).toHaveTextContent("failed");
		expect(status[0]).toHaveAttribute("data-tone", "danger");
		expect(status[0]!.querySelector("span")?.className).toContain("text-red-400");
		expect(status[1]).toHaveAttribute("data-tone", "success");
		expect(status[1]!.querySelector("span")?.className).toContain("text-green-400");
		expect(status[2]).toHaveAttribute("data-tone", "warning");
		expect(status[2]!.querySelector("span")?.className).toContain("text-yellow-400");
		// A plain-string cell is neutral: text present, no colour class.
		expect(status[3]).toHaveTextContent("running");
		expect(status[3]).toHaveAttribute("data-tone", "neutral");
		expect(status[3]!.querySelector("span")?.className).not.toContain("text-red-400");
	});

	test("a toned FIRST cell that is also a link renders its text through the anchor", () => {
		const { getByTestId } = renderNodes([
			{
				type: "table",
				columns: ["Run"],
				rows: [{ cells: [{ text: "run-1", tone: "danger" }], href: "/project/p/hub/x?run=run-1" }],
			},
		]);
		const link = getByTestId("hub-row-link");
		expect(link).toHaveTextContent("run-1");
		expect(link).toHaveAttribute("href", "/project/p/hub/x?run=run-1");
	});
});

describe("inline form node", () => {
	const FORM_NODE: PageNode = {
		type: "form",
		action: { event: "ecf:job-save", payload: { jobId: "default" } },
		fields: [
			{ field: "name", label: "Name", value: "Default", maxLength: 80 },
			{ field: "intent_template", label: "Intent", value: "keep api", maxLength: 500, multiline: true },
			{ field: "agent_name", label: "Agent", maxLength: 120 },
		],
		submitLabel: "Save job",
	};

	test("renders prefilled inputs, a textarea for multiline, and the submit label", () => {
		const { getByTestId } = renderNodes([FORM_NODE]);
		expect(getByTestId("hub-inline-form")).toBeInTheDocument();
		const name = getByTestId("hub-inline-field-name") as HTMLInputElement;
		expect(name.tagName).toBe("INPUT");
		expect(name.value).toBe("Default");
		expect(name).toHaveAttribute("maxlength", "80");
		const intent = getByTestId("hub-inline-field-intent_template") as HTMLTextAreaElement;
		expect(intent.tagName).toBe("TEXTAREA");
		expect(intent.value).toBe("keep api");
		expect(getByTestId("hub-inline-field-agent_name")).toHaveValue("");
		expect(getByTestId("hub-inline-form-submit")).toHaveTextContent("Save job");
	});

	test("submit merges EVERY field (typed, untouched, and cleared-to-empty) over the static payload", async () => {
		const { getByTestId, onAction } = renderNodes([FORM_NODE]);
		await fireEvent.input(getByTestId("hub-inline-field-name"), { target: { value: "Renamed" } });
		await fireEvent.input(getByTestId("hub-inline-field-intent_template"), { target: { value: "" } });
		await fireEvent.click(getByTestId("hub-inline-form-submit"));
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			event: "ecf:job-save",
			payload: {
				jobId: "default",
				name: "Renamed",
				intent_template: "",
				agent_name: "",
			},
		});
	});

	test("a confirm on the action rides the dispatched action (host confirm gates the save)", async () => {
		const withConfirm: PageNode = {
			...FORM_NODE,
			action: { event: "ecf:job-save", confirm: "Save all fields?" },
		} as PageNode;
		const { getByTestId, onAction } = renderNodes([withConfirm]);
		await fireEvent.click(getByTestId("hub-inline-form-submit"));
		expect(onAction.mock.calls[0]![0].confirm).toBe("Save all fields?");
	});

	test("submitLabel defaults to Save; in-progress typing survives a no-change re-render", async () => {
		const bare: PageNode = {
			type: "form",
			action: { event: "ecf:job-save" },
			fields: [{ field: "name", label: "Name", value: "Default" }],
		};
		const { getByTestId, rerender } = renderNodes([bare]);
		expect(getByTestId("hub-inline-form-submit")).toHaveTextContent("Save");
		await fireEvent.input(getByTestId("hub-inline-field-name"), { target: { value: "Mid-edit" } });
		// A re-pull that changes NOTHING (same prefill signature) must not
		// clobber the user's typing…
		await rerender({ nodes: [{ ...bare } as PageNode] });
		expect(getByTestId("hub-inline-field-name")).toHaveValue("Mid-edit");
		// …while a server-side prefill CHANGE (the save round-tripped, or a
		// concurrent edit) remounts with the fresh canonical value.
		await rerender({
			nodes: [
				{
					type: "form",
					action: { event: "ecf:job-save" },
					fields: [{ field: "name", label: "Name", value: "Server-truth" }],
				} as PageNode,
			],
		});
		expect(getByTestId("hub-inline-field-name")).toHaveValue("Server-truth");
	});
});

describe("inline form node without an onAction callback", () => {
	test("submit is a safe no-op (guard, no crash)", async () => {
		const { getByTestId } = render(HubComponentRenderer, {
			props: {
				nodes: [
					{
						type: "form",
						action: { event: "ecf:job-save" },
						fields: [{ field: "name", label: "Name", value: "Default" }],
					} as PageNode,
				],
			},
		});
		await fireEvent.click(getByTestId("hub-inline-form-submit"));
		expect(getByTestId("hub-inline-field-name")).toHaveValue("Default");
	});
});

describe("inline form select fields", () => {
	test("an options field renders a SELECT with the prefill chosen; changing it submits the picked value", async () => {
		const { getByTestId, onAction } = renderNodes([
			{
				type: "form",
				action: { event: "ecf:job-save", payload: { jobId: "default" } },
				fields: [
					{
						field: "trigger_kind",
						label: "Trigger",
						value: "push",
						options: [
							{ value: "push", label: "push — every matching git push" },
							{ value: "schedule", label: "schedule — on a cadence" },
							{ value: "manual" },
						],
					},
					{ field: "trigger_branch", label: "Branch", value: "main" },
				],
			} as PageNode,
		]);
		const select = getByTestId("hub-inline-field-trigger_kind") as HTMLSelectElement;
		expect(select.tagName).toBe("SELECT");
		expect(select.value).toBe("push");
		expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual([
			"push — every matching git push",
			"schedule — on a cadence",
			"manual",
		]);
		await fireEvent.change(select, { target: { value: "schedule" } });
		await fireEvent.click(getByTestId("hub-inline-form-submit"));
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			event: "ecf:job-save",
			payload: { jobId: "default", trigger_kind: "schedule", trigger_branch: "main" },
		});
	});
});

describe("inline form dynamic visibility (visibleWhen)", () => {
	const DYNAMIC_FORM: PageNode = {
		type: "form",
		action: { event: "ecf:job-save", payload: { jobId: "default" } },
		fields: [
			{
				field: "trigger_kind",
				label: "Trigger",
				value: "schedule",
				options: [{ value: "push" }, { value: "schedule" }, { value: "manual" }],
			},
			{ field: "trigger_branch", label: "Branch", value: "main" },
			{
				field: "trigger_every",
				label: "Cadence",
				value: "hourly",
				options: [{ value: "15m" }, { value: "hourly" }, { value: "daily" }],
				visibleWhen: { field: "trigger_kind", equals: "schedule" },
			},
		],
	};

	test("a conditional field shows/hides LIVE as its controlling select changes, keeping its value", async () => {
		const { getByTestId, queryByTestId } = renderNodes([DYNAMIC_FORM]);
		// Prefill kind=schedule → cadence visible.
		expect(getByTestId("hub-inline-field-trigger_every")).toHaveValue("hourly");
		// Flip to push → cadence disappears; unconditioned siblings stay.
		await fireEvent.change(getByTestId("hub-inline-field-trigger_kind"), { target: { value: "push" } });
		expect(queryByTestId("hub-inline-field-trigger_every")).toBeNull();
		expect(getByTestId("hub-inline-field-trigger_branch")).toBeInTheDocument();
		// Flip back → it returns with the retained value.
		await fireEvent.change(getByTestId("hub-inline-field-trigger_kind"), { target: { value: "schedule" } });
		expect(getByTestId("hub-inline-field-trigger_every")).toHaveValue("hourly");
	});

	test("a HIDDEN field is OMITTED from the submitted payload; visible it submits", async () => {
		const { getByTestId, onAction } = renderNodes([DYNAMIC_FORM]);
		await fireEvent.change(getByTestId("hub-inline-field-trigger_kind"), { target: { value: "manual" } });
		await fireEvent.click(getByTestId("hub-inline-form-submit"));
		expect(onAction).toHaveBeenNthCalledWith(1, {
			event: "ecf:job-save",
			payload: { jobId: "default", trigger_kind: "manual", trigger_branch: "main" },
		});
		expect(onAction.mock.calls[0]![0].payload).not.toHaveProperty("trigger_every");
		// Back to schedule → the cadence submits again.
		await fireEvent.change(getByTestId("hub-inline-field-trigger_kind"), { target: { value: "schedule" } });
		await fireEvent.click(getByTestId("hub-inline-form-submit"));
		expect(onAction).toHaveBeenNthCalledWith(2, {
			event: "ecf:job-save",
			payload: { jobId: "default", trigger_kind: "schedule", trigger_branch: "main", trigger_every: "hourly" },
		});
	});

	test("a one-of-array condition matches any listed value", async () => {
		const node: PageNode = {
			type: "form",
			action: { event: "ecf:job-save" },
			fields: [
				{ field: "mode", label: "Mode", value: "a", options: [{ value: "a" }, { value: "b" }, { value: "c" }] },
				{ field: "dep", label: "Dep", value: "x", visibleWhen: { field: "mode", equals: ["a", "b"] } },
			],
		};
		const { getByTestId, queryByTestId } = renderNodes([node]);
		expect(getByTestId("hub-inline-field-dep")).toBeInTheDocument();
		await fireEvent.change(getByTestId("hub-inline-field-mode"), { target: { value: "b" } });
		expect(getByTestId("hub-inline-field-dep")).toBeInTheDocument();
		await fireEvent.change(getByTestId("hub-inline-field-mode"), { target: { value: "c" } });
		expect(queryByTestId("hub-inline-field-dep")).toBeNull();
	});
});
