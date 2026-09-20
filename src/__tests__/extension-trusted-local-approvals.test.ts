import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { TRUSTED_LOCAL_OMITTED_CONTROLS } from "@ezcorp/extension-runner";
import {
  findTrustedLocalApproval,
  recordTrustedLocalApproval,
  recordTrustedLocalVerificationApproval,
  revokeTrustedLocalApprovals,
  TRUSTED_LOCAL_APPROVAL_TTL_MS,
  TRUSTED_LOCAL_VERIFICATION_WINDOW_MS,
} from "../db/queries/extension-trusted-local-approvals";

/**
 * The store behind `TrustedLocalRunner.approvalFor()`. What matters here is
 * the shape the runner's `authorize()` checks — exact digest, exact phase,
 * an approver, a future expiry, and EVERY omitted control — plus the two
 * things the table's key was designed for: expiry is invisible rather than
 * rejected, and revoking one installation's copy of a digest leaves another
 * installation's untouched.
 */
const A = "installation-a";
const B = "installation-b";
const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);
const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

beforeAll(async () => {
  await setupTestDb();
  // FK parents. The real rows carry a JSON installation record; the FK only
  // needs the id.
  for (const id of [A, B]) await getTestDb().execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES (${id}, 'user-1', 'global', ${JSON.stringify({ id })})`);
});

afterAll(async () => {
  await closeTestDb();
});

describe("recordTrustedLocalApproval / findTrustedLocalApproval", () => {
  test("a recorded approval is found with the full runner contract", async () => {
    const recorded = await recordTrustedLocalApproval({ installationId: A, phase: "build", digest: DIGEST, approvedBy: "user-1", now: NOW });
    expect(recorded).toEqual({ digest: DIGEST, phase: "build", approvedBy: "user-1", expiresAt: NOW + TRUSTED_LOCAL_APPROVAL_TTL_MS, omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] });
    // The runner rejects an approval naming FEWER controls than it omits, so
    // there is exactly one list this store may ever write.
    expect(recorded.omittedControls).toHaveLength(7);
    expect(await findTrustedLocalApproval("build", DIGEST, NOW)).toEqual(recorded);
  });

  test("phase and digest are both part of the identity", async () => {
    expect(await findTrustedLocalApproval("execute", DIGEST, NOW)).toBeNull();
    expect(await findTrustedLocalApproval("build", OTHER, NOW)).toBeNull();
  });

  test("an expired approval is invisible, not returned for the runner to reject", async () => {
    const expiry = NOW + TRUSTED_LOCAL_APPROVAL_TTL_MS;
    expect(await findTrustedLocalApproval("build", DIGEST, expiry - 1)).not.toBeNull();
    expect(await findTrustedLocalApproval("build", DIGEST, expiry)).toBeNull();
    expect(await findTrustedLocalApproval("build", DIGEST, expiry + 1)).toBeNull();
  });

  test("re-recording refreshes the expiry and approver in place — one row per (installation, phase, digest)", async () => {
    const later = NOW + 1000;
    await recordTrustedLocalApproval({ installationId: A, phase: "build", digest: DIGEST, approvedBy: "user-2", now: later });
    const found = await findTrustedLocalApproval("build", DIGEST, later);
    expect(found?.approvedBy).toBe("user-2");
    expect(found?.expiresAt).toBe(later + TRUSTED_LOCAL_APPROVAL_TTL_MS);
    const rows = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM extension_trusted_local_approvals WHERE installation_id = ${A} AND phase = 'build' AND digest = ${DIGEST}`);
    const n = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows)[0] as { n: number };
    expect(n.n).toBe(1);
  });

  test("the 180-day TTL is finite and long", () => {
    expect(TRUSTED_LOCAL_APPROVAL_TTL_MS).toBe(180 * 24 * 60 * 60 * 1000);
  });

  test("an unknown installation cannot hold an approval (FK)", async () => {
    await expect(recordTrustedLocalApproval({ installationId: "no-such-installation", phase: "execute", digest: DIGEST, approvedBy: "user-1", now: NOW })).rejects.toThrow();
  });
});

