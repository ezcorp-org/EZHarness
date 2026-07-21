/**
 * Unit coverage for `resolveConversationalLeaf` — the durable-leaf sanitizer
 * added to `buildTreeView`/`computeSessionTree`.
 *
 * Why this test exists: the session leaf pointer advances to whatever entry was
 * appended LAST (`leafIdAfterEntry`), so a run whose final activity was an
 * auto-allowed tool call leaves the durable leaf sitting on a trailing
 * `capability-event` row. The chat client's `restoreDurableLeaf` re-seats the
 * active branch on `currentLeaf` as the LAST writer; when that cap is still
 * root-level (parent not yet healed by the catch-up reconcile), `pathToRoot`
 * from it yields ONLY the orphan annotation → the transcript renders BLANK.
 * This is the exact "daily briefing chat is empty" report. `computeLatestLeaf`
 * (client) and `getLatestLeaf` (server bare GET) already exclude
 * capability-events from leaf selection; this closes the one remaining
 * leaf-producing path that did not.
 */

import { test, expect, describe } from "bun:test";
import { resolveConversationalLeaf } from "../db/session-sync";

// The function reads only `role` and `parentMessageId`; a partial row cast to
// the map's value type is all it consults.
type Row = { id: string; role: string; parentMessageId: string | null };
function mapOf(rows: Row[]): Map<string, any> {
  return new Map(rows.map((r) => [r.id, r as any]));
}

describe("resolveConversationalLeaf", () => {
  test("orphan capability-event leaf (null parent) fails open to null", () => {
    // The reproduced bug: trailing cap persisted root-level before the
    // catch-up reconcile re-parents it. Nulling → client keeps
    // computeLatestLeaf's correct report leaf instead of blanking.
    const rows = mapOf([
      { id: "user", role: "user", parentMessageId: null },
      { id: "asst", role: "assistant", parentMessageId: "user" },
      { id: "cap", role: "capability-event", parentMessageId: null },
    ]);
    expect(resolveConversationalLeaf("cap", rows)).toBeNull();
  });

  test("capability-event chained onto the thread resolves to nearest real ancestor", () => {
    // After the catch-up reconcile heals parents, the same durable leaf now
    // walks back to the real assistant turn (the report), not the annotation.
    const rows = mapOf([
      { id: "user", role: "user", parentMessageId: null },
      { id: "report", role: "assistant", parentMessageId: "user" },
      { id: "cap1", role: "capability-event", parentMessageId: "report" },
      { id: "cap2", role: "capability-event", parentMessageId: "cap1" },
    ]);
    expect(resolveConversationalLeaf("cap2", rows)).toBe("report");
  });

  test("a real message leaf is returned unchanged (rewind targets are no-ops)", () => {
    const rows = mapOf([
      { id: "user", role: "user", parentMessageId: null },
      { id: "report", role: "assistant", parentMessageId: "user" },
    ]);
    expect(resolveConversationalLeaf("report", rows)).toBe("report");
    expect(resolveConversationalLeaf("user", rows)).toBe("user");
  });

  test("null pointer stays null", () => {
    expect(resolveConversationalLeaf(null, mapOf([]))).toBeNull();
  });

  test("pointer to a non-live row fails open to null", () => {
    const rows = mapOf([{ id: "user", role: "user", parentMessageId: null }]);
    expect(resolveConversationalLeaf("deleted", rows)).toBeNull();
  });

  test("a chain that is all capability-events fails open to null", () => {
    const rows = mapOf([
      { id: "cap1", role: "capability-event", parentMessageId: null },
      { id: "cap2", role: "capability-event", parentMessageId: "cap1" },
    ]);
    expect(resolveConversationalLeaf("cap2", rows)).toBeNull();
  });

  test("a parent_message_id cycle is broken by the visited-set guard", () => {
    // capability-events with a corrupt A→B→A parent loop must terminate.
    const rows = mapOf([
      { id: "capA", role: "capability-event", parentMessageId: "capB" },
      { id: "capB", role: "capability-event", parentMessageId: "capA" },
    ]);
    expect(resolveConversationalLeaf("capA", rows)).toBeNull();
  });
});
