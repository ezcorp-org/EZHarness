/**
 * Sessions P5 — A/B retry affordance wiring in <ChatThread>.
 *
 * The A/B retry drives the CLEAN /retry endpoint (Wave-6): it forks a same-role
 * assistant SIBLING from the target's parent user turn WITHOUT duplicating that
 * user row — distinct from `handleRegenerate`'s editOf path (which forks a new
 * user turn too). The only new UI surface is a flag-gated, run-blocked "Retry"
 * affordance in the assistant-row A/B controls (next to the ‹n/m› switcher).
 * Covers: shown when the `sessions:historyProducer` flag is ON; clicking it
 * calls `retryMessage(convId, assistantId)` (NOT `sendMessage(editOf)`) so the
 * siblings are same-role; hidden when the flag is OFF.
 *
 * vitest + jsdom + @testing-library/svelte. Scaffolding mirrors
 * ChatThread.rewind.component.test.ts.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";

interface TreeResult {
  enabled: boolean;
  tree: { conversationId: string; currentLeaf: string | null; nodes: unknown[] } | null;
}

const {
  sendMessageMock,
  retryMessageMock,
  fetchAllMessagesMock,
  fetchConversationTreeMock,
  userFetchMock,
} = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async (_c: string, d: { content: string; editOf?: string }) => ({
    userMessage: {
      id: "srv-1",
      conversationId: "conv-1",
      role: "user",
      content: d.content,
      createdAt: new Date().toISOString(),
      parentMessageId: null,
      excluded: false,
    },
    runId: "run-ab",
    attachments: [] as unknown[],
    ezActionResults: [] as unknown[],
  })),
  // The clean /retry: returns the EXISTING user turn as the anchor (no new
  // row), a runId to stream, and the id of the assistant being retried.
  retryMessageMock: vi.fn(
    async (
      _c: string,
      messageId: string,
      _opts?: { provider?: string; model?: string; thinkingLevel?: string },
    ) => ({
      userMessage: {
        id: "u1",
        conversationId: "conv-1",
        role: "user",
        content: "the prompt",
        createdAt: "2026-01-01T00:00:01.000Z",
        parentMessageId: null,
        excluded: false,
      },
      retriedMessageId: messageId,
      runId: "run-ab",
    }),
  ),
  fetchAllMessagesMock: vi.fn(async () => [] as Message[]),
  // Controllable so the "Retry with…" menu's lazy /api/models fetch can be
  // driven per test. Defaults to the empty envelope the rest of the file relies on.
  userFetchMock: vi.fn(async (_url: string) => ({ ok: true, json: async () => ({}) as unknown })),
  fetchConversationTreeMock: vi.fn(
    async (): Promise<TreeResult> => ({
      enabled: true,
      tree: { conversationId: "conv-1", currentLeaf: "a1", nodes: [] },
    }),
  ),
}));

vi.mock("$app/state", () => ({
  page: {
    params: { id: "proj-1", convId: "conv-1" },
    url: new URL("http://localhost/project/proj-1/chat/conv-1"),
  },
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/environment", () => ({ browser: true, dev: false, building: false, version: "t" }));
vi.mock("$lib/oauth.js", () => ({
  listenForOAuthResult: vi.fn(() => () => {}),
  startOAuthFlow: vi.fn(),
  completeOAuthWithCode: vi.fn(),
  isLoginCommand: () => null,
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/mention-logic.js")>();
  return { ...actual };
});
vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
  subConversationStore: {
    get activeSubConversation() {
      return null;
    },
    get isInSubConversation() {
      return false;
    },
    get activeSubConversationId() {
      return null;
    },
    get subConvoMessages() {
      return [];
    },
    startSubConversation: vi.fn(),
    endSubConversation: vi.fn(() => []),
    addMessage: vi.fn(),
    setStreaming: vi.fn(),
  },
}));
vi.mock("$lib/utils/fetch-policy.js", () => ({
  userFetch: userFetchMock,
  backgroundFetch: vi.fn(async () => null),
  invalidate: vi.fn(),
}));
vi.mock("$lib/api.js", () => ({
  sendMessage: sendMessageMock,
  retryMessage: retryMessageMock,
  fetchAllMessages: fetchAllMessagesMock,
  fetchConversationTree: fetchConversationTreeMock,
  updateConversation: vi.fn(async (id: string) => ({ id })),
  createSubConversation: vi.fn(async () => ({ id: "s", agentConfigId: "" })),
  cloneTurns: vi.fn(),
  setMessageExcluded: vi.fn(async (_c: string, id: string, ex: boolean) => ({ id, excluded: ex })),
  fetchModes: vi.fn(async () => []),
  createConversation: vi.fn(),
  patchMessageContent: vi.fn(async (_c: string, _i: string, content: string) => ({ content })),
}));

import ChatThread from "./ChatThread.svelte";

function msg(id: string, o: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: "conv-1",
    role: "user",
    content: `c-${id}`,
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    parentMessageId: null,
    excluded: false,
    ...o,
  } as Message;
}
function seed(): Message[] {
  return [
    msg("u1", { role: "user", content: "the prompt", createdAt: "2026-01-01T00:00:01.000Z" }),
    msg("a1", {
      role: "assistant",
      parentMessageId: "u1",
      content: "first answer",
      createdAt: "2026-01-01T00:00:02.000Z",
    }),
  ];
}
function mount() {
  return render(ChatThread, {
    conversationId: "conv-1",
    projectId: "proj-1",
    seedMessages: seed(),
    seedLeafId: "a1",
  });
}

beforeEach(() => {
  sendMessageMock.mockClear();
  retryMessageMock.mockClear();
  fetchConversationTreeMock.mockClear();
  userFetchMock.mockClear();
  userFetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({}) as unknown }));
  fetchConversationTreeMock.mockResolvedValue({
    enabled: true,
    tree: { conversationId: "conv-1", currentLeaf: "a1", nodes: [] },
  });
  type C = { new (...a: unknown[]): unknown };
  const g = globalThis as unknown as { IntersectionObserver?: C; ResizeObserver?: C };
  if (typeof g.IntersectionObserver === "undefined")
    g.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as C;
  if (typeof g.ResizeObserver === "undefined")
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as C;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe("ChatThread A/B retry affordance (Sessions P5)", () => {
  test("flag ON → assistant row shows Retry; clicking forks a same-role sibling via the clean /retry endpoint", async () => {
    const { container } = mount();
    const btn = await vi.waitFor(() => {
      const el = container.querySelector('[data-testid="ab-retry-btn"]');
      if (!el) throw new Error("retry button not yet rendered");
      return el as HTMLButtonElement;
    });
    await fireEvent.click(btn);
    await vi.waitFor(() => expect(retryMessageMock).toHaveBeenCalled());
    // The clean /retry re-runs the ASSISTANT message's parent user turn —
    // the endpoint takes the assistant id (a1) and the server anchors on the
    // existing user row, so no duplicate user turn is created.
    const [convId, messageId] = retryMessageMock.mock.calls[0]!;
    expect(convId).toBe("conv-1");
    expect(messageId).toBe("a1");
    // Crucially NOT the editOf duplicate-prompt path — same-role siblings now.
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("flag OFF → the Retry affordance is never rendered", async () => {
    fetchConversationTreeMock.mockResolvedValue({ enabled: false, tree: null });
    const { container } = mount();
    await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="ab-retry-btn"]')).toBeNull();
  });
});

/**
 * WS7 — "Retry with…": the same clean /retry fork, against a model the user
 * picks. The route ALREADY accepted a provider/model override; only the
 * affordance was missing, and it is the most informative routing signal the
 * product can produce (one user turn, two models, the prompt held constant).
 *
 * The plain one-click Retry is deliberately left intact — "Current chat model"
 * in the menu is that same behaviour — so the tests above still describe the
 * shipped default path.
 */
