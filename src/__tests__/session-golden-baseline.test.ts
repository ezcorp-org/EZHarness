/**
 * GOLDEN BASELINE for the session / chat-history surface.
 *
 * One fixed, seeded conversation is driven through the whole observable
 * surface (backfill → sync → tree → branch → loadHistory → rewind) and the
 * result is compared against the recorded JSON in
 * `src/__tests__/fixtures/session-golden-baseline.json`.
 *
 * WHY a golden and not only hand-written assertions: a characterization
 * suite pins what its author thought to assert; the golden pins everything,
 * including the fields nobody remembered — payload key order-independent
 * contents, `ez_message_id` nullability per entry type, the exact
 * `topologySyncedThroughMs` cursor value, the leaf pointer chain.
 *
 * RUN:
 *   bun test src/__tests__/session-golden-baseline.test.ts --timeout 30000
 *
 * RE-RECORD (only when a behaviour change is INTENDED and reviewed):
 *   EZ_RECORD_SESSION_GOLDEN=1 bun test src/__tests__/session-golden-baseline.test.ts --timeout 30000
 * then `git diff` the fixture — that diff IS the behaviour change.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { captureGoldenSnapshot } = await import("./helpers/session-golden");

const GOLDEN_PATH = new URL("./fixtures/session-golden-baseline.json", import.meta.url).pathname;
const RECORD = process.env.EZ_RECORD_SESSION_GOLDEN === "1";

let snapshot: Awaited<ReturnType<typeof captureGoldenSnapshot>>;

describe("session layer — golden baseline", () => {
  beforeAll(async () => {
    await setupTestDb();
    snapshot = await captureGoldenSnapshot();
    if (RECORD) await Bun.write(GOLDEN_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("the recorded baseline reproduces exactly", async () => {
    const golden = await Bun.file(GOLDEN_PATH).json();
    // Round-trip through JSON so `undefined` fields and Date instances are
    // compared on the same axis the fixture stores them on.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(golden);
  });

  test("the baseline is not vacuous — it pins real rows, a tree and a history", () => {
    expect(snapshot.entries.rows.length).toBeGreaterThan(10);
    expect(snapshot.entries.seqStrictlyIncreasing).toBe(true);
    expect((snapshot.tree as { nodes: unknown[] }).nodes.length).toBe(11);
    expect((snapshot.loadHistory.default as unknown[]).length).toBeGreaterThan(0);
    expect(snapshot.afterRewind.messageParentsUnchanged).toBe(true);
  });
});
