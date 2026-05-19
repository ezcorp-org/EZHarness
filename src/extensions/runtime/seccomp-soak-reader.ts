/**
 * Seccomp soak reader — Phase 55 Plan 03 (MCP-03).
 *
 * Parses `journalctl -k --output=short` lines for `audit: type=1326`
 * entries (kernel seccomp log-mode hits), filters for the spawned MCP
 * child's PID, and emits one MCP_SECCOMP_VIOLATION audit row per match.
 *
 * Why a separate module from mcp-sandbox.ts:
 *   - Unit-testable in isolation: the parser takes string[] in, calls
 *     `insertAuditEntry()` out; no spawn, no FS, no time. Tests in
 *     `src/__tests__/mcp-stage1-soak-reader.test.ts` exercise every
 *     branch with golden fixtures from RESEARCH.md Example D.
 *   - Single chokepoint: a future fleet-wide sweep daemon (Open
 *     Question 3 in 55-RESEARCH.md — deferred to a follow-up) can call
 *     `parseAndEmitSeccompViolations` directly without duplicating the
 *     regex.
 *
 * Audit-write contract: fire-and-forget. Mirrors the established pattern
 * in `mcp-sandbox.ts` and `mcp-proxy.ts` (`.catch(() => {})`). A DB
 * blip must not throw from the post-shutdown hook — the MCP has already
 * exited; there is nothing to fail-close on.
 *
 * Tied to:
 *   - `src/extensions/audit-actions.ts`   — MCP_SECCOMP_VIOLATION constant.
 *   - `src/extensions/mcp-sandbox.ts`     — sole production caller (invokes
 *                                           after `proc.exited` resolves).
 *   - `src/__tests__/mcp-stage1-soak-reader.test.ts` — unit tests.
 */

import { insertAuditEntry } from "../../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "../audit-actions";

/**
 * Discriminator for the kernel `audit: type=1326` audit-record class —
 * the SECCOMP_RET_LOG / SECCOMP_RET_KILL etc. event. Pinning the type
 * filters unrelated audit lines (type=1300 SYSCALL, type=1100
 * USER_AUTH, ...) before we even bother parsing fields.
 *
 * Sources:
 *   - RESEARCH.md Example D (Kubernetes seccomp tutorial)
 *   - https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html
 */
const TYPE_1326_RE = /\baudit:\s+type=1326\b/i;

/** Per-field regexes, applied independently so the parser is order-
 *  insensitive. Real kernel lines emit fields in a roughly stable but
 *  not strictly contractual order (pid → arch → syscall → ip → code on
 *  x86_64); using independent `\bname=value\b` captures means a future
 *  reordering doesn't silently drop rows. */
const PID_RE = /\bpid=(\d+)\b/;
const SYSCALL_RE = /\bsyscall=(\d+)\b/;
const CODE_RE = /\bcode=(0x[0-9a-f]+)\b/i;
const ARCH_RE = /\barch=([0-9a-f]+)\b/i;

/**
 * Per-spawn context for soak-reader audit rows. Same shape mcp-sandbox.ts
 * already threads through `insertAuditEntry` for MCP_NETNS_CREATED.
 */
export interface SoakReaderContext {
  userId: string | null;
  extensionId: string;
  extensionName: string;
}

/**
 * Parse journalctl lines, emit one MCP_SECCOMP_VIOLATION audit row per
 * line that matches type=1326 AND has pid === targetPid.
 *
 * Resolves after all `.catch()` chains are attached to the audit-write
 * promises — NOT after the writes complete. This matches the existing
 * fire-and-forget pattern in `mcp-sandbox.ts`: the post-shutdown hook
 * doesn't block the host process on DB roundtrips.
 *
 * Throwing from this function is contractually forbidden. Any unexpected
 * exception is swallowed locally (the line is skipped). The audit-write
 * itself is guarded with `.catch(() => {})`.
 */
export async function parseAndEmitSeccompViolations(
  lines: readonly string[],
  targetPid: string,
  ctx: SoakReaderContext,
): Promise<void> {
  for (const line of lines) {
    try {
      if (!TYPE_1326_RE.test(line)) continue;
      const pidMatch = line.match(PID_RE);
      const syscallMatch = line.match(SYSCALL_RE);
      const codeMatch = line.match(CODE_RE);
      const archMatch = line.match(ARCH_RE);
      // ALL four fields must be present — malformed lines (missing any
      // one) are silently skipped per the soak-reader test contract.
      if (!pidMatch || !syscallMatch || !codeMatch || !archMatch) continue;
      const pid = pidMatch[1];
      const syscallStr = syscallMatch[1];
      const code = codeMatch[1];
      const arch = archMatch[1];
      if (pid === undefined || syscallStr === undefined || code === undefined || arch === undefined) continue;
      if (pid !== targetPid) continue;
      const syscall = Number.parseInt(syscallStr, 10);
      if (!Number.isFinite(syscall)) continue;
      // Fire-and-forget per the established pattern. Audit failures
      // must not throw from a post-shutdown hook.
      void insertAuditEntry(
        ctx.userId,
        EXT_AUDIT_ACTIONS.MCP_SECCOMP_VIOLATION,
        ctx.extensionId,
        {
          permission: "network",
          oldValue: null,
          newValue: null,
          actor: "system",
          extensionName: ctx.extensionName,
          syscall,
          code,
          pid,
          arch,
        },
      ).catch(() => {
        // Swallowed — see fire-and-forget contract above.
      });
    } catch {
      // Defensive: any unexpected exception (regex engine OOM, etc.)
      // skips the line silently. The reader runs after the MCP has
      // already exited; there is nothing to fail-close on.
    }
  }
}
