/**
 * INTEGRATION (component) test for folding a chat TURN with the arrow keys.
 *
 * Mounts the REAL `<ChatThread variant="page">` and drives the REAL window
 * keydown handler, so it covers the whole path:
 *
 *   window keydown → handlePromptNavKey (ChatThread.svelte)
 *     → applyPromptNav (chat-prompt-nav.ts)      — which prompt do we land on
 *     → pushCollapse / popExpand (chat-turn-collapse.ts) — what folds
 *     → the render filter + <TurnCollapsedSummary>
 *
 * jsdom has no layout, so every rect is 0 and every prompt reads as "at or
 * above the fold" — the nav therefore steps from the last prompt backwards,
 * which is exactly the gesture under test. The scroll numbers are meaningless
 * here and nothing asserts on them; `ChatThread.prompt-nav.component.test.ts`
 * owns the geometry with a simulated layout.
 *
 * The module-stub block mirrors `ChatThread.prompt-nav.component.test.ts`.
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { tick } from "svelte";
import type { Message } from "$lib/api.js";

// ── Module stubs (load-time imports of the SUT graph) ────────────────

vi.mock("$lib/api.js", () => ({
  sendMessage: vi.fn(),
  updateConversation: vi.fn(async () => ({ id: "conv-1" })),
  createSubConversation: vi.fn(async () => ({ id: "sub-1", agentConfigId: "" })),
  cloneTurns: vi.fn(async () => ({ id: "x" })),
  setMessageExcluded: vi.fn(async () => undefined),
  fetchAllMessages: vi.fn(async () => []),
  patchMessageContent: vi.fn(async () => ({ content: "" })),
}));

vi.mock("$lib/oauth.js", () => ({
  startOAuthFlow: vi.fn(),
  completeOAuthWithCode: vi.fn(),
  isLoginCommand: () => null,
  listenForOAuthResult: vi.fn(() => () => {}),
}));

vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));

vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
  subConversationStore: {
    get activeSubConversation() {
      return null;
    },
    get isInSubConversation() {
      return false;
    },
    startSubConversation: vi.fn(),
    endSubConversation: vi.fn(() => []),
    addMessage: vi.fn(),
    setStreaming: vi.fn(),
  },
}));

vi.mock("$lib/mention-logic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/mention-logic.js")>();
  return { ...actual };
});

vi.mock("$lib/utils/fetch-policy.js", () => ({
  userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  backgroundFetch: vi.fn(async () => null),
  invalidate: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({
  page: {
    params: { id: "proj-1", convId: "conv-1" },
    url: new URL("http://localhost/"),
  },
}));

import ChatThread from "./ChatThread.svelte";

// ── Fixtures ─────────────────────────────────────────────────────────

/** `u*` ids are prompts; everything else answers the prompt above it. */
function chainOf(ids: string[]): Message[] {
  return ids.map(
    (id, i) =>
      ({
        id,
        conversationId: "conv-1",
        role: id.startsWith("u") ? "user" : "assistant",
        content: id.startsWith("u") ? `prompt-${id}` : `answer-${id}`,
        parentMessageId: i === 0 ? null : ids[i - 1]!,
        createdAt: `2026-01-01T00:00:0${i}.000Z`,
        excluded: false,
      }) as Message,
  );
}

/** Three turns, two replies each. */
const THREE_TURNS = ["u1", "a1a", "a1b", "u2", "a2a", "a2b", "u3", "a3a", "a3b"];

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  type AnyCtor = { new (...a: unknown[]): unknown };
  const g = globalThis as unknown as {
    IntersectionObserver?: AnyCtor;
    ResizeObserver?: AnyCtor;
  };
  if (typeof g.IntersectionObserver === "undefined") {
    g.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as AnyCtor;
  }
  if (typeof g.ResizeObserver === "undefined") {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as AnyCtor;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

function mountThread(ids = THREE_TURNS) {
  const tree = chainOf(ids);
  render(ChatThread, {
    conversationId: "conv-1",
    projectId: "proj-1",
    variant: "page" as const,
    seedMessages: tree,
    seedLeafId: tree[tree.length - 1]!.id,
    convListRefresh: () => {},
  });
  const container = document.querySelector<HTMLElement>('[data-testid="chat-messages-container"]')!;
  expect(container).toBeTruthy();
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.focus();
  return { container };
}

const rows = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll("[data-message-id]")).map(
    (n) => n.getAttribute("data-message-id") ?? "",
  );

const summaries = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="turn-collapsed-summary"]'));

// ── Tests ────────────────────────────────────────────────────────────

