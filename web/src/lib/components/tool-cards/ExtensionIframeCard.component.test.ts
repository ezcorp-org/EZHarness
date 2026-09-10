import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolCallState } from "$lib/stores.svelte.js";
import ExtensionIframeCardHarness from "./ExtensionIframeCardHarness.svelte";

const toolCall = { id: "call-1", status: "complete", error: null } as unknown as ToolCallState;

afterEach(() => vi.unstubAllGlobals());

describe("ExtensionIframeCard DOM behavior", () => {
	test("renders only a same-origin sandboxed preview and clears loading on frame load", async () => {
		render(ExtensionIframeCardHarness, { toolCall });
		const frame = screen.getByTitle("Weather preview");
		expect(frame).toHaveAttribute("src", "/api/extensions/weather/preview");
		expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		expect(screen.getByText("Loading preview…")).toBeInTheDocument();
		await fireEvent.load(frame);
		expect(screen.queryByText("Loading preview…")).toBeNull();
	});

	test("refuses unsafe URLs and displays a tool failure without creating a frame", () => {
		const unsafe = render(ExtensionIframeCardHarness, { toolCall, iframeSrc: "https://example.test/x" });
		expect(screen.getByRole("alert")).toHaveTextContent("Cross-origin iframe URLs are not allowed");
		expect(screen.queryByTitle("Weather preview")).toBeNull();
		unsafe.unmount();
		render(ExtensionIframeCardHarness, { toolCall: { ...toolCall, status: "error", error: "Build failed" } });
		expect(screen.getByRole("alert")).toHaveTextContent("Tool error: Build failed");
	});

	test("reports iframe load errors and reloads a changed safe URL", async () => {
		const { rerender } = render(ExtensionIframeCardHarness, { toolCall });
		const firstFrame = screen.getByTitle("Weather preview");
		await fireEvent.error(firstFrame);
		expect(screen.getByRole("alert")).toHaveTextContent("Failed to load preview content");
		await rerender({ iframeSrc: "/api/extensions/weather/data/revised.html" });
		await waitFor(() => expect(screen.getByText("Loading preview…")).toBeInTheDocument());
		expect(screen.getByTitle("Weather preview")).toHaveAttribute("src", "/api/extensions/weather/data/revised.html");
	});

	test("posts sidebar events with the conversation and tool-call boundary data", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		render(ExtensionIframeCardHarness, { toolCall });
		await fireEvent.click(screen.getByTestId("post-preview-event"));
		await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/extensions/weather/events/refresh",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetchSpy.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({
			location: "Boston", toolCallId: "call-1", conversationId: "conversation-1",
		});
	});

	test("surfaces a rejected sidebar event and returns controls to an enabled state", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Event denied" }), { status: 403 })));
		render(ExtensionIframeCardHarness, { toolCall, mode: "dock" });
		const button = screen.getByTestId("post-preview-event");
		expect(button).not.toBeDisabled();
		await fireEvent.click(button);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Event denied"));
		expect(button).not.toBeDisabled();
		expect(screen.getByTestId("post-preview-event").closest(".extension-iframe-card")).toHaveAttribute("data-mode", "dock");
	});
});
