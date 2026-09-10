import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AgentSearchPicker from "../AgentSearchPicker.svelte";
import type { AgentConfig } from "$lib/api";

const agents: AgentConfig[] = [
	{
		id: "agent-a",
		name: "Agent A",
		description: "First agent",
		capabilities: [],
		prompt: "Inspect the task before making a change.",
		provider: "test-provider",
		model: "test-model",
		category: "engineering",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	} as AgentConfig,
];

const originalInnerHeight = window.innerHeight;

beforeEach(() => {
	Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ savedSearches: [], pinned: [] })));
});

function rect(top: number, bottom: number): DOMRect {
	return { x: 16, y: top, width: 320, height: bottom - top, top, right: 336, bottom, left: 16, toJSON: () => ({}) } as DOMRect;
}

async function openAt(top: number, bottom: number, dropdownHeight = 240) {
	render(AgentSearchPicker, { agents, onselect: vi.fn() });
	const input = screen.getByRole("combobox");
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this === input) return rect(top, bottom);
		if (this.hasAttribute("data-agent-picker-popover")) return rect(0, dropdownHeight);
		return rect(0, 0);
	});
	await fireEvent.focus(input);
	const listbox = await screen.findByRole("listbox");
	return listbox.parentElement?.parentElement as HTMLDivElement;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true });
});

describe("AgentSearchPicker desktop placement", () => {
	test("opens below an input when the list fits below it", async () => {
		const picker = await openAt(40, 80);
		await waitFor(() => expect(picker.style.top).toBe("82px"));
		expect(picker.style.bottom).toBe("");
	});

	test("opens above an input when the list would extend past the viewport", async () => {
		const picker = await openAt(560, 600);
		await waitFor(() => expect(picker.style.bottom).toBe("162px"));
		expect(picker.style.top).toBe("");
	});

	test("shows details and selects the keyboard-highlighted result", async () => {
		const onselect = vi.fn();
		render(AgentSearchPicker, { agents, onselect });
		const input = screen.getByRole("combobox");
		await fireEvent.focus(input);
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await screen.findByText("System Prompt");
		expect(screen.getByText("Inspect the task before making a change.")).toBeVisible();
		expect(screen.getByText("Provider: test-provider")).toBeVisible();
		expect(screen.getByText("Model: test-model")).toBeVisible();
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(onselect).toHaveBeenCalledWith(agents[0]);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	test("applies a saved search from the desktop picker", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ savedSearches: [{ query: "Agent", createdAt: 1 }], pinned: [] })));
		render(AgentSearchPicker, { agents, onselect: vi.fn() });
		const input = screen.getByRole("combobox");
		await fireEvent.focus(input);
		const savedSearch = await screen.findByText("Agent", { selector: "button", exact: true });
		await fireEvent.mouseDown(savedSearch);
		await waitFor(() => expect(input).toHaveValue("Agent"));
	});
});
