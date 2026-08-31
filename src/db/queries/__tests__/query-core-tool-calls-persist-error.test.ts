/**
 * query-core db-audit fix: persistToolCall must KEEP its never-throw contract
 * but stop swallowing DB errors silently — a failed tool_calls insert now
 * routes the caught error to persistError (fire-and-forget) so the failure is
 * observable, mirroring insertAuditEntry.
 *
 * Defect 3 (tool-call-persist-losses): `String(err)` alone was NOT enough to
 * diagnose a failure from — a drizzle error's own `.message` is just
 * "Failed query: <sql> params: <bound values>"; the Postgres constraint name,
 * DETAIL line, and SQLSTATE code live on `.cause` and never appeared. The
 * fix pulls `code`/`constraint`/`detail` out as their own metadata fields
 * and redacts the bulkier `error` string (which embeds the row's bound
 * params — i.e. this call's `input`/`output` — verbatim) through the same
 * `redactForAudit` boundary every other audit-adjacent write uses.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  getTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

const { persistToolCall } = await import("../tool-calls");
const { listErrors, countErrors } = await import("../error-logs");
const { createProject } = await import("../projects");
const { createConversation } = await import("../conversations");
const { extensions } = await import("../../schema");

function failingRow() {
  // extension_id is NOT NULL + FK to extensions(id); a non-existent id makes
  // the INSERT fail with a foreign-key violation inside persistToolCall.
  return {
    conversationId: "ghost-conversation-does-not-exist",
    messageId: null,
    extensionId: "ghost-extension-does-not-exist",
    toolName: "read_file",
    input: { path: "x" },
    output: { content: [{ type: "text", text: "hi" }] },
    success: true,
    durationMs: 5,
  };
}

describe("persistToolCall observability on DB failure", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("a failed insert does NOT throw (never-throw contract preserved)", async () => {
    await expect(persistToolCall(failingRow())).resolves.toBeUndefined();
  });

  test("a failed insert records an error_logs entry instead of silently dropping", async () => {
    expect(await countErrors()).toBe(0);

    await persistToolCall(failingRow());

    const errs = await listErrors();
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toBe("tool-call-persist-failed: tool_calls");
    expect(errs[0]!.level).toBe("warn");
    // The offending row's identifying fields land in metadata for the operator.
    const meta = errs[0]!.metadata as Record<string, unknown>;
    expect(meta.extensionId).toBe("ghost-extension-does-not-exist");
    expect(meta.toolName).toBe("read_file");
    expect(typeof meta.error).toBe("string");
  });

  test("the underlying Postgres cause (code/constraint/detail) is captured, not just String(err)", async () => {
    await persistToolCall(failingRow());

    const errs = await listErrors();
    const meta = errs[0]!.metadata as Record<string, unknown>;
    // 23503 = foreign_key_violation (Postgres SQLSTATE).
    expect(meta.code).toBe("23503");
    // `failingRow()`'s conversationId is ALSO bogus, and `conversation_id`
    // is declared before `extension_id` in the table — Postgres reports the
    // first constraint it hits.
    expect(meta.constraint).toBe("tool_calls_conversation_id_fkey");
    expect(typeof meta.detail).toBe("string");
    expect(meta.detail as string).toContain("conversation_id");
    expect(meta.detail as string).toContain("ghost-conversation-does-not-exist");
  });

  test("a credential-shaped value in the row's input does NOT leak into error_logs.metadata.error", async () => {
    await persistToolCall({
      ...failingRow(),
      input: { path: "x", apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" },
    });

    const errs = await listErrors();
    const meta = errs[0]!.metadata as Record<string, unknown>;
    // The structured cause fields still survive — they never echo tool
    // payload, only this table's own id columns.
    expect(meta.code).toBe("23503");
    // `failingRow()`'s conversationId is ALSO bogus, and `conversation_id`
    // is declared before `extension_id` in the table — Postgres reports the
    // first constraint it hits.
    expect(meta.constraint).toBe("tool_calls_conversation_id_fkey");
    // `error` embeds the raw bound params (this row's `input`), so a
    // credential match wipes the WHOLE string rather than leaking a
    // partially-redacted fragment — see `redactForAudit`'s "whole-string
    // replacement" contract.
    expect(meta.error).toBe("[REDACTED]");
    expect(JSON.stringify(meta)).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
  });
});

describe("persistToolCall observability on the defect-1 messageId FK violation", () => {
  let conversationId: string;
  let extensionId: string;

  beforeAll(async () => {
    await setupTestDb();
    const project = await createProject({ name: "err-obs-test", path: "/tmp/err-obs-test" });
    const conv = await createConversation(project.id);
    conversationId = conv.id;
    const inserted = await getTestDb()
      .insert(extensions)
      .values({
        id: `ext-${crypto.randomUUID().slice(0, 8)}`,
        name: `err-obs-ext-${crypto.randomUUID().slice(0, 8)}`,
        version: "0.0.0",
        description: "test",
        manifest: { name: "test", version: "0.0.0" } as any,
        source: "test",
        installPath: "/",
      })
      .returning({ id: extensions.id });
    extensionId = inserted[0]!.id;
  });
  afterAll(async () => await closeTestDb());

  test("conversation + extension exist, messageId does not: constraint/detail name message_id specifically", async () => {
    expect(await countErrors()).toBe(0);

    await persistToolCall({
      conversationId,
      messageId: "ghost-message-does-not-exist",
      extensionId,
      toolName: "task_create",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 1,
    });

    const errs = await listErrors();
    expect(errs.length).toBe(1);
    const meta = errs[0]!.metadata as Record<string, unknown>;
    expect(meta.code).toBe("23503");
    expect(meta.constraint).toBe("tool_calls_message_id_fkey");
    expect(meta.detail as string).toContain("message_id");
    expect(meta.detail as string).toContain("ghost-message-does-not-exist");
    // The conversation/extension identifiers we DID have are still on the
    // row for a human to cross-reference (conv=1, ext=1, msg=0 signature).
    expect(meta.conversationId).toBe(conversationId);
    expect(meta.extensionId).toBe(extensionId);
  });
});
