import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { searchMentions } = vi.hoisted(() => ({ searchMentions: vi.fn() }));

vi.mock("$lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/api")>()),
	searchMentions,
}));
vi.mock("$lib/stores.svelte", () => ({ store: { activeProjectId: "project-1" } }));

import PanelChatInput from "./PanelChatInput.svelte";

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("PanelChatInput", () => {
	test("submits trimmed text from the real composer and clears it after success", async () => {
		const onsubmit = vi.fn(async () => {});
		render(PanelChatInput, { onsubmit });
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "  Inspect the failure  " } });
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(onsubmit).toHaveBeenCalledWith("Inspect the failure"));
		expect(input).toHaveValue("");
	});

	test("restores text and exposes the send error when the receiving panel rejects it", async () => {
		const onsubmit = vi.fn(async () => { throw new Error("Agent is unavailable"); });
		render(PanelChatInput, { onsubmit });
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "Retry this" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		await screen.findByText("Agent is unavailable");
		expect(input).toHaveValue("Retry this");
		expect(onsubmit).toHaveBeenCalledTimes(1);
	});

	test("searches mentions after its debounce and inserts the chosen token through keyboard navigation", async () => {
		vi.useFakeTimers();
		searchMentions.mockResolvedValueOnce([
			{ name: "Reviewer", description: "Checks changes", kind: "agent" },
		]);
		const onsubmit = vi.fn(async () => {});
		render(PanelChatInput, { onsubmit });
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "!agent:rev" } });
		await vi.advanceTimersByTimeAsync(200);
		await screen.findByRole("option", { name: /Reviewer/ });
		expect(searchMentions).toHaveBeenCalledWith("rev", "agent", "project-1");
		await fireEvent.keyDown(input, { key: "Enter" });
		// The composer keeps tokens compact in the DOM while preserving the
		// structured wire value that is sent to the parent.
		expect((input as HTMLTextAreaElement).value.trim()).toBe("!Reviewer");
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(onsubmit).toHaveBeenCalledWith("![agent:Reviewer]");
	});

	test("descends into a folder mention, then commits the folder as a structured path token", async () => {
		vi.useFakeTimers();
		searchMentions
			.mockResolvedValueOnce([{ name: "src", description: "Source folder", kind: "dir" }])
			.mockResolvedValueOnce([]);
		render(PanelChatInput, { onsubmit: vi.fn(async () => {}) });
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "@s" } });
		await vi.advanceTimersByTimeAsync(200);
		await screen.findByRole("option", { name: /src/ });
		await fireEvent.keyDown(input, { key: "Enter" });
		expect((input as HTMLTextAreaElement).value).toContain("@src/");
		await vi.advanceTimersByTimeAsync(200);
		await screen.findByRole("option", { name: /Use this folder as path/ });
		await fireEvent.keyDown(input, { key: "Enter" });
		await fireEvent.keyDown(input, { key: "Enter" });
		expect((input as HTMLTextAreaElement).value).toBe("");
	});

});
