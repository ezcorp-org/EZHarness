/**
 * DOM tests for the `ez-action-result` branch in ChatMessage.svelte
 * (renders an EzActionCard inline when the row's role is the
 * synthetic ez-action-result kind persisted by the dispatcher endpoint
 * and the submit-time path).
 *
 * Coverage targets:
 *   - Valid JSON content → EzActionCard mounts with the parsed result
 *     (we verify the card renders by selecting the data-testid the
 *     real EzActionCard exposes — `ez-action-card`).
 *   - Malformed JSON → silent fallback ("EZ action result unreadable.")
 *     instead of a blank row or a thrown error.
 *
 * Pre-fix: this branch was only exercised by the Playwright E2E spec.
 * A jsdom-level test pins the parse + render contract so a future
 * refactor of `parseEzActionResult` (lenient shape match) can't
 * silently break the renderer.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ChatMessage from "../ChatMessage.svelte";
import type { Message } from "$lib/api.js";

beforeEach(() => {
  // MarkdownRenderer + sub-components fire fetches on mount; stub.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

function makeEzMessage(content: string): Message {
  return {
    id: "msg-ez-1",
    conversationId: "conv-1",
    role: "ez-action-result",
    content,
    thinkingContent: null,
    model: null,
    provider: null,
    usage: null,
    runId: null,
    parentMessageId: "parent-msg-id",
    excluded: false,
    createdAt: "2026-05-06T00:00:00.000Z",
  };
}

describe("ChatMessage — ez-action-result rendering", () => {
  test("valid JSON content → EzActionCard renders with the parsed result", () => {
    const payload = {
      kind: "success" as const,
      card: {
        title: "Lesson captured",
        body: "always-quote-paths",
        variant: "success" as const,
      },
      ref: { kind: "lesson" as const, slug: "always-quote-paths" },
    };
    const { getByTestId } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });

    const card = getByTestId("ez-action-card");
    expect(card).toBeTruthy();
    // Pin the parsed values made it through `parseEzActionResult`
    // + `EzActionCard` to the rendered DOM. The card's
    // `data-variant` mirrors the result's variant; aria-label
    // mirrors the title.
    expect(card.getAttribute("data-variant")).toBe("success");
    expect(card.getAttribute("aria-label")).toBe("Lesson captured");
  });

  test("malformed JSON content → fallback pill ('EZ action result unreadable.'), no thrown error", () => {
    // `parseEzActionResult` swallows JSON.parse errors and returns
    // null. ChatMessage's template branches on the null and
    // renders a minimal italic notice instead of a blank row.
    const { container, queryByTestId } = render(ChatMessage, {
      message: makeEzMessage("{not-valid-json"),
    });

    // EzActionCard MUST NOT mount.
    expect(queryByTestId("ez-action-card")).toBeNull();
    // Fallback notice is present.
    expect(container.textContent).toContain("EZ action result unreadable");
  });

  test("JSON with missing card.variant → fallback pill (lenient parse rejects malformed shapes)", () => {
    // `parseEzActionResult` requires card.title + card.body +
    // card.variant. A missing/unknown variant fails the shape
    // match, so the row falls back to the unreadable notice.
    const halfShaped = JSON.stringify({
      kind: "success",
      card: { title: "x", body: "y" }, // no variant
    });
    const { container, queryByTestId } = render(ChatMessage, {
      message: makeEzMessage(halfShaped),
    });
    expect(queryByTestId("ez-action-card")).toBeNull();
    expect(container.textContent).toContain("EZ action result unreadable");
  });
});

/**
 * /goal Phase 2 — goal-row identification tests.
 *
 * Phase 1's goal-host writes plain `EzActionResult` rows (no
 * discriminator field) — see goal-host.ts:697–814's `build*Card`
 * functions. Phase 2 inspects the row's title via `inferGoalKind`
 * and stamps `data-goal-row="true"` + `data-goal-kind="…"` on the
 * wrapping div so Playwright e2e specs can target the row without
 * needing five visually-duplicate card components.
 *
 * Reusing `EzActionCard` is the deliberate choice — see the Phase 2
 * checkpoint analysis. Phase 1's contract stays sealed; only the
 * outer wrapper gets the markers.
 */
describe("ChatMessage — /goal row identification (data-goal-row / data-goal-kind)", () => {
  function findRow(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-goal-row="true"]') as HTMLElement | null;
  }

  test("status row (title 'Goal active') gets data-goal-row + data-goal-kind='status'", () => {
    const payload = {
      kind: "success",
      card: { title: "Goal active", body: "Condition: …", variant: "info" },
    };
    const { container, getByTestId } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    // The card itself still renders unchanged via EzActionCard.
    expect(getByTestId("ez-action-card")).toBeTruthy();
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("status");
  });

  test("achieved row (title 'Goal achieved') gets data-goal-kind='achieved'", () => {
    const payload = {
      kind: "success",
      card: { title: "Goal achieved", body: "…", variant: "success" },
    };
    const { container } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("achieved");
  });

  test("cleared row (title 'Goal cleared') gets data-goal-kind='cleared'", () => {
    const payload = {
      kind: "success",
      card: { title: "Goal cleared", body: "…", variant: "info" },
    };
    const { container } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("cleared");
  });

  test("turn-cap row (title 'Goal stopped — reached turn cap') also maps to 'cleared' (terminal-clean)", () => {
    const payload = {
      kind: "decline",
      card: { title: "Goal stopped — reached turn cap", body: "…", variant: "warning" },
    };
    const { container } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("cleared");
  });

  test("paused row (title 'Goal paused') gets data-goal-kind='paused'", () => {
    const payload = {
      kind: "decline",
      card: { title: "Goal paused", body: "…", variant: "warning" },
    };
    const { container } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("paused");
  });

  test("rejected row (title 'Goal condition too long') gets data-goal-kind='rejected'", () => {
    const payload = {
      kind: "error",
      card: { title: "Goal condition too long", body: "…", variant: "error" },
    };
    const { container } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("rejected");
  });

  test("disabled row (title '/goal disabled') ALSO maps to 'rejected' (Chunk G feature-flag UX)", () => {
    // When EZCORP_GOAL_ENABLED=off the messages route and
    // `buildDisabledCard` both emit this title. UX-wise it is in
    // the same class as a reject — "this command did not arm a
    // goal" — so the helper maps both to `rejected`.
    const payload = {
      kind: "decline",
      card: { title: "/goal disabled", body: "feature off", variant: "warning" },
    };
    const { container, getByTestId } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    // EzActionCard still renders the disabled card with its title.
    const card = getByTestId("ez-action-card");
    expect(card.getAttribute("aria-label")).toBe("/goal disabled");
    const row = findRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-goal-kind")).toBe("rejected");
  });

  test("non-goal ez-action-result (e.g. lessons-keeper) does NOT get goal markup", () => {
    // Defense: a lessons-keeper "Lesson captured" row must not be
    // misclassified as a goal row.
    const payload = {
      kind: "success",
      card: { title: "Lesson captured", body: "always-quote-paths", variant: "success" },
      ref: { kind: "lesson", slug: "always-quote-paths" },
    };
    const { container, queryByTestId } = render(ChatMessage, {
      message: makeEzMessage(JSON.stringify(payload)),
    });
    // EzActionCard still mounts.
    expect(queryByTestId("ez-action-card")).toBeTruthy();
    // But no goal markers.
    expect(container.querySelector("[data-goal-row]")).toBeNull();
  });
});
