/**
 * Centralized security enforcement for extensions.
 * Deny-and-disable logic with structured violation events and violation history tracking.
 */

import { disableExtension } from "../db/queries/extensions";
import { getSetting, upsertSetting } from "../db/queries/settings";

export interface SecurityViolation {
  extensionId: string;
  reason: string;
  path: string;
  timestamp: number;
}

/**
 * Disable an extension due to a security violation, record the violation, and return a structured event.
 */
export async function denyAndDisable(
  extensionId: string,
  reason: string,
  path: string,
): Promise<SecurityViolation> {
  await disableExtension(extensionId);

  // Track violation history
  const key = `ext:${extensionId}:violations`;
  const existing = ((await getSetting(key)) as SecurityViolation[] | null) ?? [];
  const violation: SecurityViolation = { extensionId, reason, path, timestamp: Date.now() };
  existing.push(violation);
  await upsertSetting(key, existing);

  return violation;
}

/**
 * Check if an extension has been disabled due to a security violation.
 */
export async function hasSecurityViolation(extensionId: string): Promise<boolean> {
  const key = `ext:${extensionId}:violations`;
  const violations = (await getSetting(key)) as SecurityViolation[] | null | undefined;
  return Array.isArray(violations) && violations.length > 0;
}

/**
 * Get the full violation history for an extension.
 */
export async function getSecurityViolations(extensionId: string): Promise<SecurityViolation[]> {
  const key = `ext:${extensionId}:violations`;
  return ((await getSetting(key)) as SecurityViolation[] | null) ?? [];
}

/**
 * Clear all security violations for an extension (admin action, for re-approval).
 */
export async function clearSecurityViolations(extensionId: string): Promise<void> {
  const key = `ext:${extensionId}:violations`;
  await upsertSetting(key, []);
}
