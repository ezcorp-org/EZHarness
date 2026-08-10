/**
 * Regression: a `capability-event` row is persisted with a null
 * parentMessageId (recordCapabilityCall.ts) and returned by the chat's
 * `?all=true` message load. It used to land in the root sibling group and
 * make the first message of a brand-new chat render a phantom `‹ 1/2 ›`
 * branch switcher even though nothing was ever branched.
 *
 * The frontend fix excludes capability-event rows from the sibling map
 * (web/src/lib/chat/page-handlers/load-messages.ts `buildSiblingMap`). This
 * spec proves it at the rendered-thread level, and the positive-control
 * test guarantees the locator genuinely detects the navigator (so the
 * negative assertion can't pass vacuously).
 *
 * Pure RENDER spec — seeds the message tree via `mockApi`, no send flow, no
 * Docker.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat capability-event → no phantom branch", () => {
  const proj = makeProject({ id: "proj-cap-1", name: "Cap Project" });
  const conv = makeConversation({
    id: "conv-cap-src",
    projectId: "proj-cap-1",
    title: "Cap Source",
    updatedAt: "2026-04-01T00:10:00.000Z",
  });

  test("trailing root-level capability-event does NOT render a branch navigator", async ({
    page,
    mockApi,
  }) => {
    const user = makeMessage({
      id: "cap-u1",
      conversationId: "conv-cap-src",
      role: "user",
      content: "Question one",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    const assistant = makeMessage({
      id: "cap-a1",
      conversationId: "conv-cap-src",
      role: "assistant",
      content: "Answer one",
      parentMessageId: "cap-u1",
      createdAt: "2026-04-01T00:01:00.000Z",
    });
    // The offending row: synthetic capability annotation, null parent.
    const capEvent = makeMessage({
      id: "cap-evt",
      conversationId: "conv-cap-src",
      role: "capability-event",
      parentMessageId: null,
      content: JSON.stringify({
        __ezcorp_capability_event: true,
        capability: "llm",
        action: "complete",
        success: true,
      }),
      createdAt: "2026-04-01T00:02:00.000Z",
    });

    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [user, assistant, capEvent],
    });

    await page.goto(`/project/${proj.id}/chat/${conv.id}`);
    await page.waitForLoadState("networkidle");

    // The real turn renders…
    await expect(page.getByText("Question one")).toBeVisible();
    await expect(page.getByText("Answer one")).toBeVisible();

    // …and NO branch switcher appears (the bug would show `‹ 1/2 ›`).
    await expect(page.getByRole("button", { name: "Previous branch" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next branch" })).toHaveCount(0);
  });

  test("positive control: a genuine regenerated sibling DOES render the navigator", async ({
    page,
    mockApi,
  }) => {
    const user = makeMessage({
      id: "ctl-u1",
      conversationId: "conv-cap-src",
      role: "user",
      content: "Control question",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    const answerA = makeMessage({
      id: "ctl-a1",
      conversationId: "conv-cap-src",
      role: "assistant",
      content: "Control answer A",
      parentMessageId: "ctl-u1",
      createdAt: "2026-04-01T00:01:00.000Z",
    });
    // Regenerated branch — a real sibling under the same parent.
    const answerB = makeMessage({
      id: "ctl-a2",
      conversationId: "conv-cap-src",
      role: "assistant",
      content: "Control answer B",
      parentMessageId: "ctl-u1",
      createdAt: "2026-04-01T00:02:00.000Z",
    });

    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [user, answerA, answerB],
    });

    await page.goto(`/project/${proj.id}/chat/${conv.id}`);
    await page.waitForLoadState("networkidle");

    // Latest branch (B) shows by default, with the navigator present.
    await expect(page.getByText("Control answer B")).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous branch" }).first()).toBeVisible();
  });
});
