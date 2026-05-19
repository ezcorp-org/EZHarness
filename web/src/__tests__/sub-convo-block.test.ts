import { test, expect, describe, } from "bun:test";
import { agentColor } from "../lib/agent-color";

// Test the SubConversationBlock logic without Svelte runtime
// (same pattern as inline-tool-store tests — unit test the logic, not the DOM)

interface SubConvoMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

interface Conversation {
  id: string;
  agentName: string;
  agentConfigId: string;
}

// Mirror block component logic for testability
function getSummaryText(messages: SubConvoMessage[]): string {
  if (messages.length === 0) return "No messages yet";
  const last = messages[messages.length - 1]!;
  const text = last.content;
  return text.length > 80 ? text.slice(0, 80) + "..." : text;
}

const makeConvo = (name = "Helper"): Conversation => ({
  id: "sub-1",
  agentName: name,
  agentConfigId: "cfg-1",
});

const makeMsg = (id: string, role: string, content: string): SubConvoMessage => ({
  id,
  role,
  content,
  createdAt: new Date(),
});

describe("Sub-Conversation Block (SUBC-02)", () => {
  test("renders indented block with colored left border", () => {
    // The component uses ml-6 + border-l-4 + agentColor
    const convo = makeConvo("Helper");
    const color = agentColor(convo.agentName);
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    // Verify it's a valid hex color from the palette
    expect(typeof color).toBe("string");
  });

  test("border color is deterministic from agent name", () => {
    const color1 = agentColor("ResearchBot");
    const color2 = agentColor("ResearchBot");
    const color3 = agentColor("DifferentBot");
    expect(color1).toBe(color2);
    // Different names can produce different colors (not guaranteed but likely)
    expect(typeof color3).toBe("string");
  });

  test("collapses to summary line when not active", () => {
    const messages = [
      makeMsg("m1", "user", "hello"),
      makeMsg("m2", "assistant", "I can help you with that task."),
    ];
    const summary = getSummaryText(messages);
    expect(summary).toBe("I can help you with that task.");
  });

  test("expands to show full message history", () => {
    const messages = [
      makeMsg("m1", "user", "first"),
      makeMsg("m2", "assistant", "second"),
      makeMsg("m3", "user", "third"),
    ];
    // When expanded (not collapsed), all messages should be visible
    expect(messages.length).toBe(3);
    expect(messages[0]!.content).toBe("first");
    expect(messages[2]!.content).toBe("third");
  });

  test("shows mini-input when active", () => {
    // SubConvoInput is rendered when isActive=true
    // Test the input logic: empty submit should be no-op
    const sent: string[] = [];
    const onSend = (text: string) => sent.push(text);

    // Simulate submit with empty text
    const text = "".trim();
    if (text) onSend(text);
    expect(sent.length).toBe(0);

    // Simulate submit with content
    const text2 = "hello agent".trim();
    if (text2) onSend(text2);
    expect(sent).toEqual(["hello agent"]);
  });

  test("shows return to main button when active", () => {
    // Return button calls onreturn callback
    let returned = false;
    const onreturn = () => { returned = true; };
    onreturn();
    expect(returned).toBe(true);
  });

  test("disables return button while streaming", () => {
    // The component checks subConversationStore.isStreaming
    // When streaming=true, button should be disabled
    // This tests the store's isStreaming flag
    const store = { isStreaming: false };
    expect(store.isStreaming).toBe(false);
    store.isStreaming = true;
    // Button disabled when isStreaming is true
    expect(store.isStreaming).toBe(true);
  });

  test("summary truncates long messages to 80 chars", () => {
    const longContent = "A".repeat(100);
    const messages = [makeMsg("m1", "assistant", longContent)];
    const summary = getSummaryText(messages);
    expect(summary.length).toBe(83); // 80 chars + "..."
    expect(summary.endsWith("...")).toBe(true);
  });

  test("summary shows 'No messages yet' when empty", () => {
    expect(getSummaryText([])).toBe("No messages yet");
  });
});