describe("recordTrustedLocalVerificationApproval — the build acknowledgement extended to verifying its artifact", () => {
  const SOURCE = "e".repeat(64);
  const ARTIFACT = "f".repeat(64);

  test("refuses when the installation holds no live build approval for the source", async () => {
    expect(await recordTrustedLocalVerificationApproval({ installationId: A, sourceDigest: SOURCE, artifactDigest: ARTIFACT, now: NOW })).toBeNull();
    expect(await findTrustedLocalApproval("execute", ARTIFACT, NOW)).toBeNull();
  });

  test("derives a SHORT execute approval from the build row: same approver, same controls, fifteen minutes", async () => {
    await recordTrustedLocalApproval({ installationId: A, phase: "build", digest: SOURCE, approvedBy: "user-9", now: NOW });
    const granted = await recordTrustedLocalVerificationApproval({ installationId: A, sourceDigest: SOURCE, artifactDigest: ARTIFACT, now: NOW });
    expect(granted).toEqual({ digest: ARTIFACT, phase: "execute", approvedBy: "user-9", expiresAt: NOW + TRUSTED_LOCAL_VERIFICATION_WINDOW_MS, omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] });
    expect(TRUSTED_LOCAL_VERIFICATION_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(TRUSTED_LOCAL_VERIFICATION_WINDOW_MS).toBeLessThan(TRUSTED_LOCAL_APPROVAL_TTL_MS);
    expect(await findTrustedLocalApproval("execute", ARTIFACT, NOW + TRUSTED_LOCAL_VERIFICATION_WINDOW_MS - 1)).toEqual(granted);
    expect(await findTrustedLocalApproval("execute", ARTIFACT, NOW + TRUSTED_LOCAL_VERIFICATION_WINDOW_MS)).toBeNull();
  });

  test("an expired build approval grants nothing", async () => {
    const later = NOW + TRUSTED_LOCAL_APPROVAL_TTL_MS + 1;
    expect(await recordTrustedLocalVerificationApproval({ installationId: A, sourceDigest: SOURCE, artifactDigest: "0".repeat(64), now: later })).toBeNull();
  });

  test("a later release approval for the same artifact replaces the short window with the long one", async () => {
    await recordTrustedLocalApproval({ installationId: A, phase: "execute", digest: ARTIFACT, approvedBy: "user-9", now: NOW });
    expect((await findTrustedLocalApproval("execute", ARTIFACT, NOW))?.expiresAt).toBe(NOW + TRUSTED_LOCAL_APPROVAL_TTL_MS);
  });
});

describe("revokeTrustedLocalApprovals — per installation, never per digest across installations", () => {
  test("two installations built from identical source share a digest; revoking one leaves the other", async () => {
    // A fresh digest: the build-phase tests above left A holding DIGEST, and a
    // revoke by digest withdraws BOTH phases for that installation.
    const SHARED = "c".repeat(64);
    await recordTrustedLocalApproval({ installationId: A, phase: "execute", digest: SHARED, approvedBy: "user-1", now: NOW });
    await recordTrustedLocalApproval({ installationId: B, phase: "execute", digest: SHARED, approvedBy: "user-1", now: NOW });
    expect(await revokeTrustedLocalApprovals(A, SHARED)).toBe(1);
    // The runner asks by (phase, digest) only and any live row satisfies it.
    expect(await findTrustedLocalApproval("execute", SHARED, NOW)).not.toBeNull();
    expect(await revokeTrustedLocalApprovals(B, SHARED)).toBe(1);
    expect(await findTrustedLocalApproval("execute", SHARED, NOW)).toBeNull();
  });

  test("revoking by digest withdraws every phase that installation holds for it", async () => {
    const BOTH = "d".repeat(64);
    await recordTrustedLocalApproval({ installationId: A, phase: "build", digest: BOTH, approvedBy: "user-1", now: NOW });
    await recordTrustedLocalApproval({ installationId: A, phase: "execute", digest: BOTH, approvedBy: "user-1", now: NOW });
    expect(await revokeTrustedLocalApprovals(A, BOTH)).toBe(2);
    expect(await findTrustedLocalApproval("build", BOTH, NOW)).toBeNull();
    expect(await findTrustedLocalApproval("execute", BOTH, NOW)).toBeNull();
  });

  test("without a digest, every phase for the installation goes — disable / uninstall", async () => {
    await recordTrustedLocalApproval({ installationId: B, phase: "build", digest: OTHER, approvedBy: "user-1", now: NOW });
    await recordTrustedLocalApproval({ installationId: B, phase: "execute", digest: OTHER, approvedBy: "user-1", now: NOW });
    expect(await revokeTrustedLocalApprovals(B)).toBe(2);
    expect(await findTrustedLocalApproval("build", OTHER, NOW)).toBeNull();
    expect(await findTrustedLocalApproval("execute", OTHER, NOW)).toBeNull();
    // Idempotent: nothing left is not an error.
    expect(await revokeTrustedLocalApprovals(B)).toBe(0);
  });
});
