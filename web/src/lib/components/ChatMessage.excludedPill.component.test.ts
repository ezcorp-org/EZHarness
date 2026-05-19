/**
 * DOM tests for the "Excluded from chat context" pill on ChatMessage.
 *
 * Visibility rule:
 *   - role === "extension" && excluded === true  → pill renders.
 *   - any other combination                       → pill is absent.
 *
 * The pill is the explicit visual signal for extension-authored turns
 * that don't enter the LLM's context. Regular user/assistant turns
 * the user manually toggled off keep their existing strikethrough-only
 * treatment (the pill on every excluded row would be visual clutter for
 * the common case).
 */

import { render, cleanup } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import ChatMessage from "./ChatMessage.svelte";
import type { Message } from "$lib/api.js";

beforeEach(() => {
  // ChatMessage's $effect fires fetch-extension-toolbar; stub so
  // jsdom doesn't surface unhandled rejections during the test.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    role: "extension",
    content: "Synthesized audio",
    thinkingContent: null,
    model: null,
    provider: null,
    usage: null,
    runId: "run-1",
    parentMessageId: null,
    excluded: true,
    createdAt: "2026-05-04T00:00:00.000Z",
    ...overrides,
  };
}

describe('ChatMessage — "Excluded from chat context" pill', () => {
  test("renders for role='extension' + excluded=true", () => {
    const { getByTestId } = render(ChatMessage, {
      message: makeMessage({ role: "extension", excluded: true }),
      conversationId: "conv-1",
    });
    const pill = getByTestId("excluded-from-chat-pill");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/Excluded from chat context/i);
  });

  test("does NOT render for role='assistant' + excluded=true (regular toggled-off turns)", () => {
    const { queryByTestId } = render(ChatMessage, {
      message: makeMessage({ role: "assistant", excluded: true }),
      conversationId: "conv-1",
    });
    expect(queryByTestId("excluded-from-chat-pill")).toBeNull();
  });

  test("does NOT render for role='user' + excluded=true (regular toggled-off turns)", () => {
    const { queryByTestId } = render(ChatMessage, {
      message: makeMessage({ role: "user", excluded: true, content: "hi" }),
      conversationId: "conv-1",
    });
    expect(queryByTestId("excluded-from-chat-pill")).toBeNull();
  });

  test("does NOT render for role='extension' + excluded=false", () => {
    const { queryByTestId } = render(ChatMessage, {
      message: makeMessage({ role: "extension", excluded: false }),
      conversationId: "conv-1",
    });
    expect(queryByTestId("excluded-from-chat-pill")).toBeNull();
  });

  test("uses muted styling tokens (text-muted + border)", () => {
    const { getByTestId } = render(ChatMessage, {
      message: makeMessage({ role: "extension", excluded: true }),
      conversationId: "conv-1",
    });
    const pill = getByTestId("excluded-from-chat-pill");
    const cls = pill.getAttribute("class") ?? "";
    expect(cls).toContain("text-[var(--color-text-muted)]");
    expect(cls).toContain("border-[var(--color-border)]");
  });
});

describe("ChatMessage — extension-authored body suppression", () => {
  // Extension-authored rows (role === "extension") render only their
  // tool card(s); the synthetic header content the server emits as a
  // placeholder (e.g. kokoro-tts's `🔊 TTS of selection (N chars)`)
  // is NOT shown — the excluded-from-chat-context pill above the row
  // gives the user the same row-purpose cue without the visual noise
  // of duplicated text right next to the audio player.

  test("does NOT render the markdown body for role='extension'", () => {
    const synthetic = "🔊 TTS of selection (42 chars)";
    const { container } = render(ChatMessage, {
      message: makeMessage({ role: "extension", content: synthetic }),
      conversationId: "conv-1",
    });
    // The synthetic label must not appear anywhere in the rendered DOM
    // (neither as a text node nor inside the .excluded-prose wrapper).
    expect(container.textContent ?? "").not.toContain(synthetic);
    expect(container.querySelectorAll(".excluded-prose").length).toBe(0);
  });

  test("DOES render the markdown body for role='assistant' (regression guard)", () => {
    const body = "Hello from the assistant.";
    const { container } = render(ChatMessage, {
      message: makeMessage({
        role: "assistant",
        excluded: false,
        content: body,
      }),
      conversationId: "conv-1",
    });
    expect(container.textContent ?? "").toContain(body);
    // .excluded-prose is the wrapper class on the markdown render
    // path; one or more should be present for assistant rows.
    expect(container.querySelectorAll(".excluded-prose").length).toBeGreaterThan(0);
  });

  test("DOES render the markdown body for role='user' (regression guard)", () => {
    const body = "user said this";
    const { container } = render(ChatMessage, {
      message: makeMessage({
        role: "user",
        excluded: false,
        content: body,
      }),
      conversationId: "conv-1",
    });
    expect(container.textContent ?? "").toContain(body);
  });
});
