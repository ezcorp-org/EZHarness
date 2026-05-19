/**
 * PHASE 1 — Unit tests for `resolveRootConversationForOwnership`.
 *
 * The helper is the single extraction of the bounded parent-walk that
 * lived inline in `agent-chat/+server.ts:86–107`. These tests pin its
 * full contract so Phase-2's adoption by the per-message endpoints (and
 * any future caller) is provably safe:
 *
 *   - top-level own / admin / deny  (root === self, the legacy path)
 *   - 1-deep sub-conversation       (userId=null sub → owned root)
 *   - 2-deep team nest              (member → orchestrator → main)
 *   - over-deep / cycle bound       (no infinite loop, fail-closed)
 *   - missing conversation → null   (caller emits 404)
 *   - missing parent → null         (fail-closed, no access leaked)
 *
 * ## Legacy reach equivalence (pinned by the over-deep test)
 *
 * The pre-extraction agent-chat walk seeded its loop at the sub-conv's
 * DIRECT PARENT (`rootConv = directParent`) and took up to 8 more hops
 * (`depth < 8`), so from a sub-conv it reached an ancestor up to 9
 * levels above. This helper seeds the walk at the conversation ITSELF
 * (hop 0), so the equivalent bound is `8 + 1 = 9` (`MAX_PARENT_DEPTH`)
 * — the extra iteration is the hop onto the direct parent. The
 * "walk stops after MAX_PARENT_DEPTH hops" test below pins that bound
 * (and its `1 + MAX_PARENT_DEPTH` call count) precisely so a future
 * change can't silently make the helper one hop shallower than the
 * legacy agent-chat code (Phase 1's "no behaviour change" contract).
 *   - return SHAPE: { conv: self, root: top } — agent-chat relies on
 *     `conv` (self) for model fallbacks and `root` for the
 *     complete-event parentConversationId, so both ends must be exact.
 *
 * `vitest` with the conversations query module mocked at the import
 * boundary — no PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();

// ONLY the DB dependency is mocked. The module under test
// (`conversation-ownership`) is imported REAL below so v8 instruments
// its real source — see the "drives the REAL module" guard test.
vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

const ownershipModule = await import("../lib/server/conversation-ownership");
const { resolveRootConversationForOwnership, MAX_PARENT_DEPTH } =
  ownershipModule;

type Role = "admin" | "member";
const owner = { id: "owner-1", email: "o@x", name: "O", role: "member" as Role };
const admin = { id: "admin-1", email: "a@x", name: "A", role: "admin" as Role };
const stranger = { id: "stranger-1", email: "s@x", name: "S", role: "member" as Role };

function conv(
  id: string,
  parentConversationId: string | null,
  userId: string | null,
) {
  return { id, parentConversationId, userId, projectId: "p", model: null, provider: null };
}

beforeEach(() => {
  getConversation.mockReset();
});

// ── Real-module instrumentation guard ────────────────────────────────
//
// The suite mocks ONLY the DB query dependency; the helper itself is
// imported real so `@vitest/coverage-v8` instruments
// `src/lib/server/conversation-ownership.ts`. This guard pins that
// invariant in-code so a future refactor can't silently swap the
// subject for a stub (which would make the 19 behaviour tests pass
// while leaving the real module at 0% — the exact gap this fix closes).
describe("instruments the REAL conversation-ownership module", () => {
  test("subject is the genuine implementation, not a vi.fn mock", () => {
    // A vi.fn / vi.mock'd function carries `.mock`; the real exported
    // async function does not. This proves the behaviour tests below
    // execute (and therefore v8-cover) the real source file.
    expect(
      (resolveRootConversationForOwnership as unknown as { mock?: unknown })
        .mock,
    ).toBeUndefined();
    expect(typeof resolveRootConversationForOwnership).toBe("function");
    expect(resolveRootConversationForOwnership.name).toBe(
      "resolveRootConversationForOwnership",
    );
    // The real module re-exports the bound from its own source.
    expect(MAX_PARENT_DEPTH).toBe(9);
    // The ONLY mocked surface is the DB dependency.
    expect(
      (getConversation as unknown as { mock?: unknown }).mock,
    ).toBeDefined();
  });

  test("real walk executes against the mocked DB (not a stubbed return)", async () => {
    // Drive a 2-hop chain: if the REAL walk runs, getConversation is
    // called once per node (self + 2 ancestors). A stubbed subject
    // would not fan out these dependency calls.
    getConversation.mockImplementation(async (id: string) => {
      if (id === "leaf") return conv("leaf", "mid", null);
      if (id === "mid") return conv("mid", "top", null);
      if (id === "top") return conv("top", null, owner.id);
      return null;
    });
    const res = await resolveRootConversationForOwnership("leaf", owner);
    expect(res).not.toBeNull();
    expect(res!.conv.id).toBe("leaf");
    expect(res!.root.id).toBe("top");
    // self + 2 parent hops = 3 real dependency calls.
    expect(getConversation).toHaveBeenCalledTimes(3);
  });
});

// ── Top-level (root === self) — the legacy direct-check path ─────────

describe("top-level conversation (parentless → root === self)", () => {
  test("owner: returns { conv:self, root:self }", async () => {
    const top = conv("top-1", null, owner.id);
    getConversation.mockImplementation(async (id: string) =>
      id === "top-1" ? top : null,
    );

    const res = await resolveRootConversationForOwnership("top-1", owner);
    expect(res).not.toBeNull();
    expect(res!.conv.id).toBe("top-1");
    expect(res!.root.id).toBe("top-1");
    expect(res!.conv).toBe(res!.root); // identical object for parentless
  });

  test("admin (non-owner): authorized", async () => {
    getConversation.mockResolvedValue(conv("top-1", null, "someone-else"));
    const res = await resolveRootConversationForOwnership("top-1", admin);
    expect(res).not.toBeNull();
    expect(res!.root.id).toBe("top-1");
  });

  test("non-owner non-admin: null (caller → 404)", async () => {
    getConversation.mockResolvedValue(conv("top-1", null, "someone-else"));
    const res = await resolveRootConversationForOwnership("top-1", stranger);
    expect(res).toBeNull();
  });

  test("userId=null top-level, non-admin: null (sec-H3 fail-closed)", async () => {
    getConversation.mockResolvedValue(conv("top-1", null, null));
    const res = await resolveRootConversationForOwnership("top-1", stranger);
    expect(res).toBeNull();
  });

  test("userId=null top-level, admin: authorized", async () => {
    getConversation.mockResolvedValue(conv("top-1", null, null));
    const res = await resolveRootConversationForOwnership("top-1", admin);
    expect(res).not.toBeNull();
  });
});

// ── 1-deep sub-conversation ──────────────────────────────────────────

describe("1-deep sub-conversation (sub.userId=null → owned root)", () => {
  function graph() {
    getConversation.mockImplementation(async (id: string) => {
      if (id === "sub-1") return conv("sub-1", "root-1", null);
      if (id === "root-1") return conv("root-1", null, owner.id);
      return null;
    });
  }

  test("root owner: authorized, conv=self sub, root=top", async () => {
    graph();
    const res = await resolveRootConversationForOwnership("sub-1", owner);
    expect(res).not.toBeNull();
    expect(res!.conv.id).toBe("sub-1"); // self
    expect(res!.root.id).toBe("root-1"); // ownership-bearing top
  });

  test("non-owner non-admin: null even though sub.userId is null", async () => {
    graph();
    const res = await resolveRootConversationForOwnership("sub-1", stranger);
    expect(res).toBeNull();
  });

  test("admin: authorized regardless of root owner", async () => {
    graph();
    const res = await resolveRootConversationForOwnership("sub-1", admin);
    expect(res).not.toBeNull();
    expect(res!.root.id).toBe("root-1");
  });
});

// ── 2-deep team nest (member → orchestrator → main) ──────────────────

describe("2-deep team nest (member → orchestrator → main)", () => {
  function teamGraph(mainOwner: string | null) {
    getConversation.mockImplementation(async (id: string) => {
      if (id === "member") return conv("member", "orchestrator", null);
      if (id === "orchestrator") return conv("orchestrator", "main", null);
      if (id === "main") return conv("main", null, mainOwner);
      return null;
    });
  }

  test("walks two levels to the user-owned main; conv stays the member", async () => {
    teamGraph(owner.id);
    const res = await resolveRootConversationForOwnership("member", owner);
    expect(res).not.toBeNull();
    expect(res!.conv.id).toBe("member"); // self (model-fallback scope)
    expect(res!.root.id).toBe("main"); // complete-event parentConversationId
  });

  test("non-owner non-admin: null (root main owned by another user)", async () => {
    teamGraph("different-user");
    const res = await resolveRootConversationForOwnership("member", stranger);
    expect(res).toBeNull();
  });

  test("admin: authorized through the 2-level nest", async () => {
    teamGraph("different-user");
    const res = await resolveRootConversationForOwnership("member", admin);
    expect(res).not.toBeNull();
    expect(res!.root.id).toBe("main");
  });
});

// ── depth > 8 cycle bound ────────────────────────────────────────────

describe("bounded walk (cycle / over-deep chain)", () => {
  test("2-node cycle does not infinite-loop; resolves a Response-able result", async () => {
    // a → b → a → b … the bounded loop must terminate.
    getConversation.mockImplementation(async (id: string) => {
      if (id === "cycle-a") return conv("cycle-a", "cycle-b", owner.id);
      if (id === "cycle-b") return conv("cycle-b", "cycle-a", owner.id);
      return null;
    });
    const res = await resolveRootConversationForOwnership("cycle-a", owner);
    // Both nodes are owner-owned, so whatever the bounded walk lands on
    // authorizes. The contract under test is "terminates", not "which".
    expect(res).not.toBeNull();
  });

  test("cycle owned by a stranger fails closed (null), still terminates", async () => {
    getConversation.mockImplementation(async (id: string) => {
      if (id === "cycle-a") return conv("cycle-a", "cycle-b", null);
      if (id === "cycle-b") return conv("cycle-b", "cycle-a", null);
      return null;
    });
    const res = await resolveRootConversationForOwnership("cycle-a", stranger);
    expect(res).toBeNull();
  });

  test("walk stops after MAX_PARENT_DEPTH hops (long owned chain) — legacy-equivalent reach", async () => {
    // n0 → n1 → … → n20, queried as a SUB-conv (n0). Only the very top
    // (n20) is owner-owned; every intermediate is userId=null. A
    // non-admin must be DENIED because the bounded walk never reaches
    // n20.
    //
    // Legacy-equivalence pin: the pre-extraction agent-chat walk for a
    // sub-conv n0 seeded at its DIRECT PARENT n1 (1 getConversation
    // call) then looped `depth < 8` over n2..n9 (8 more calls) —
    // reaching n9. This helper seeds at n0 itself (hop 0) and loops
    // `depth < MAX_PARENT_DEPTH` (= 8 + 1 = 9) over n1..n9 — ALSO
    // reaching n9. Same furthest-reachable ancestor (n9), so the swap
    // is behaviour-preserving. Either way n9.userId is null and a
    // non-admin is denied.
    getConversation.mockImplementation(async (id: string) => {
      const n = Number(id.slice(1));
      if (Number.isNaN(n) || n < 0 || n > 20) return null;
      return conv(`n${n}`, n < 20 ? `n${n + 1}` : null, n === 20 ? owner.id : null);
    });
    const res = await resolveRootConversationForOwnership("n0", owner);
    // Furthest reachable is n9 (userId=null) → owner is NOT admin → null.
    expect(res).toBeNull();
    // Self (n0) + MAX_PARENT_DEPTH (9) walk fetches = 10 getConversation
    // calls. MAX_PARENT_DEPTH is the legacy-equivalent self-seeded bound
    // (legacy 8 hops above the direct parent + 1 hop onto it).
    expect(MAX_PARENT_DEPTH).toBe(9);
    expect(getConversation).toHaveBeenCalledTimes(1 + MAX_PARENT_DEPTH);
  });

  test("admin bypasses the depth bound denial (role overrides ownership)", async () => {
    getConversation.mockImplementation(async (id: string) => {
      const n = Number(id.slice(1));
      if (Number.isNaN(n) || n < 0 || n > 20) return null;
      return conv(`n${n}`, n < 20 ? `n${n + 1}` : null, null);
    });
    const res = await resolveRootConversationForOwnership("n0", admin);
    expect(res).not.toBeNull();
  });
});

// ── Missing rows → null (fail-closed) ────────────────────────────────

describe("missing rows fail closed (null ⇒ caller 404)", () => {
  test("requested conversation missing → null", async () => {
    getConversation.mockResolvedValue(null);
    const res = await resolveRootConversationForOwnership("nope", owner);
    expect(res).toBeNull();
  });

  test("missing parent: walk stops at the unowned sub → non-admin null", async () => {
    getConversation.mockImplementation(async (id: string) =>
      id === "sub-1" ? conv("sub-1", "gone-parent", null) : null,
    );
    const res = await resolveRootConversationForOwnership("sub-1", stranger);
    expect(res).toBeNull();
  });

  test("missing parent but the sub itself is owner-owned → authorized at self", async () => {
    // Defensive: a sub row that happens to carry a userId and a dangling
    // parent still authorizes its owner against itself (root falls back
    // to the furthest resolvable node = the sub).
    getConversation.mockImplementation(async (id: string) =>
      id === "sub-1" ? conv("sub-1", "gone-parent", owner.id) : null,
    );
    const res = await resolveRootConversationForOwnership("sub-1", owner);
    expect(res).not.toBeNull();
    expect(res!.root.id).toBe("sub-1");
  });

  test("missing parent: admin still authorized (role overrides)", async () => {
    getConversation.mockImplementation(async (id: string) =>
      id === "sub-1" ? conv("sub-1", "gone-parent", null) : null,
    );
    const res = await resolveRootConversationForOwnership("sub-1", admin);
    expect(res).not.toBeNull();
  });
});
