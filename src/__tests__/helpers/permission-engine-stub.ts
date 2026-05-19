/**
 * Test-only `PermissionEngine` stub.
 *
 * Phase 1 mandate: every `ToolExecutor` construction site supplies a
 * `PermissionEngine` (fail-closed contract — closes finding C6). The
 * production engine touches `auditLog` + `settings` + the registry, so
 * giving every old unit test a fully-wired engine would be hostile.
 * Instead, this stub provides:
 *
 *   • `allow-all`     — the default. Returns `{decision: "allow"}`
 *     synchronously and skips the audit write. Use for unit tests
 *     that don't care about permission semantics.
 *   • `deny-all`      — returns `{decision: "deny", reason}`. Use for
 *     authorization-failure assertions.
 *   • `record`        — every call appends to a public `calls[]` array
 *     so a test can assert the PDP was invoked with expected args.
 *
 * The stub is intentionally minimal — production code paths import
 * the real `permission-engine.ts` factory.
 */

import type { Capability, CapabilitySet } from "../../extensions/capability-types";
import type {
  AuthorizeContext,
  Decision,
  PermissionEngine,
} from "../../extensions/permission-engine";
import type { AlwaysAllowScope } from "../../extensions/permissions";

export interface StubPermissionEngine extends PermissionEngine {
  /** Tape of every authorize call this engine received. */
  readonly calls: Array<{ ctx: AuthorizeContext; needed: CapabilitySet }>;
  /** Switch the in-memory mode without rebuilding the stub. */
  setMode(mode: "allow-all" | "deny-all"): void;
}

export function createStubPermissionEngine(
  initialMode: "allow-all" | "deny-all" = "allow-all",
): StubPermissionEngine {
  const calls: Array<{ ctx: AuthorizeContext; needed: CapabilitySet }> = [];
  let mode: "allow-all" | "deny-all" = initialMode;

  const engine: StubPermissionEngine = {
    calls,
    setMode(next) {
      mode = next;
    },
    async authorize(
      ctx: AuthorizeContext,
      needed: CapabilitySet,
    ): Promise<Decision> {
      calls.push({ ctx, needed });
      const auditId = "stub-audit";
      if (mode === "allow-all") {
        return { decision: "allow", auditId };
      }
      const missing: Capability = needed[0] ?? { kind: "shell" };
      return {
        decision: "deny",
        reason: "stub-deny-all",
        auditId,
        missing,
      };
    },
    async resolvePrompt(
      _promptId: string,
      _allowed: boolean,
      _scope: AlwaysAllowScope,
      _scopeId: string,
    ): Promise<void> {
      // No-op for the stub.
    },
    _resetCacheForTests(): void {
      calls.length = 0;
    },
  };

  return engine;
}
