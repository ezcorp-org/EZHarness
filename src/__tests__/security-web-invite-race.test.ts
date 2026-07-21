/**
 * Security regression (db-audit/security-web): single-use invites must be
 * claimable exactly once.
 *
 * Pre-fix markInviteUsed() was an unconditional UPDATE with no
 * `usedAt IS NULL` guard, so two concurrent redemptions of one token could
 * both pass the getInviteByToken check and both mint accounts — an
 * admin-role invite could spawn multiple admins. The fix makes it an atomic
 * compare-and-set (UPDATE ... WHERE usedAt IS NULL RETURNING). These tests
 * run against a real PGlite instance so the DB-level guard is exercised.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createInvite, markInviteUsed, getInviteByToken } = await import(
  "../db/queries/invites"
);
const { createUser } = await import("../db/queries/users");

let adminId: string;

beforeAll(async () => {
  await setupTestDb();
  const admin = await createUser({
    email: "invite-race-admin@example.com",
    passwordHash: "hashed",
    name: "Race Admin",
    role: "admin",
    status: "active",
  });
  adminId = admin.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("markInviteUsed atomic claim", () => {
  test("a second sequential claim on the same invite returns false", async () => {
    const invite = await createInvite({ role: "admin", createdBy: adminId });

    const first = await markInviteUsed(invite.id);
    const second = await markInviteUsed(invite.id);

    expect(first).toBe(true);
    expect(second).toBe(false);

    // And the token is no longer redeemable via the (usedAt IS NULL) lookup.
    expect(await getInviteByToken(invite.token)).toBeUndefined();
  });

  test("concurrent claims: exactly ONE wins", async () => {
    const invite = await createInvite({ role: "admin", createdBy: adminId });

    // Fire N concurrent claims at the same token. The atomic guard must let
    // exactly one flip usedAt; every other claim sees the row already used
    // and returns false. Pre-fix (unconditional UPDATE) all N returned true.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => markInviteUsed(invite.id)),
    );

    const winners = results.filter((r) => r === true);
    expect(winners).toHaveLength(1);
  });

  test("claiming a nonexistent invite returns false", async () => {
    expect(await markInviteUsed("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
