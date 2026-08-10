/**
 * REGRESSION: a NUL (U+0000) in tool-derived content must not silently drop the
 * row.
 *
 * Production, external Postgres, 2026-07-20 onward:
 *
 *   ERROR: unsupported Unicode escape sequence
 *   DETAIL:   cannot be converted to text.
 *   STATEMENT: insert into "tool_calls" (...)
 *   STATEMENT: insert into "observability_events" (...)
 *
 * `observability_events` stopped accepting `tool_error` rows entirely (198 rows,
 * then nothing) while `tool_call` and `turn_summary` kept flowing, and the
 * matching `tool_calls` rows vanished with them. Nothing surfaced, because both
 * writers deliberately never throw — so a failed tool call disappeared from the
 * tool-call history AND from the observability panel.
 *
 * The NUL originates in extension subprocess spawn error strings. Postgres
 * cannot store U+0000 in `jsonb` or `text` at all, so the fix scrubs it at the
 * drizzle column boundary (src/db/nul-column-patch.ts).
 *
 * These tests drive the REAL production writers against a REAL database and
 * assert the rows are readable back — asserting "did not throw" would prove
 * nothing here, since never-throwing is exactly how the bug hid.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { persistToolCall } = await import("../db/queries/tool-calls");
const { insertObservabilityEvent, getConversationObservability } = await import(
  "../db/queries/observability"
);
const { persistError, listErrors } = await import("../db/queries/error-logs");
const { insertAuditEntry, listAuditLog } = await import("../db/queries/audit-log");

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);

/** The real string shape from the incident: a NUL inside the spawned path. */
const SPAWN_ERROR = `spawn /app/web/.ezcorp/extensions/timezone-time-hi${NUL} /bin ENOENT`;
const SCRUBBED = `spawn /app/web/.ezcorp/extensions/timezone-time-hi${FFFD} /bin ENOENT`;

const CONV_ID = "conv-nul-regression";

async function seed() {
  const db = getTestDb();
  await db.execute(
    sql`INSERT INTO projects (id, name, path) VALUES ('global', 'Global', '/tmp/global') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO conversations (id, project_id, title) VALUES (${CONV_ID}, 'global', 'nul') ON CONFLICT (id) DO NOTHING`,
  );
  // The `builtin` extension row is seeded by migrate() itself — tool_calls
  // rows FK onto it.
}

describe("observability_events — the tool_error rows that stopped being written", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seed();
  });
  afterAll(async () => await closeTestDb());

  test("a tool_error payload containing U+0000 persists and reads back", async () => {
    const row = await insertObservabilityEvent({
      conversationId: CONV_ID,
      eventType: "tool_error",
      data: {
        toolName: "get_time",
        extensionId: "timezone-time",
        error: SPAWN_ERROR,
        duration: 12,
      },
      durationMs: 12,
    });
    expect(row.id).toBeTruthy();

    const events = await getConversationObservability(CONV_ID);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("tool_error");

    const data = events[0]!.data as Record<string, unknown>;
    expect(data.toolName).toBe("get_time");
    // The NUL is replaced, NOT stripped — the path is still legible and the
    // substitution is visible to an operator.
    expect(data.error).toBe(SCRUBBED);
    expect(String(data.error).includes(NUL)).toBe(false);
  });

  test("a NUL nested in an array inside the payload also persists", async () => {
    await insertObservabilityEvent({
      conversationId: CONV_ID,
      eventType: "run_error",
      data: { frames: [{ msg: `a${NUL}b` }, "plain"] },
    });
    const events = await getConversationObservability(CONV_ID);
    const data = events[0]!.data as { frames: [{ msg: string }, string] };
    expect(data.frames[0].msg).toBe(`a${FFFD}b`);
    expect(data.frames[1]).toBe("plain");
  });

  test("a NUL in an object KEY persists", async () => {
    await insertObservabilityEvent({
      conversationId: CONV_ID,
      eventType: "tool_error",
      data: { [`bad${NUL}key`]: "v" },
    });
    const events = await getConversationObservability(CONV_ID);
    expect(Object.keys(events[0]!.data as object)).toEqual([`bad${FFFD}key`]);
  });
});

