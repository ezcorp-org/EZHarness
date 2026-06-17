import { describe, expect, test } from "bun:test";
import {
  PROPOSALS_SCHEMA_VERSION,
  addSuppressed,
  canTransition,
  dedupeKey,
  emptyProposalsFile,
  findProposal,
  isSuppressed,
  loadProposals,
  pruneSuppressed,
  replaceProposal,
  saveProposals,
  shouldSkipCandidate,
  suppressedKey,
  transition,
  type Proposal,
  type ProposalsIO,
  type SuppressedEntry,
} from "./proposals";

function p(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "move",
    src: "/w/a.txt",
    dst: "/w/sub/a.txt",
    reason: "route",
    ruleId: "r1",
    ruleLabel: "Route",
    folderId: "f1",
    snapshot: { size: 10, mtimeMs: 1, isSymlink: false, dev: 1, ino: 2, nlink: 1 },
    status: "pending",
    dedupeKey: dedupeKey({ kind: "move", src: "/w/a.txt", dst: "/w/sub/a.txt", ruleId: "r1" }),
    createdAt: "2026-06-17T00:00:00.000Z",
    version: 0,
    ...overrides,
  };
}

describe("dedupeKey / suppressedKey", () => {
  test("dedupeKey is stable + includes all parts", () => {
    expect(dedupeKey({ kind: "move", src: "/a", dst: "/b", ruleId: "r" })).toBe("move|/a|r|/b");
    expect(dedupeKey({ kind: "delete-quarantine", src: "/a", dst: null, ruleId: null })).toBe("delete-quarantine|/a||");
  });
  test("suppressedKey keys on path+rule+hash", () => {
    expect(suppressedKey({ src: "/a", ruleId: "r", contentHash: "h" })).toBe("/a|r|h");
    expect(suppressedKey({ src: "/a", ruleId: null, contentHash: null })).toBe("/a||");
  });
});

describe("state machine", () => {
  test("legal + illegal transitions", () => {
    expect(canTransition("pending", "applied")).toBe(true);
    expect(canTransition("pending", "rejected")).toBe(true);
    expect(canTransition("pending", "pending")).toBe(false);
    expect(canTransition("applied", "pending")).toBe(false);
    expect(canTransition("rejected", "applied")).toBe(false);
    expect(canTransition("failed", "pending")).toBe(true);
    expect(canTransition("blocked", "applied")).toBe(true);
    expect(canTransition("stale-source", "rejected")).toBe(true);
  });

  test("transition bumps version + stamps terminal fields", () => {
    const applied = transition(p(), "applied", { by: "u1", at: "2026-06-17T01:00:00.000Z" });
    expect(applied).not.toBeNull();
    expect(applied!.status).toBe("applied");
    expect(applied!.version).toBe(1);
    expect(applied!.resolvedBy).toBe("u1");
    expect(applied!.resolvedAt).toBe("2026-06-17T01:00:00.000Z");
  });

  test("non-terminal transition does not stamp resolvedAt", () => {
    const failed = transition(p(), "failed");
    expect(failed!.resolvedAt).toBeUndefined();
  });

  test("illegal transition returns null", () => {
    expect(transition(p({ status: "applied" }), "pending")).toBeNull();
  });

  test("CAS: stale expectedVersion returns null (no-op)", () => {
    expect(transition(p({ version: 3 }), "applied", { expectedVersion: 2 })).toBeNull();
    expect(transition(p({ version: 3 }), "applied", { expectedVersion: 3 })).not.toBeNull();
  });

  test("transition carries quarantineId + batchId", () => {
    const dq = p({ kind: "delete-quarantine", dst: null });
    const applied = transition(dq, "applied", { quarantineId: "q9", batchId: "b1" });
    expect(applied!.quarantineId).toBe("q9");
    expect(applied!.batchId).toBe("b1");
  });
});

describe("suppressed-set TTL", () => {
  const now = 1_000_000_000_000;
  const suppressed: SuppressedEntry[] = [
    { key: suppressedKey({ src: "/a", ruleId: "r", contentHash: "h1" }), suppressedAt: new Date(now).toISOString(), contentHash: "h1" },
  ];

  test("matches within TTL with same hash", () => {
    expect(isSuppressed(suppressed, { src: "/a", ruleId: "r", contentHash: "h1" }, now + 1000)).toBe(true);
  });
  test("expires after TTL", () => {
    expect(isSuppressed(suppressed, { src: "/a", ruleId: "r", contentHash: "h1" }, now, 0)).toBe(false);
  });
  test("content change lifts suppression", () => {
    expect(isSuppressed(suppressed, { src: "/a", ruleId: "r", contentHash: "h2" }, now + 1000)).toBe(false);
  });
  test("null hashes fall back to path+rule suppression", () => {
    const s2 = addSuppressed([], { src: "/b", ruleId: null, contentHash: null }, new Date(now).toISOString());
    expect(isSuppressed(s2, { src: "/b", ruleId: null, contentHash: null }, now + 1)).toBe(true);
  });
  test("non-matching key is not suppressed", () => {
    expect(isSuppressed(suppressed, { src: "/zzz", ruleId: "r", contentHash: "h1" }, now + 1)).toBe(false);
  });

  test("a key match with a divergent stored hash lifts suppression (defensive)", () => {
    // Defensive branch: a stored entry whose `key` was built from one hash
    // but whose `contentHash` field disagrees (data drift). The key still
    // matches the candidate, but the explicit hash comparison must win and
    // lift suppression rather than wrongly suppress a changed file.
    const drifted: SuppressedEntry[] = [
      { key: suppressedKey({ src: "/a", ruleId: "r", contentHash: "h1" }), suppressedAt: new Date(now).toISOString(), contentHash: "h2" },
    ];
    expect(isSuppressed(drifted, { src: "/a", ruleId: "r", contentHash: "h1" }, now + 1000)).toBe(false);
  });

  test("addSuppressed replaces the same key (no dup)", () => {
    const once = addSuppressed([], { src: "/a", ruleId: "r", contentHash: "h" }, "t1");
    const twice = addSuppressed(once, { src: "/a", ruleId: "r", contentHash: "h" }, "t2");
    expect(twice).toHaveLength(1);
    expect(twice[0]!.suppressedAt).toBe("t2");
  });

  test("pruneSuppressed drops expired entries", () => {
    const pruned = pruneSuppressed(suppressed, now + 1, 0);
    expect(pruned).toHaveLength(0);
    expect(pruneSuppressed(suppressed, now + 1, 10_000)).toHaveLength(1);
  });
});

