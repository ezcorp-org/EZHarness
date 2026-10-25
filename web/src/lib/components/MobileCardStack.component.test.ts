import "@testing-library/jest-dom/vitest";
import { render, within } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, test } from "vitest";
import MobileCardStack from "./MobileCardStack.svelte";

const columns = [
	{ key: "name", label: "Name" },
	{ key: "status", label: "Status", class: "font-mono" },
];
const rows = [
	{ id: "a", name: "Alpha", status: "running" },
	{ id: "b", name: "Beta", status: "idle" },
];

type CellArgs = { row: Record<string, unknown>; column: { key: string }; value: unknown };

const cell = createRawSnippet((args: () => CellArgs) => ({
	render: () => `<em data-testid="custom-cell">${args().column.key}=${String(args().value)}</em>`,
}));
const actions = createRawSnippet((args: () => { row: Record<string, unknown> }) => ({
	render: () => `<button data-testid="row-action">Open ${String(args().row.id)}</button>`,
}));

/** The table is the desktop layout and the card list the mobile one; CSS picks one, so both are in the DOM. */
function layouts(container: HTMLElement) {
	const table = container.querySelector("table");
	const cards = container.querySelector(".md\\:hidden");
	if (!table || !(cards instanceof HTMLElement)) throw new Error("both layouts must render");
	return { table, cards };
}

describe("MobileCardStack", () => {
	test("without snippets, both layouts print the raw values and no actions", () => {
		const { container } = render(MobileCardStack, { columns, rows });
		const { table, cards } = layouts(container);
		expect(within(table).getByText("Alpha")).toBeInTheDocument();
		expect(within(cards).getByText("idle")).toBeInTheDocument();
		expect(container.querySelector("[data-testid='row-action']")).toBeNull();
	});

	test("a cell snippet renders every value in both the table and the cards", () => {
		const { container } = render(MobileCardStack, { columns, rows, cell });
		const { table, cards } = layouts(container);
		for (const layout of [table, cards]) {
			const cells = within(layout).getAllByTestId("custom-cell").map((node) => node.textContent);
			expect(cells).toEqual(["name=Alpha", "status=running", "name=Beta", "status=idle"]);
		}
	});

	test("an actions snippet adds one action per row in both layouts", () => {
		const { container } = render(MobileCardStack, { columns, rows, actions });
		const { table, cards } = layouts(container);
		expect(within(table).getByText("Actions")).toBeInTheDocument();
		for (const layout of [table, cards]) {
			expect(within(layout).getAllByTestId("row-action").map((node) => node.textContent)).toEqual(["Open a", "Open b"]);
		}
	});
});