describe("ChatThread: ArrowLeft folds the turn it leaves behind", () => {
  test("every message renders expanded to start with", () => {
    const { container } = mountThread();
    expect(rows(container)).toEqual(THREE_TURNS);
    expect(summaries(container)).toHaveLength(0);
  });

  test("ArrowLeft hides the replies of the turn it left, keeping the prompt", async () => {
    const { container } = mountThread();
    press("ArrowLeft");
    await tick();
    await tick();

    // Landed on u2 → the turn left behind is u3, so u3's replies go.
    expect(rows(container)).toEqual(["u1", "a1a", "a1b", "u2", "a2a", "a2b", "u3"]);
    expect(rows(container)).toContain("u3");
    expect(rows(container)).not.toContain("a3a");
    expect(rows(container)).not.toContain("a3b");
  });

  test("the folded turn leaves exactly one summary row, reporting what it hides", async () => {
    const { container } = mountThread();
    press("ArrowLeft");
    await tick();
    await tick();

    const found = summaries(container);
    expect(found).toHaveLength(1);
    expect(found[0]!.textContent).toContain("2 replies");
    expect(found[0]!.getAttribute("aria-expanded")).toBe("false");
  });

  test("a second ArrowLeft folds the next turn back, stacking them", async () => {
    const { container } = mountThread();
    press("ArrowLeft");
    await tick();
    await tick();
    press("ArrowLeft");
    await tick();
    await tick();

    // Now on u1: u2 and u3 are both folded, both prompts still on screen.
    expect(rows(container)).toEqual(["u1", "a1a", "a1b", "u2", "u3"]);
    expect(summaries(container)).toHaveLength(2);
  });

  test("ArrowRight pops the last fold open again (exact inverse of ArrowLeft)", async () => {
    const { container } = mountThread();
    press("ArrowLeft");
    await tick();
    await tick();
    press("ArrowLeft");
    await tick();
    await tick();
    expect(rows(container)).toEqual(["u1", "a1a", "a1b", "u2", "u3"]);

    // The most recent fold was u2 → it unfolds first.
    press("ArrowRight");
    await tick();
    await tick();
    expect(rows(container)).toEqual(["u1", "a1a", "a1b", "u2", "a2a", "a2b", "u3"]);
    expect(summaries(container)).toHaveLength(1);

    // And again → back to the fully expanded thread we started from.
    press("ArrowRight");
    await tick();
    await tick();
    expect(rows(container)).toEqual(THREE_TURNS);
    expect(summaries(container)).toHaveLength(0);
  });

  test("clicking the summary row unfolds that turn", async () => {
    const { container } = mountThread();
    press("ArrowLeft");
    await tick();
    await tick();
    expect(summaries(container)).toHaveLength(1);

    summaries(container)[0]!.click();
    await tick();

    expect(rows(container)).toEqual(THREE_TURNS);
    expect(summaries(container)).toHaveLength(0);
  });

  test("a hand-unfolded turn is not re-opened by ArrowRight — it moves to the next one", async () => {
    const { container } = mountThread();
    press("ArrowLeft"); // folds u3
    await tick();
    await tick();
    press("ArrowLeft"); // folds u2
    await tick();
    await tick();

    // Open u2 with the mouse (the FIRST summary row belongs to u2, since
    // rows render top→bottom).
    summaries(container)[0]!.click();
    await tick();
    expect(rows(container)).toContain("a2a");

    // ArrowRight must skip the stale u2 entry and unfold u3 instead.
    press("ArrowRight");
    await tick();
    await tick();
    expect(rows(container)).toEqual(THREE_TURNS);
    expect(summaries(container)).toHaveLength(0);
  });

  test("ArrowLeft on the first prompt has no turn behind it to fold", async () => {
    // Two prompts: one ArrowLeft lands on u1 and folds u2; a second press
    // has nowhere to step, so nothing further folds.
    const { container } = mountThread(["u1", "a1a", "u2", "a2a"]);
    press("ArrowLeft");
    await tick();
    await tick();
    expect(summaries(container)).toHaveLength(1);

    press("ArrowLeft");
    await tick();
    await tick();
    expect(summaries(container)).toHaveLength(1);
    expect(rows(container)).toEqual(["u1", "a1a", "u2"]);
  });

  test("a conversation with a single turn never folds (nothing to step back to)", async () => {
    const { container } = mountThread(["u1", "a1a"]);
    press("ArrowLeft");
    await tick();
    await tick();
    expect(summaries(container)).toHaveLength(0);
    expect(rows(container)).toEqual(["u1", "a1a"]);
  });
});
