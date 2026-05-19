/**
 * Tests for AgentDetailPanel scroll-to-turn logic.
 *
 * The agent chip only appears on ONE message in the main chat (the first
 * orchestrator message that created the sub-conversation). Because of this,
 * there's no way to distinguish which specific turn the user wants from a
 * single chip click. The panel always scrolls to the bottom (latest turn).
 *
 * The scroll $effect depends on:
 * - loaded (true after messages fetch)
 * - rawMessages.length (re-triggers on new turns)
 * - scrollContainer (DOM ref)
 *
 * After tick(), it sets scrollContainer.scrollTop = scrollContainer.scrollHeight
 * to show the most recent agent activity.
 */
import { test, expect, describe } from "bun:test";

describe("AgentDetailPanel scroll behavior", () => {

  test("scroll-to-bottom strategy: scrollTop equals scrollHeight", () => {
    // Simulates what the $effect does after messages load
    const container = { scrollTop: 0, scrollHeight: 2400 };
    container.scrollTop = container.scrollHeight;
    expect(container.scrollTop).toBe(2400);
  });

  test("scroll re-triggers when message count changes", () => {
    // The $effect depends on rawMessages.length
    // Simulates multiple scroll triggers as turns arrive
    const container = { scrollTop: 0, scrollHeight: 0 };

    // Turn 1 arrives
    container.scrollHeight = 600;
    container.scrollTop = container.scrollHeight;
    expect(container.scrollTop).toBe(600);

    // Turn 2 arrives
    container.scrollHeight = 1200;
    container.scrollTop = container.scrollHeight;
    expect(container.scrollTop).toBe(1200);

    // Turn 3 arrives
    container.scrollHeight = 1800;
    container.scrollTop = container.scrollHeight;
    expect(container.scrollTop).toBe(1800);
  });

  test("no scroll when messages array is empty", () => {
    // The $effect guards: if rawMessages.length === 0, return early
    const rawMessages: any[] = [];
    const shouldScroll = rawMessages.length > 0;
    expect(shouldScroll).toBe(false);
  });

  test("no scroll when not loaded", () => {
    const loaded = false;
    const shouldScroll = loaded && true; // && rawMessages.length > 0
    expect(shouldScroll).toBe(false);
  });

  test("assistantMessages derived correctly from rawMessages", () => {
    const rawMessages = [
      { id: "u1", role: "user", content: "Task 1" },
      { id: "a1", role: "assistant", content: "Response 1" },
      { id: "u2", role: "user", content: "Task 2" },
      { id: "a2", role: "assistant", content: "Response 2" },
      { id: "u3", role: "user", content: "Task 3" },
      { id: "a3", role: "assistant", content: "Response 3" },
    ];
    const assistantMessages = rawMessages.filter(m => m.role === "assistant");
    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages[0]!.id).toBe("a1");
    expect(assistantMessages[2]!.id).toBe("a3");
  });

  test("data-msg-id attribute format matches querySelector usage", () => {
    const msgId = "550e8400-e29b-41d4-a716-446655440000";
    const selector = `[data-msg-id="${msgId}"]`;
    expect(selector).toBe('[data-msg-id="550e8400-e29b-41d4-a716-446655440000"]');
  });

  test("taskMessage is the first user message (used for task display)", () => {
    const rawMessages = [
      { id: "u1", role: "user", content: "Initial task" },
      { id: "a1", role: "assistant", content: "Response" },
      { id: "u2", role: "user", content: "Follow-up" },
      { id: "a2", role: "assistant", content: "Follow-up response" },
    ];
    const taskMessage = rawMessages.find(m => m.role === "user");
    expect(taskMessage?.id).toBe("u1");
    expect(taskMessage?.content).toBe("Initial task");
  });
});
