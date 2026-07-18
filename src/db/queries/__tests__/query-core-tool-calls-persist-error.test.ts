/**
 * query-core db-audit fix: persistToolCall must KEEP its never-throw contract
 * but stop swallowing DB errors silently — a failed tool_calls insert now
 * routes the caught error to persistError (fire-and-forget) so the failure is
 * observable, mirroring insertAuditEntry.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

const { persistToolCall } = await import("../tool-calls");
const { listErrors, countErrors } = await import("../error-logs");

function failingRow() {
  // extension_id is NOT NULL + FK to extensions(id); a non-existent id makes
  // the INSERT fail with a foreign-key violation inside persistToolCall.
  return {
    conversationId: null,
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
});
