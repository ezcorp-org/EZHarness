/**
 * InlineToolCard dock-routing test.
 *
 * canvas-dock-sdk.md §5 component case (extend): when a complete tool call
 * has cardLayout="dock", InlineToolCard renders a DockOpenPill in place of
 * the full card. The dock auto-open ($effect with debounce) is exercised
 * separately in dock-store.test.ts; here we just lock the rendering branch.
 */
import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import { store } from "$lib/stores.svelte.js";
import InlineToolCard from "./InlineToolCard.svelte";
import type { InlineToolCall } from "$lib/inline-tool-store.svelte.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); store.dockState = {}; store.dismissedDocks = {}; });

function makeDockedCall(): InlineToolCall {
	return {
		id: "tc-inline-dock-1",
		extensionName: "claude-design",
		toolName: "claude-design__open-canvas",
		input: { draftId: "d-1" },
		status: "complete",
		retryCount: 0,
		conversationId: "conv-1",
		duration: 100,
		cardType: "design-canvas",
		cardLayout: "dock",
	};
}

describe("InlineToolCard — dock routing", () => {
	test('cardLayout="dock" + status="complete" → renders DockOpenPill, not the full card', () => {
		const { getByTestId, queryByText } = render(InlineToolCard, {
			call: makeDockedCall(),
			onretry: () => {},
			oneditretry: () => {},
			oncancel: () => {},
		});
		expect(getByTestId("dock-open-pill")).toBeInTheDocument();
		// The full-card "Running..." / "Failed" text shouldn't appear since
		// the pill replaces the entire card body.
		expect(queryByText(/Running\.\.\./)).toBeNull();
	});
});

function renderInline(overrides: Partial<InlineToolCall>, historical = false) {
  const call = { ...makeDockedCall(), cardType: undefined, cardLayout: undefined, ...overrides };
  const onretry = vi.fn();
  const oneditretry = vi.fn();
  const oncancel = vi.fn();
  return { ...render(InlineToolCard, { call, onretry, oneditretry, oncancel, historical, source: "agent" }), call, onretry, oneditretry, oncancel };
}

test("running tools update elapsed time and expose cancel and retry actions", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(100_000));
  const ui = renderInline({ status: "running", startedAt: 98_000 });
  expect(ui.getByText("Running... 2s")).toBeVisible();
  await vi.advanceTimersByTimeAsync(1000);
  expect(ui.getByText("Running... 3s")).toBeVisible();
  await fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  expect(ui.oncancel).toHaveBeenCalledWith(ui.call);
  await ui.rerender({ call: { ...ui.call, status: "error", error: "Offline", retryCount: 2 } });
  expect(ui.getByText("Failed after 2 retries")).toBeVisible();
  await fireEvent.click(ui.getByRole("button", { name: "Retry" }));
  await fireEvent.click(ui.getByRole("button", { name: "Edit & Retry" }));
  expect(ui.onretry).toHaveBeenCalledOnce();
  expect(ui.oneditretry).toHaveBeenCalledOnce();
  expect(ui.onretry.mock.calls[0]![0]).toMatchObject({ id: ui.call.id, error: "Offline" });
  await ui.rerender({ call: { ...ui.call, status: "error", error: "interrupted" } });
  expect(ui.getByText(/Interrupted/)).toBeVisible();
  expect(ui.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a live dock completion opens once after the debounce and does not reopen after dismissal", async () => {
  vi.useFakeTimers();
  const ui = renderInline({ status: "running", cardLayout: "dock", cardType: "design-canvas" });
  await ui.rerender({ call: { ...ui.call, status: "complete" } });
  await vi.advanceTimersByTimeAsync(499);
  expect(store.dockState[ui.call.conversationId]).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(store.dockState[ui.call.conversationId]?.toolCallId).toBe(ui.call.id);
  store.dockState = {};
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.dockState[ui.call.conversationId]).toBeUndefined();
});

test("unmount cancels a pending automatic dock open", async () => {
  vi.useFakeTimers();
  const ui = renderInline({ status: "running", cardLayout: "dock", cardType: "design-canvas" });
  await ui.rerender({ call: { ...ui.call, status: "complete" } });
  ui.unmount();
  await vi.advanceTimersByTimeAsync(500);
  expect(store.dockState[ui.call.conversationId]).toBeUndefined();
});

test("historical expansion fetches full output once and retains the visible result", async () => {
  let release!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const ui = renderInline({ output: "Short preview" }, true);
  const header = ui.getByRole("button", { expanded: false });
  await fireEvent.click(header);
  expect(ui.getByText("Loading...")).toBeVisible();
  expect(fetch).toHaveBeenCalledWith(`/api/tool-calls/${ui.call.id}/output`);
  release(Response.json({ output: { result: "Complete saved result" } }));
  await waitFor(() => expect(ui.getByText(/Complete saved result/)).toBeVisible());
  await fireEvent.click(header);
  await fireEvent.click(header);
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([false, true])("historical output failure preserves the saved preview (network=%s)", async (network) => {
  vi.stubGlobal("fetch", vi.fn(() => network ? Promise.reject(new Error("Offline")) : Promise.resolve(new Response(null, { status: 503 }))));
  const ui = renderInline({ output: "Retained preview" }, true);
  await fireEvent.click(ui.getByRole("button", { expanded: false }));
  await waitFor(() => expect(ui.queryByText("Loading...")).toBeNull());
  expect(ui.getAllByText(/Retained preview/).length).toBeGreaterThan(0);
});
