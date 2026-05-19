/**
 * Soak-reader unit tests — Phase 55 Plan 03 (MCP-03).
 *
 * `parseAndEmitSeccompViolations` parses `journalctl -k --output=short`
 * lines, filters for `audit: type=1326` entries matching the spawned
 * MCP child's PID, and emits one MCP_SECCOMP_VIOLATION audit row per
 * match. RESEARCH.md Example D documents the line format.
 *
 * Test approach:
 *   - The audit-writer is mocked at module scope (mirrors
 *     mcp-sandbox.test.ts), capturing calls into AUDIT_CALLS.
 *   - Each test seeds AUDIT_CALLS with the journalctl-fixture lines,
 *     invokes the parser, and asserts on the resulting rows.
 *
 * RED state (Task 1): the parser function does not exist yet (Task 2
 * creates it). The import statement at the top fails, every test fails
 * to load. Task 2's GREEN flips this whole file to passing.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const AUDIT_CALLS: Array<{
  userId: string | null;
  action: string;
  target?: string;
  metadata: Record<string, unknown> | null;
}> = [];

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    AUDIT_CALLS.push({ userId, action, target, metadata: metadata ?? null });
    return `audit-${AUDIT_CALLS.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// Task 2 creates this module. RED until then.
import { parseAndEmitSeccompViolations } from "../extensions/runtime/seccomp-soak-reader";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  AUDIT_CALLS.length = 0;
});

const CTX = {
  userId: "user-1",
  extensionId: "ext-mcp-1",
  extensionName: "mcp-probe",
};

/** RESEARCH.md Example D — canonical journalctl type=1326 line. */
const GOLDEN_LINE =
  'May 11 15:37:40 host kernel: [369128.669452] audit: type=1326 ' +
  'audit(1716830260.484:14536): auid=4294967295 uid=1000 gid=1000 ses=4294967295 ' +
  'pid=29064 comm="python3" exe="/usr/bin/python3" sig=0 arch=c000003e ' +
  'syscall=51 compat=0 ip=0x46fe1f code=0x7ffc0000';

describe("seccomp soak reader", () => {
  test("golden type=1326 line -> emits MCP_SECCOMP_VIOLATION row with {syscall, code, pid, arch}", async () => {
    await parseAndEmitSeccompViolations([GOLDEN_LINE], "29064", CTX);
    // Audit writer is async fire-and-forget — give it a tick.
    await new Promise((res) => setTimeout(res, 10));
    expect(AUDIT_CALLS.length).toBe(1);
    const row = AUDIT_CALLS[0];
    expect(row.action).toBe("ext:mcp:seccomp-violation");
    expect(row.target).toBe(CTX.extensionId);
    expect(row.userId).toBe(CTX.userId);
    expect(row.metadata?.syscall).toBe(51);
    expect(row.metadata?.code).toBe("0x7ffc0000");
    expect(row.metadata?.pid).toBe("29064");
    expect(row.metadata?.arch).toBe("c000003e");
    expect(row.metadata?.extensionName).toBe(CTX.extensionName);
  });

  test("empty input -> zero audit rows", async () => {
    await parseAndEmitSeccompViolations([], "29064", CTX);
    await new Promise((res) => setTimeout(res, 10));
    expect(AUDIT_CALLS.length).toBe(0);
  });

  test("multiple lines mixing PIDs -> only matching-PID rows emitted", async () => {
    const otherPid = GOLDEN_LINE.replace("pid=29064", "pid=99999");
    const thirdLine = GOLDEN_LINE.replace("syscall=51", "syscall=101");  // ptrace, same pid
    await parseAndEmitSeccompViolations(
      [GOLDEN_LINE, otherPid, thirdLine],
      "29064",
      CTX,
    );
    await new Promise((res) => setTimeout(res, 10));
    expect(AUDIT_CALLS.length).toBe(2);
    const syscalls = AUDIT_CALLS.map((c) => c.metadata?.syscall as number).sort(
      (a, b) => a - b,
    );
    expect(syscalls).toEqual([51, 101]);
  });

  test("malformed line missing syscall field -> silently skipped", async () => {
    const malformed =
      'May 11 15:37:40 host kernel: audit: type=1326 audit(...): ' +
      'pid=29064 comm="x" arch=c000003e code=0x7ffc0000';  // no syscall=
    await parseAndEmitSeccompViolations([malformed, GOLDEN_LINE], "29064", CTX);
    await new Promise((res) => setTimeout(res, 10));
    // Only the GOLDEN_LINE matched; malformed was silently dropped.
    expect(AUDIT_CALLS.length).toBe(1);
  });

  test("audit-write failure does not throw", async () => {
    // Replace the insertAuditEntry mock for this test with a rejecting impl.
    AUDIT_CALLS.length = 0;
    mock.module("../db/queries/audit-log", () => ({
      insertAuditEntry: async () => {
        throw new Error("simulated DB failure");
      },
      listAuditLog: async () => [],
      listAuditForExtension: async () => [],
    }));
    // The parser must catch the .catch(() => {}) — no throw escapes.
    await expect(
      parseAndEmitSeccompViolations([GOLDEN_LINE], "29064", CTX),
    ).resolves.toBeUndefined();
    // Restore the capture mock for any subsequent test in this file.
    mock.module("../db/queries/audit-log", () => ({
      insertAuditEntry: async (
        userId: string | null,
        action: string,
        target?: string,
        metadata?: Record<string, unknown>,
      ): Promise<string> => {
        AUDIT_CALLS.push({ userId, action, target, metadata: metadata ?? null });
        return `audit-${AUDIT_CALLS.length}`;
      },
      listAuditLog: async () => [],
      listAuditForExtension: async () => [],
    }));
  });

  test("non-1326 lines are ignored (e.g. routine kernel messages)", async () => {
    const noisy = [
      "May 11 15:00:00 host kernel: [369000.000000] tcp_input: example",
      "May 11 15:00:01 host systemd[1]: Started Daemon.",
      'May 11 15:00:02 host kernel: audit: type=1300 audit(...): pid=29064 syscall=51',
      GOLDEN_LINE,
    ];
    await parseAndEmitSeccompViolations(noisy, "29064", CTX);
    await new Promise((res) => setTimeout(res, 10));
    expect(AUDIT_CALLS.length).toBe(1);
    expect(AUDIT_CALLS[0].metadata?.syscall).toBe(51);
  });
});