describe("tool_calls — the rows that vanished alongside them", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seed();
  });
  afterAll(async () => await closeTestDb());

  async function countToolCalls(): Promise<number> {
    const res = await getTestDb().execute(sql`SELECT COUNT(*)::int AS c FROM tool_calls`);
    return (res.rows[0] as { c: number }).c;
  }

  test("a failed tool call whose error carries U+0000 is actually stored", async () => {
    await persistToolCall({
      conversationId: CONV_ID,
      messageId: null,
      extensionId: "builtin",
      toolName: "get_time",
      input: { timezone: `Europe/Berlin${NUL}` },
      output: { content: [{ type: "text", text: SPAWN_ERROR }] },
      success: false,
      durationMs: 12,
    });

    // The row EXISTS — the never-throw contract means a silent drop would
    // otherwise look identical to success.
    expect(await countToolCalls()).toBe(1);

    const res = await getTestDb().execute(
      sql`SELECT input, output, success FROM tool_calls WHERE conversation_id = ${CONV_ID}`,
    );
    const stored = res.rows[0] as {
      input: Record<string, unknown>;
      output: { content: Array<{ text: string }> };
      success: boolean;
    };
    expect(stored.success).toBe(false);
    expect(stored.input.timezone).toBe(`Europe/Berlin${FFFD}`);
    expect(stored.output.content[0]!.text).toBe(SCRUBBED);
  });

  test("no persist-failure error_log is recorded (the insert really succeeded)", async () => {
    await persistToolCall({
      conversationId: CONV_ID,
      messageId: null,
      extensionId: "builtin",
      toolName: "get_time",
      input: {},
      output: { content: [{ type: "text", text: SPAWN_ERROR }] },
      success: false,
      durationMs: 1,
    });
    const errs = await listErrors();
    expect(errs.filter((e) => e.message.startsWith("tool-call-persist-failed"))).toHaveLength(0);
  });

  test("the never-throw contract still holds for a genuinely bad row", async () => {
    // A NUL is no longer a reason to fail, but a real FK violation still is —
    // and it must still be swallowed and routed to error_logs.
    await expect(
      persistToolCall({
        conversationId: CONV_ID,
        messageId: null,
        extensionId: "ghost-extension-does-not-exist",
        toolName: "get_time",
        input: {},
        output: { content: [] },
        success: false,
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();

    const errs = await listErrors();
    expect(errs.some((e) => e.message === "tool-call-persist-failed: tool_calls")).toBe(true);
  });
});

describe("text columns — the fallback that died with the thing it reported", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seed();
  });
  afterAll(async () => await closeTestDb());

  test("persistError stores a stack containing U+0000", async () => {
    // err.stack embeds the message, so the NUL that broke the original insert
    // reached persistError's TEXT column too and killed the report as well.
    await persistError({
      level: "warn",
      message: `tool-call-persist-failed${NUL}`,
      stack: `Error: ${SPAWN_ERROR}\n    at spawn (node:child_process)`,
      metadata: { error: SPAWN_ERROR },
    });

    const errs = await listErrors();
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toBe(`tool-call-persist-failed${FFFD}`);
    expect(errs[0]!.stack).toContain(SCRUBBED);
    expect(errs[0]!.stack!.includes(NUL)).toBe(false);
    expect((errs[0]!.metadata as { error: string }).error).toBe(SCRUBBED);
  });

  test("insertAuditEntry stores a target containing U+0000", async () => {
    const id = await insertAuditEntry(null, "ext:invoke", `tool${NUL}name`, {
      error: SPAWN_ERROR,
    });
    expect(id).not.toBe("");

    const rows = await listAuditLog({ action: "ext:invoke" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.target).toBe(`tool${FFFD}name`);
    expect((rows[0]!.metadata as { error: string }).error).toBe(SCRUBBED);
  });
});
