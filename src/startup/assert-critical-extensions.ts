/**
 * Startup invariant — every `critical` bundled extension MUST be
 * `enabled=true` after `ensureBundledExtensions()`.
 *
 * Root-cause fix #3 of the harness-smoke-test loop: `ask-user` was
 * auto-disabled at boot (S9 version-bump/permission gate), so a blocked
 * agent could not ask a clarifying question — no escape from the loop.
 * The S9 gate (bundled.ts) already auto-reapproves a `critical` bump
 * that stays within the bundled ceiling; this invariant is the
 * defense-in-depth backstop for ANY other path that left a critical
 * extension disabled (manual DB edit, an earlier-version disable, a
 * ceiling-exceeding bump that the S9 gate correctly refused).
 *
 * Behavior on a disabled critical extension:
 *   - Always log ERROR (loud, non-fatal — never bricks startup).
 *   - One-time remediation: if its ON-DISK permissions are within the
 *     bundled ceiling, re-enable it (the ceiling is still the hard
 *     security bound — a ceiling-exceeding extension is NOT
 *     auto-re-enabled; it stays disabled and the ERROR stands so an
 *     operator investigates).
 *
 * ONE exception: a row carrying `disabledByUser` was switched off from the
 * Extensions page on purpose, typically because the user runs their own
 * replacement for the capability. That is a decision, not a fault, so it is
 * neither a violation nor remediated. It still logs — at WARN, naming what
 * the loop loses — because a silently absent `ask-user` is exactly the
 * harness-smoke-test trap, and an operator debugging a stuck agent needs the
 * line in the log. Every OTHER route to a disabled critical extension (manual
 * DB edit, the S9 version gate, a manifest tamper) keeps the ERROR and the
 * one-time re-enable unchanged.
 */

import { getCriticalBundledExtensions, getProjectRoot } from "../extensions/bundled";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { loadManifestFresh } from "../extensions/loader";
import { clampToBundledCeiling } from "../extensions/bundled-ceiling";
// Shared with the Extensions page's disable dialog — see the module header
// for why the sentence has exactly one home.
import { consequenceFor } from "../extensions/critical-consequence";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "../extensions/audit-actions";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import { join } from "node:path";
import { logger } from "../logger";

const log = logger.child("startup/assert-critical-extensions");

export interface CriticalAssertionResult {
  /** Names checked. */
  checked: string[];
  /** Critical extensions found disabled (before remediation). */
  violations: string[];
  /** Critical extensions re-enabled by one-time remediation. */
  remediated: string[];
  /** Disabled + NOT remediated (perms exceed ceiling / disk unreadable). */
  unremediated: string[];
  /**
   * Disabled BY THE USER and deliberately left that way. Reported
   * separately from `violations` so a caller cannot mistake a choice for a
   * fault — these names are absent from every other array.
   */
  userDisabled: string[];
}

/**
 * Assert the critical-extensions invariant. Never throws — every
 * failure mode is logged and folded into the returned result so a
 * caller (seed-marketplace) can stay non-fatal.
 */
export async function assertCriticalExtensions(): Promise<CriticalAssertionResult> {
  const critical = getCriticalBundledExtensions();
  const result: CriticalAssertionResult = {
    checked: critical.map((c) => c.name),
    violations: [],
    remediated: [],
    unremediated: [],
    userDisabled: [],
  };

  for (const entry of critical) {
    let row: Awaited<ReturnType<typeof getExtensionByName>>;
    try {
      row = await getExtensionByName(entry.name);
    } catch (e) {
      log.error("CRITICAL extension lookup failed — cannot assert invariant", {
        name: entry.name,
        error: String(e),
      });
      result.unremediated.push(entry.name);
      continue;
    }

    if (!row) {
      // Install failed earlier in ensureBundledExtensions — that path
      // already logged. Surface here too: a missing critical extension
      // is as bad as a disabled one (agents can't ask the user).
      log.error(
        `CRITICAL extension ${entry.name} not installed — ${consequenceFor(entry.name)}`,
        { name: entry.name },
      );
      result.violations.push(entry.name);
      result.unremediated.push(entry.name);
      continue;
    }

    if (row.enabled === true) {
      continue; // invariant holds
    }

    // ── Deliberate user opt-out ──────────────────────────────────────
    // Checked BEFORE the violation branch: re-enabling here would undo
    // the user's choice on every boot, which is the bug this whole
    // column exists to fix.
    if (row.disabledByUser === true) {
      result.userDisabled.push(entry.name);
      log.warn(
        `CRITICAL extension ${entry.name} disabled by the user — ${consequenceFor(entry.name)} unless another extension provides the same tool`,
        { name: entry.name, extensionId: row.id },
      );
      continue;
    }

    // ── Violation ────────────────────────────────────────────────────
    result.violations.push(entry.name);
    log.error(
      `CRITICAL extension ${entry.name} disabled — ${consequenceFor(entry.name)}`,
      { name: entry.name, extensionId: row.id },
    );

    // One-time remediation: re-enable IFF on-disk perms are within
    // the bundled ceiling. The ceiling stays the hard security bound.
    let diskManifest: ExtensionManifestV2 | null = null;
    try {
      diskManifest = await loadManifestFresh(
        join(getProjectRoot(), entry.path),
      );
    } catch (e) {
      log.error(
        `CRITICAL extension ${entry.name} disabled and on-disk manifest unreadable — NOT auto-re-enabled`,
        { name: entry.name, error: String(e) },
      );
      result.unremediated.push(entry.name);
      continue;
    }

    // Normalize `grantedAt` before the ceiling check — see the S9 gate
    // note in bundled.ts: a perms object without `grantedAt` is treated
    // as different from the intersection result, producing a false
    // `clamped:true`.
    const rawPerms = (diskManifest.permissions ?? {}) as ExtensionPermissions;
    const diskPerms: ExtensionPermissions = {
      ...rawPerms,
      grantedAt: rawPerms.grantedAt ?? {},
    };
    const { clamped } = clampToBundledCeiling(entry.name, diskPerms);
    if (clamped) {
      // Exceeds the ceiling — leave disabled (security floor). The
      // ERROR above stands; an operator must investigate.
      log.error(
        `CRITICAL extension ${entry.name} disabled and on-disk perms EXCEED the bundled ceiling — NOT auto-re-enabled (security floor)`,
        { name: entry.name },
      );
      result.unremediated.push(entry.name);
      continue;
    }

    try {
      await updateExtension(row.id, { enabled: true });
      result.remediated.push(entry.name);
      log.warn(
        `CRITICAL extension ${entry.name} was disabled but on-disk perms are within ceiling — one-time re-enabled`,
        { name: entry.name, extensionId: row.id },
      );
      const meta: ExtensionAuditMetadata = {
        permission: undefined,
        oldValue: false,
        newValue: true,
        actor: "system",
        extensionName: entry.name,
        reason:
          "critical-invariant-remediation: disabled critical extension " +
          "re-enabled at startup (on-disk perms within bundled ceiling)",
      };
      await insertAuditEntry(
        null,
        EXT_AUDIT_ACTIONS.BUNDLED_CRITICAL_AUTO_REAPPROVED,
        row.id,
        meta,
      );
    } catch (e) {
      log.error(`CRITICAL extension ${entry.name} re-enable failed`, {
        name: entry.name,
        error: String(e),
      });
      result.unremediated.push(entry.name);
    }
  }

  return result;
}