describe("ChatThread 'Retry with…' model picker (WS7)", () => {
  const MODELS = [
    {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tier: "fast",
      costTier: "low",
      available: true,
      displayName: "Haiku 4.5",
    },
    {
      provider: "anthropic",
      model: "claude-opus-4-5",
      tier: "powerful",
      costTier: "high",
      available: true,
      displayName: "Opus 4.5",
    },
    {
      provider: "openai",
      model: "gpt-unavailable",
      tier: "balanced",
      costTier: "medium",
      available: false,
    },
  ];

  function serveModels() {
    userFetchMock.mockImplementation(async (url: string) =>
      url === "/api/models"
        ? { ok: true, json: async () => MODELS as unknown }
        : { ok: true, json: async () => ({}) as unknown },
    );
  }

  async function openMenu(container: HTMLElement) {
    const caret = await vi.waitFor(() => {
      const el = container.querySelector('[data-testid="ab-retry-with-btn"]');
      if (!el) throw new Error("caret not yet rendered");
      return el as HTMLButtonElement;
    });
    await fireEvent.click(caret);
    return vi.waitFor(() => {
      const menu = container.querySelector('[data-testid="ab-retry-model-menu"]');
      if (!menu) throw new Error("menu not open");
      return menu as HTMLElement;
    });
  }

  test("the model list is fetched LAZILY — not until the menu is opened", async () => {
    serveModels();
    const { container } = mount();
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="ab-retry-with-btn"]')) throw new Error("not yet");
    });
    // A thread renders many assistant rows; fetching per row on mount would be
    // one /api/models request each.
    expect(userFetchMock.mock.calls.some(([url]) => url === "/api/models")).toBe(false);
    await openMenu(container);
    expect(userFetchMock.mock.calls.some(([url]) => url === "/api/models")).toBe(true);
  });

  test("picking a model retries with THAT model, tier-grouped and availability-filtered", async () => {
    serveModels();
    const { container } = mount();
    const menu = await openMenu(container);
    await vi.waitFor(() => {
      if (menu.querySelectorAll('[data-testid="ab-retry-model-option"]').length === 0) {
        throw new Error("options not yet rendered");
      }
    });
    const options = Array.from(menu.querySelectorAll('[data-testid="ab-retry-model-option"]'));
    // Unavailable models are filtered out; the strongest tier leads.
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toContain("Opus 4.5");
    expect(menu.textContent).not.toContain("gpt-unavailable");

    await fireEvent.click(options[0]! as HTMLButtonElement);
    await vi.waitFor(() => expect(retryMessageMock).toHaveBeenCalled());
    const [convId, messageId, opts] = retryMessageMock.mock.calls[0]!;
    expect(convId).toBe("conv-1");
    expect(messageId).toBe("a1");
    expect(opts).toMatchObject({ provider: "anthropic", model: "claude-opus-4-5" });
    // The menu closes on pick.
    expect(container.querySelector('[data-testid="ab-retry-model-menu"]')).toBeNull();
  });

  test("'Current chat model' is the plain retry — no model override on the wire", async () => {
    serveModels();
    const { container } = mount();
    const menu = await openMenu(container);
    const current = menu.querySelector(
      '[data-testid="ab-retry-model-current"]',
    ) as HTMLButtonElement;
    expect(current).not.toBeNull();
    await fireEvent.click(current);
    await vi.waitFor(() => expect(retryMessageMock).toHaveBeenCalled());
    const [, , opts] = retryMessageMock.mock.calls[0]!;
    // The thread has no explicit selection in this harness, so the wire model
    // resolves to undefined — i.e. exactly the pre-WS7 one-click Retry.
    expect(opts?.model).toBeUndefined();
  });

  test("a failed model list still offers the plain retry", async () => {
    userFetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    const { container } = mount();
    const menu = await openMenu(container);
    expect(menu.querySelectorAll('[data-testid="ab-retry-model-option"]')).toHaveLength(0);
    await fireEvent.click(
      menu.querySelector('[data-testid="ab-retry-model-current"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(retryMessageMock).toHaveBeenCalled());
  });

  test("a non-array payload degrades to an empty list instead of throwing", async () => {
    userFetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ error: "nope" }) as unknown,
    }));
    const { container } = mount();
    const menu = await openMenu(container);
    expect(menu.querySelectorAll('[data-testid="ab-retry-model-option"]')).toHaveLength(0);
  });

  test("the caret toggles the menu shut again", async () => {
    serveModels();
    const { container } = mount();
    await openMenu(container);
    await fireEvent.click(
      container.querySelector('[data-testid="ab-retry-with-btn"]') as HTMLButtonElement,
    );
    expect(container.querySelector('[data-testid="ab-retry-model-menu"]')).toBeNull();
  });

  test("Escape closes the menu", async () => {
    serveModels();
    const { container } = mount();
    await openMenu(container);
    await fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="ab-retry-model-menu"]')).toBeNull(),
    );
  });

  test("flag OFF → no caret either", async () => {
    fetchConversationTreeMock.mockResolvedValue({ enabled: false, tree: null });
    const { container } = mount();
    await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="ab-retry-with-btn"]')).toBeNull();
  });
});
