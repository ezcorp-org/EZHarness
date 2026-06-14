/**
 * Regression: the bare `GET /api/conversations/:id/messages` (no
 * `all` / `leafMessageId` / `withToolCalls` params) must return the
 * full briefing thread the chat UI consumes — NOT just a trailing
 * orphan capability-event.
 *
 * ── Why this exists (live-validation bug, 2026-06-12) ───────────────
 * A briefing fired via run-now produced a conversation whose DB held
 * the synthetic user message + a threaded assistant reply (+ tool
 * activity), yet the bare API call returned only orphan
 * capability-events — the user→assistant thread was gone.
 *
 * Root cause: a briefing run with read-only watchlist tools (and any
 * normal chat after an auto-allowed tool run) persists
 * `role: "capability-event"` audit rows ROOT-LEVEL (null parent, no
 * children — see `recordCapabilityCall.ts`) with the latest
 * `created_at`. The bare GET resolved the active leaf via
 * `getLatestLeaf(conversationId)` WITHOUT `excludeCapabilityEvents`,
 * so it picked the trailing capability-event as the leaf;
 * `getConversationPath` then walked that row's null parent and
 * returned ONLY the orphan — dropping the entire briefing thread.
 *
 * The chat UI never hit this because it loads via `?all=true` and runs
 * its OWN `computeLatestLeaf` which already excludes capability-events
 * (`web/.../load-messages.ts`). The fix makes the bare GET resolve its
 * leaf the same way, mirroring the message-create parent resolution.
 *
 * This test pins the exact query composition the route's bare-GET
 * branch runs (`getLatestLeaf({ excludeCapabilityEvents: true })` →
 * `getConversationPath`) against a briefing-SHAPED conversation
 * (synthetic user msg + threaded assistant reply, the `run.ts` shape,
 * plus a root-level capability-event with the newest timestamp). It is
 * a defect proof: before the fix it returns the orphan-only branch;
 * after, the full thread.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { tmpdir } from "node:os";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage, getMessages, getLatestLeaf, getConversationPath } =
  await import("../db/queries/conversations");
const { SYNTHETIC_PROMPT_PREFIX } = await import("../runtime/briefing/run");

const SAFE_CWD = tmpdir();

/** Capability-event payload shape (mirrors recordCapabilityCall.ts). */
const CAP_PAYLOAD = JSON.stringify({
  __ezcorp_capability_event: true,
  sdkCapabilityCallId: "cap-briefing",
  capability: "tool",
  action: "search-web",
});

let userId = "";
let projectId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "briefing-bare-get@test.com",
    passwordHash: "h",
    name: "Briefing Bare GET",
  });
  userId = u.id;
  const p = await createProject({ name: "p", path: "/tmp" });
  projectId = p.id;
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  process.chdir(SAFE_CWD);
});

/**
 * Build a briefing-shaped conversation exactly as `runBriefingForUser`
 * does: synthetic user message (root, null parent) → assistant reply
 * threaded under it (parentMessageId = user msg) → root-level
 * capability-event audit rows (null parent) carrying the NEWEST
 * created_at, the way an auto-allowed read-only tool run leaves them.
 */
async function seedBriefingConversation() {
  const conv = await createConversation(projectId, {
    title: "Daily Briefing — Thu, Jun 11",
    userId,
  });

  // 1) Synthetic user message — root of the thread (run.ts creates it
  //    with NO parentMessageId).
  const userMsg = await createMessage(conv.id, {
    role: "user",
    content: `${SYNTHETIC_PROMPT_PREFIX}2026-06-11T07:00:00.000Z] Compose today's briefing now.`,
  });

  // 2) Assistant reply — threaded under the synthetic user message
  //    (run.ts passes parentMessageId: userMessage.id to streamChat).
  const assistantMsg = await createMessage(conv.id, {
    role: "assistant",
    content: "Good morning — here is your briefing. Unfinished business: …",
    parentMessageId: userMsg.id,
  });

  // 3) Root-level capability-event audit rows — null parent, no
  //    children, NEWEST created_at (recordCapabilityCall.ts inserts
  //    them with no parentMessageId after each auto-allowed tool run).
  const cap1 = await createMessage(conv.id, {
    role: "capability-event",
    content: CAP_PAYLOAD,
  });
  const cap2 = await createMessage(conv.id, {
    role: "capability-event",
    content: CAP_PAYLOAD,
  });

  return { conv, userMsg, assistantMsg, capIds: [cap1.id, cap2.id] };
}

describe("bare GET messages — briefing-shaped conversation", () => {
  test("DB holds the full thread plus root-level capability-events", async () => {
    const { conv, userMsg, assistantMsg, capIds } = await seedBriefingConversation();
    const all = await getMessages(conv.id);
    expect(all).toHaveLength(4);
    // The capability-events are root-level (null parent) — the precise
    // production shape that triggers the orphan-leaf bug.
    for (const id of capIds) {
      const cap = all.find((m) => m.id === id)!;
      expect(cap.role).toBe("capability-event");
      expect(cap.parentMessageId).toBeNull();
    }
    expect(all.find((m) => m.id === userMsg.id)!.parentMessageId).toBeNull();
    expect(all.find((m) => m.id === assistantMsg.id)!.parentMessageId).toBe(userMsg.id);
  });

  test("bare-GET leaf resolution returns the user→assistant thread, not the orphan capability-events", async () => {
    const { conv, userMsg, assistantMsg } = await seedBriefingConversation();

    // Exactly the bare-GET branch in the messages route: resolve the
    // active leaf with capability-events transparent, then walk the
    // parent chain to the root.
    const leaf = await getLatestLeaf(conv.id, { excludeCapabilityEvents: true });
    expect(leaf).not.toBeNull();
    // Pre-fix this resolved to a trailing capability-event; post-fix it
    // is the real assistant turn.
    expect(leaf!.id).toBe(assistantMsg.id);

    const thread = await getConversationPath(leaf!.id, conv.id);

    // The thread the chat UI consumes: root user message, then the
    // assistant reply — and NO capability-event rows on the path.
    expect(thread.map((m) => m.id)).toEqual([userMsg.id, assistantMsg.id]);
    expect(thread.some((m) => m.role === "capability-event")).toBe(false);
    expect(thread[0]!.role).toBe("user");
    expect(thread[0]!.content.startsWith(SYNTHETIC_PROMPT_PREFIX)).toBe(true);
    expect(thread[1]!.role).toBe("assistant");
  });

  test("regression guard: the UN-filtered leaf is the orphan capability-event (the original bug)", async () => {
    // Documents WHY the filter is load-bearing: without
    // excludeCapabilityEvents the bare GET resolves a root-level
    // capability-event as the leaf, and the path from it is the orphan
    // branch the validator saw (a single capability-event, no thread).
    const { conv } = await seedBriefingConversation();

    const buggyLeaf = await getLatestLeaf(conv.id); // default: no filter
    expect(buggyLeaf!.role).toBe("capability-event");

    const buggyThread = await getConversationPath(buggyLeaf!.id, conv.id);
    expect(buggyThread).toHaveLength(1);
    expect(buggyThread[0]!.role).toBe("capability-event");
  });
});