describe("shouldSkipCandidate", () => {
  const now = Date.now();
  test("skips when an equivalent pending proposal exists", () => {
    const file = { ...emptyProposalsFile(), proposals: [p()] };
    const skip = shouldSkipCandidate(file, { kind: "move", src: "/w/a.txt", dst: "/w/sub/a.txt", ruleId: "r1", contentHash: null }, now);
    expect(skip).toBe(true);
  });
  test("does not skip a different candidate", () => {
    const file = { ...emptyProposalsFile(), proposals: [p()] };
    const skip = shouldSkipCandidate(file, { kind: "move", src: "/w/other.txt", dst: "/w/sub/other.txt", ruleId: "r1", contentHash: null }, now);
    expect(skip).toBe(false);
  });
  test("does not skip when prior proposal is rejected", () => {
    const file = { ...emptyProposalsFile(), proposals: [p({ status: "rejected" })] };
    const skip = shouldSkipCandidate(file, { kind: "move", src: "/w/a.txt", dst: "/w/sub/a.txt", ruleId: "r1", contentHash: null }, now);
    expect(skip).toBe(false);
  });
  test("skips when suppressed", () => {
    const file = {
      ...emptyProposalsFile(),
      suppressed: addSuppressed([], { src: "/w/a.txt", ruleId: "r1", contentHash: "h" }, new Date(now).toISOString()),
    };
    const skip = shouldSkipCandidate(file, { kind: "move", src: "/w/a.txt", dst: "/w/sub/a.txt", ruleId: "r1", contentHash: "h" }, now + 1);
    expect(skip).toBe(true);
  });
});

describe("IO: load/save", () => {
  function memIO(initial: string | null): ProposalsIO & { last: string | null } {
    const state = { value: initial, last: null as string | null };
    return {
      get last() { return state.last; },
      read: async () => state.value,
      write: async (t) => { state.value = t; state.last = t; },
    };
  }

  test("missing file → empty, not corrupt", async () => {
    const { file, corrupt } = await loadProposals(memIO(null));
    expect(corrupt).toBe(false);
    expect(file.proposals).toHaveLength(0);
    expect(file.schemaVersion).toBe(PROPOSALS_SCHEMA_VERSION);
  });

  test("valid file round-trips", async () => {
    const io = memIO(null);
    const f = { ...emptyProposalsFile(), proposals: [p()] };
    await saveProposals(io, f);
    const { file, corrupt } = await loadProposals(io);
    expect(corrupt).toBe(false);
    expect(file.proposals).toHaveLength(1);
    expect(io.last).toContain('"p1"');
  });

  test("corrupt JSON recovers to empty + flags corrupt", async () => {
    const { file, corrupt } = await loadProposals(memIO("{not json"));
    expect(corrupt).toBe(true);
    expect(file.proposals).toHaveLength(0);
  });

  test("structurally-wrong file flags corrupt", async () => {
    const { corrupt } = await loadProposals(memIO(JSON.stringify({ proposals: "no", suppressed: [] })));
    expect(corrupt).toBe(true);
  });

  test("file missing schemaVersion defaults it", async () => {
    const { file } = await loadProposals(memIO(JSON.stringify({ proposals: [], suppressed: [] })));
    expect(file.schemaVersion).toBe(PROPOSALS_SCHEMA_VERSION);
  });
});

describe("find / replace", () => {
  test("findProposal", () => {
    const file = { ...emptyProposalsFile(), proposals: [p(), p({ id: "p2" })] };
    expect(findProposal(file, "p2")!.id).toBe("p2");
    expect(findProposal(file, "nope")).toBeUndefined();
  });
  test("replaceProposal swaps by id", () => {
    const file = { ...emptyProposalsFile(), proposals: [p(), p({ id: "p2" })] };
    const updated = replaceProposal(file, p({ id: "p2", status: "applied" }));
    expect(findProposal(updated, "p2")!.status).toBe("applied");
    expect(findProposal(updated, "p1")!.status).toBe("pending");
  });
});
