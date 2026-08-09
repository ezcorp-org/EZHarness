/**
 * Component tests for the per-conversation project badge in the Cmd+K
 * cross-project message-search results.
 *
 * Each search-result conversation group renders a right-aligned project badge:
 * the project's logo image when set, else a colored-initial avatar (ProjectRail
 * parity), so users can tell at a glance which project a chat belongs to. The
 * icon is joined from `store.projects` by the hit's `projectId`; this harness
 * mocks that store so a known logo/fallback pair is exercised.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MessageSearchHit } from "$lib/api.js";

// --- $page store (pathname "/" → no context filtering) ---
vi.mock("$app/stores", () => {
  let listeners: ((v: { url: { pathname: string } }) => void)[] = [];
  const value = { url: { pathname: "/" } };
  return {
    page: {
      subscribe(fn: (v: typeof value) => void) {
        listeners.push(fn);
        fn(value);
        return () => {
          listeners = listeners.filter((l) => l !== fn);
        };
      },
    },
  };
});

const { gotoMock, searchMessagesMock } = vi.hoisted(() => ({
  gotoMock: vi.fn(),
  searchMessagesMock: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: gotoMock }));

vi.mock("$lib/api.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, searchMessages: searchMessagesMock };
});

// A project `icon` is an image URL / data-URI (NOT an emoji). projA carries a
// logo image, projB has none (→ colored-initial avatar). projC is deliberately
// ABSENT from the store to exercise the "project not in store" fallback.
// Hoisted so the (hoisted) vi.mock factory below can reference it.
const { LOGO_SRC } = vi.hoisted(() => ({
  LOGO_SRC:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
}));

vi.mock("$lib/stores.svelte.js", () => ({
  store: {
    activeProjectId: "projA",
    projects: [
      {
        id: "projA",
        name: "Alpha",
        path: "",
        icon: LOGO_SRC,
        variables: {},
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "projB",
        name: "Beta",
        path: "",
        icon: null,
        variables: {},
        createdAt: "",
        updatedAt: "",
      },
    ],
  },
}));

import CommandPalette from "$lib/components/CommandPalette.svelte";

function hit(o: {
  projectId: string;
  projectName: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
}): MessageSearchHit {
  return {
    role: "user",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    snippet: "hello <mark>world</mark>",
    matchType: "both",
    rankLexical: 1,
    rankSemantic: 1,
    score: 1,
    ...o,
  } as MessageSearchHit;
}

function setHits(hits: MessageSearchHit[]) {
  searchMessagesMock.mockResolvedValue({
    hits,
    degraded: false,
    requestedMode: "hybrid",
    servedMode: "hybrid",
  });
}

function renderPalette() {
  return render(CommandPalette, {
    props: {
      open: true,
      onclose: () => {},
      activeProjectId: "projA",
      // No active conversation → single flat "Messages" section.
      activeConversationId: null,
    },
  });
}

async function type(container: HTMLElement, value: string) {
  const input = container.querySelector("input[type=text]") as HTMLInputElement;
  await fireEvent.input(input, { target: { value } });
  return input;
}

function badges(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[data-testid="palette-project-badge"]')] as HTMLElement[];
}

function badgeFor(container: HTMLElement, projectName: string): HTMLElement {
  const badge = badges(container).find((b) => (b.textContent ?? "").includes(projectName));
  if (!badge) {
    throw new Error(
      `project badge for "${projectName}" not found; have: ${badges(container)
        .map((b) => (b.textContent ?? "").trim())
        .join(" | ")}`,
    );
  }
  return badge;
}

beforeEach(() => {
  gotoMock.mockClear();
  searchMessagesMock.mockClear();
});

describe("CommandPalette — search-result project badge", () => {
  test("a project with a logo renders its icon image in the conversation badge", async () => {
    setHits([
      hit({
        projectId: "projA",
        projectName: "Alpha",
        conversationId: "conv-a",
        conversationTitle: "Alpha Chat",
        messageId: "m-a",
      }),
    ]);
    const { container } = renderPalette();
    await type(container, "wor");
    await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
    await waitFor(() => expect(badges(container).length).toBeGreaterThan(0));

    const badge = badgeFor(container, "Alpha");
    const img = badge.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(LOGO_SRC);
    expect(img?.getAttribute("alt")).toBe("Alpha");
    expect(badge.getAttribute("title")).toBe("Alpha");
  });

  test("a project without a logo falls back to the colored-initial avatar", async () => {
    setHits([
      hit({
        projectId: "projB",
        projectName: "Beta",
        conversationId: "conv-b",
        conversationTitle: "Beta Chat",
        messageId: "m-b",
      }),
    ]);
    const { container } = renderPalette();
    await type(container, "wor");
    await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
    await waitFor(() => expect(badges(container).length).toBeGreaterThan(0));

    const badge = badgeFor(container, "Beta");
    // No image — instead the project's first initial in a colored circle.
    expect(badge.querySelector("img")).toBeNull();
    const avatar = badge.querySelector('[data-testid="palette-project-avatar"]');
    expect(avatar?.textContent?.trim()).toBe("B");
  });

  test("a hit whose project is absent from the store falls back to the initial avatar", async () => {
    setHits([
      hit({
        projectId: "projC", // not in the mocked store
        projectName: "Gamma Project",
        conversationId: "conv-c",
        conversationTitle: "Gamma Chat",
        messageId: "m-c",
      }),
    ]);
    const { container } = renderPalette();
    await type(container, "wor");
    await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
    await waitFor(() => expect(badges(container).length).toBeGreaterThan(0));

    const badge = badgeFor(container, "Gamma Project");
    expect(badge.querySelector("img")).toBeNull();
    expect(badge.querySelector('[data-testid="palette-project-avatar"]')?.textContent?.trim()).toBe(
      "G",
    );
  });

  test("each conversation group carries its own project badge", async () => {
    setHits([
      hit({
        projectId: "projA",
        projectName: "Alpha",
        conversationId: "conv-a",
        conversationTitle: "Alpha Chat",
        messageId: "m-a",
      }),
      hit({
        projectId: "projB",
        projectName: "Beta",
        conversationId: "conv-b",
        conversationTitle: "Beta Chat",
        messageId: "m-b",
      }),
    ]);
    const { container } = renderPalette();
    await type(container, "wor");
    await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
    await waitFor(() => expect(badges(container).length).toBe(2));

    // projA → logo image; projB → colored initial.
    expect(badgeFor(container, "Alpha").querySelector("img")?.getAttribute("src")).toBe(LOGO_SRC);
    expect(badgeFor(container, "Beta").querySelector("img")).toBeNull();
    expect(
      badgeFor(container, "Beta")
        .querySelector('[data-testid="palette-project-avatar"]')
        ?.textContent?.trim(),
    ).toBe("B");
  });
});
