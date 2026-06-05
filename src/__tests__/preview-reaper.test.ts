/**
 * Secure-preview reaper (Phase 3b). reapPreviewConversation must kill the
 * dev-server processes (through the setuid helper's --kill mode), revoke the
 * DB previews + forget their quota accounting, release the uid ONLY when the
 * kill is CONFIRMED (else QUARANTINE it), release netns, and drop the
 * watcher's watch — surviving any single step failing.
 *
 * The kill-confirmation → uid-release-vs-quarantine branch is the core
 * integrity fix: an unconfirmed kill can leave a live orphan owning the uid,
 * so the uid MUST NOT be returned to the allocatable pool.
 */
import { test, expect, describe } from "bun:test";
import { reapPreviewConversation } from "../runtime/preview/preview-reaper";

function deps(over: Record<string, unknown> = {}) {
  const calls = {
    killed: [] as string[],
    revoked: [] as string[],
    uid: [] as string[],
    quarantined: [] as string[],
    netns: [] as string[],
    unwatched: [] as string[],
    forgot: [] as string[],
  };
  const d = {
    killProcesses: async (c: string) => { calls.killed.push(c); return { killed: 2, unconfirmed: 0 }; },
    revokePreviews: async (c: string) => { calls.revoked.push(c); return ["p1", "p2", "p3"]; },
    reapUid: (c: string) => { calls.uid.push(c); return true; },
    quarantineUid: (c: string) => { calls.quarantined.push(c); return true; },
    reapNetns: (c: string) => { calls.netns.push(c); return false; },
    unwatch: (c: string) => { calls.unwatched.push(c); },
    forgetQuota: (id: string) => { calls.forgot.push(id); },
    ...over,
  };
  return { d, calls };
}

describe("reapPreviewConversation", () => {
  test("confirmed kill: revokes + forgets quota + RELEASES uid + drops watch", async () => {
    const { d, calls } = deps();
    const res = await reapPreviewConversation("conv-1", d);
    expect(res).toMatchObject({
      conversationId: "conv-1",
      processesKilled: 2,
      processesUnconfirmed: 0,
      previewsRevoked: 3,
      uidReleased: true,
      uidQuarantined: false,
    });
    expect(calls.killed).toEqual(["conv-1"]);
    expect(calls.revoked).toEqual(["conv-1"]);
    expect(calls.uid).toEqual(["conv-1"]); // released, not quarantined
    expect(calls.quarantined).toEqual([]);
    expect(calls.netns).toEqual(["conv-1"]);
    expect(calls.unwatched).toEqual(["conv-1"]);
    // Every revoked preview id had its quota forgotten (no per-id leak).
    expect(calls.forgot).toEqual(["p1", "p2", "p3"]);
  });

  test("UNCONFIRMED kill: uid is QUARANTINED, not released (orphan-reuse barrier)", async () => {
    const { d, calls } = deps({
      killProcesses: async () => ({ killed: 1, unconfirmed: 1 }),
    });
    const res = await reapPreviewConversation("conv-q", d);
    expect(res.processesKilled).toBe(1);
    expect(res.processesUnconfirmed).toBe(1);
    expect(res.uidReleased).toBe(false);
    expect(res.uidQuarantined).toBe(true);
    expect(calls.uid).toEqual([]); // NOT released
    expect(calls.quarantined).toEqual(["conv-q"]); // quarantined instead
  });

  test("a THROWN killer quarantines the uid (fail-closed — don't release on unknown)", async () => {
    const { d, calls } = deps({
      killProcesses: async () => { throw new Error("kill boom"); },
    });
    const res = await reapPreviewConversation("conv-3", d);
    expect(res.processesKilled).toBe(0);
    expect(res.uidReleased).toBe(false);
    expect(res.uidQuarantined).toBe(true);
    expect(calls.quarantined).toEqual(["conv-3"]);
    // revoke still ran despite the kill throw.
    expect(res.previewsRevoked).toBe(3);
  });

  test("empty conversationId is a no-op", async () => {
    const { d, calls } = deps();
    const res = await reapPreviewConversation("", d);
    expect(res.processesKilled).toBe(0);
    expect(calls.killed).toHaveLength(0);
  });

  test("a failing revoke does not block kill or uid-release (and forgets nothing)", async () => {
    const { d, calls } = deps({
      revokePreviews: async () => { throw new Error("db down"); },
    });
    const res = await reapPreviewConversation("conv-2", d);
    expect(res.processesKilled).toBe(2); // kill still ran (confirmed)
    expect(res.previewsRevoked).toBe(0); // revoke failed → 0
    expect(res.uidReleased).toBe(true); // confirmed kill → uid released
    expect(calls.forgot).toEqual([]); // nothing to forget
    expect(calls.unwatched).toEqual(["conv-2"]); // watch still dropped
  });

  test("a failing quota-forget does not block the rest of the sweep", async () => {
    const { d, calls } = deps({
      forgetQuota: () => { throw new Error("forget boom"); },
    });
    const res = await reapPreviewConversation("conv-f", d);
    expect(res.previewsRevoked).toBe(3); // revoke still counted
    expect(res.uidReleased).toBe(true);
    expect(calls.unwatched).toEqual(["conv-f"]);
  });
});
