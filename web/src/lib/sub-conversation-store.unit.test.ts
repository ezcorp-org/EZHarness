import { afterEach, expect, test } from "vitest";
import { subConversationStore as store } from "./sub-conversation-store.svelte";

afterEach(() => { store.endSubConversation(); });

test("keeps child messages in order and returns them when leaving the child", () => {
  expect(store.isInSubConversation).toBe(false);
  expect(store.activeSubConversationId).toBeNull();
  const conversation = {
    id: "child", agentConfigId: "agent", agentName: "Research",
    parentConversationId: "parent", parentMessageId: "parent-message",
  };
  store.startSubConversation(conversation);
  expect(store.activeSubConversation).toEqual(conversation);
  expect(store.activeSubConversationId).toBe("child");
  expect(store.isInSubConversation).toBe(true);
  const messages = [
    { id: "user", role: "user", content: "Investigate", createdAt: new Date(0) },
    { id: "reply", role: "assistant", content: "Found it", createdAt: new Date(1) },
  ];
  store.addMessage(messages[0]!);
  store.setStreaming(true);
  expect(store.isStreaming).toBe(true);
  store.addMessage(messages[1]!);
  expect(store.subConvoMessages).toEqual(messages);
  expect(store.endSubConversation()).toEqual(messages);
  expect(store.activeSubConversation).toBeNull();
  expect(store.subConvoMessages).toEqual([]);
  expect(store.isStreaming).toBe(false);
});

test("starting another child clears the previous messages and streaming state", () => {
  store.addMessage({ id: "old", role: "user", content: "Old task", createdAt: new Date(0) });
  store.setStreaming(true);
  store.startSubConversation({ id: "new", agentConfigId: "agent", agentName: "New task", parentConversationId: "parent", parentMessageId: "message" });
  expect(store.activeSubConversationId).toBe("new");
  expect(store.subConvoMessages).toEqual([]);
  expect(store.isStreaming).toBe(false);
});
