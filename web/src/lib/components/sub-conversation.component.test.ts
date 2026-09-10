import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import { tick } from "svelte";
import { subConversationStore } from "$lib/sub-conversation-store.svelte";
import SubConversationBlock from "./SubConversationBlock.svelte";
import SubConvoInput from "./SubConvoInput.svelte";

const conversation = { id: "child", agentName: "Research", agentConfigId: "agent" };
const messages = [
  { id: "question", role: "user", content: "Find the source", createdAt: new Date(0) },
  { id: "answer", role: "assistant", content: "The source is here", createdAt: new Date(1) },
];

afterEach(() => { cleanup(); subConversationStore.endSubConversation(); vi.unstubAllGlobals(); });

test("child input focuses, rejects blanks, preserves Shift+Enter, and sends trimmed text", async () => {
  const onSend = vi.fn();
  const ui = render(SubConvoInput, { conversationId: "child", onSend });
  const input = ui.getByRole("textbox");
  expect(input).toHaveFocus();
  expect(ui.getByRole("button", { name: "Send" })).toBeDisabled();
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  await fireEvent.input(input, { target: { value: " Follow up " } });
  await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(input).toHaveValue(" Follow up ");
  expect(onSend).not.toHaveBeenCalled();
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).toHaveBeenLastCalledWith("Follow up");
  expect(input).toHaveValue("");
  await fireEvent.input(input, { target: { value: " Another question " } });
  await fireEvent.click(ui.getByRole("button", { name: "Send" }));
  expect(onSend.mock.calls).toEqual([["Follow up"], ["Another question"]]);
});

test("active child displays messages, sends a reply, and blocks return while streaming", async () => {
  const onreturn = vi.fn();
  const onsend = vi.fn();
  const ui = render(SubConversationBlock, { conversation, messages, isActive: true, onreturn, onsend });
  expect(ui.getByText(/Find the source/)).toBeVisible();
  await fireEvent.click(ui.getByRole("button", { name: "@Research" }));
  expect(ui.getByText(/The source is here/)).toBeVisible();
  const input = ui.getByRole("textbox");
  await fireEvent.input(input, { target: { value: "Thanks" } });
  await fireEvent.click(ui.getByRole("button", { name: "Send" }));
  expect(onsend).toHaveBeenCalledWith("Thanks");
  subConversationStore.setStreaming(true);
  await tick();
  expect(ui.getByRole("button", { name: "Return to main" })).toBeDisabled();
  subConversationStore.setStreaming(false);
  await tick();
  await fireEvent.click(ui.getByRole("button", { name: "Return to main" }));
  expect(onreturn).toHaveBeenCalledOnce();
});

test("historical child loads messages once and uses the saved summary before expansion", async () => {
  let release!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const ui = render(SubConversationBlock, { conversation, messages: [], isActive: false, onreturn: vi.fn(), messageCount: 2, lastMessagePreview: "Saved answer" });
  expect(ui.getByText('2 messages -- "Saved answer"')).toBeVisible();
  await fireEvent.click(ui.getByRole("button", { name: /@Research/ }));
  expect(ui.getByText("Loading messages...")).toBeVisible();
  expect(fetch).toHaveBeenCalledWith("/api/conversations/child/messages?all=true");
  release(Response.json(messages));
  await waitFor(() => expect(ui.getByText(/The source is here/)).toBeVisible());
  expect(ui.queryByRole("button", { name: "Return to main" })).toBeNull();
  await fireEvent.click(ui.getByRole("button", { name: "@Research" }));
  await fireEvent.click(ui.getByRole("button", { name: /@Research/ }));
  expect(fetch).toHaveBeenCalledOnce();
  expect(ui.getByText(/The source is here/)).toBeVisible();
});

test.each([
  () => Promise.resolve(new Response(null, { status: 503 })),
  () => Promise.reject(new Error("Offline")),
])("historical child retries an unavailable history without dropping its fallback (%#)", async (failure) => {
  const fetch = vi.fn<() => Promise<Response>>().mockImplementationOnce(failure).mockResolvedValueOnce(Response.json(messages));
  vi.stubGlobal("fetch", fetch);
  const long = "A".repeat(90);
  const ui = render(SubConversationBlock, { conversation, messages: [{ ...messages[0]!, content: long }], isActive: false, onreturn: vi.fn() });
  expect(ui.getByText(`${"A".repeat(80)}...`)).toBeVisible();
  await fireEvent.click(ui.getByRole("button", { name: /@Research/ }));
  await waitFor(() => expect(ui.queryByText("Loading messages...")).toBeNull());
  expect(ui.getByText(long)).toBeVisible();
  await fireEvent.click(ui.getByRole("button", { name: "@Research" }));
  await fireEvent.click(ui.getByRole("button", { name: /@Research/ }));
  await waitFor(() => expect(ui.getByText(/The source is here/)).toBeVisible());
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("empty historical child has a clear summary", () => {
  const ui = render(SubConversationBlock, { conversation, messages: [], isActive: false, onreturn: vi.fn() });
  expect(ui.getByText("No messages yet")).toBeVisible();
});
