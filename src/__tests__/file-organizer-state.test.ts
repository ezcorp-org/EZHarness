import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as state from "../extensions/file-organizer-state";
import type { PermissionEngine } from "../extensions/permission-engine";
import type { Proposal } from "../../docs/extensions/examples/file-organizer/lib/proposals";
import type { AuthorizeContext } from "../extensions/permission-engine";
import type { CapabilitySet } from "../extensions/capability-types";

function fakeEngine(decision: "allow" | "deny" = "allow"): PermissionEngine {
  return {
    authorize: async (_ctx: AuthorizeContext, _needed: CapabilitySet) =>
      decision === "allow"
        ? { decision: "allow", auditId: "a1" }
        : { decision: "deny", reason: "deny", auditId: "ad" },
  } as unknown as PermissionEngine;
}

let root: string;
let dataDir: string;
let watched: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fo-state-"));
  dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  watched = join(root, "watched");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(watched, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(engine?: PermissionEngine): state.StateDeps {
  return {
    dataDir,
    engine: engine ?? fakeEngine("allow"),
    extensionId: "ext-fo",
    userId: "user-1",
    settings: { quarantineTtlDays: 30, quarantineCapGb: 5 },
  };
}

async function seedConfig(): Promise<void> {
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify({
      folders: [{ id: "f1", path: watched, presets: [], customRules: [], ignore: [], backlogPolicy: "include-existing" }],
      globalIgnore: [".ezcorp/data", ".git", "node_modules"],
      schemaVersion: 1,
    }),
  );
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1", kind: "move", src: join(watched, "a.txt"), dst: join(watched, "sub", "a.txt"),
    reason: "route", ruleId: "r1", ruleLabel: "Route", folderId: "f1",
    snapshot: { size: 5, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 },
    status: "pending", dedupeKey: "k", createdAt: "2026-06-17T00:00:00.000Z", version: 0,
    ...over,
  };
}

async function seedProposals(ps: Proposal[]): Promise<void> {
  await writeFile(join(dataDir, "proposals.json"), JSON.stringify({ proposals: ps, suppressed: [], schemaVersion: 1 }));
}

async function readProposals() {
  return JSON.parse(await readFile(join(dataDir, "proposals.json"), "utf8"));
}
async function readManifest() {
  return JSON.parse(await readFile(join(dataDir, ".trash", "manifest.json"), "utf8"));
}
async function readConfig() {
  return JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
}

describe("acceptProposal", () => {
  test("applies a move: fs effect + status applied + audit", async () => {
    await seedConfig();
    await writeFile(join(watched, "a.txt"), "hello");
    await seedProposals([proposal()]);
    const r = await state.acceptProposal(deps(), "p1");
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(await Bun.file(join(watched, "sub", "a.txt")).exists()).toBe(true);
    expect((await readProposals()).proposals[0].status).toBe("applied");
  });

  test("CAS: double-accept is a no-op (already applied)", async () => {
    await seedConfig();
    await seedProposals([proposal({ status: "applied" })]);
    const r = await state.acceptProposal(deps(), "p1");
    expect(r.changed).toBe(false);
    expect(r.message).toBe("Already resolved");
  });

  test("unknown id ⇒ not found (no mutation)", async () => {
    await seedConfig();
    await seedProposals([proposal()]);
    const r = await state.acceptProposal(deps(), "nope");
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
  });

  test("engine deny ⇒ blocked, file intact", async () => {
    await seedConfig();
    await writeFile(join(watched, "a.txt"), "x");
    await seedProposals([proposal()]);
    const r = await state.acceptProposal(deps(fakeEngine("deny")), "p1");
    expect(r.ok).toBe(false);
    expect((await readProposals()).proposals[0].status).toBe("blocked");
    expect(await Bun.file(join(watched, "a.txt")).exists()).toBe(true);
  });

  test("delete-quarantine: applies + records manifest entry", async () => {
    await seedConfig();
    await writeFile(join(watched, "junk.tmp"), "junk");
    await seedProposals([proposal({ id: "d1", kind: "delete-quarantine", src: join(watched, "junk.tmp"), dst: null, quarantineId: "q1", reason: "junk" })]);
    const r = await state.acceptProposal(deps(), "d1");
    expect(r.ok).toBe(true);
    const manifest = await readManifest();
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].id).toBe("q1");
    expect(await Bun.file(join(watched, "junk.tmp")).exists()).toBe(false);
  });
});

describe("rejectProposal", () => {
  test("rejects + adds to suppressed-set", async () => {
    await seedConfig();
    await seedProposals([proposal({ snapshot: { size: 5, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1, sha256: "h" } })]);
    const r = await state.rejectProposal(deps(), "p1");
    expect(r.ok).toBe(true);
    const file = await readProposals();
    expect(file.proposals[0].status).toBe("rejected");
    expect(file.suppressed).toHaveLength(1);
  });
  test("CAS no-op on already-resolved", async () => {
    await seedConfig();
    await seedProposals([proposal({ status: "applied" })]);
    const r = await state.rejectProposal(deps(), "p1");
    expect(r.changed).toBe(false);
  });
});

describe("confirmDeletes (batch)", () => {
  test("applies all pending deletes with a shared batchId", async () => {
    await seedConfig();
    await writeFile(join(watched, "j1.tmp"), "a");
    await writeFile(join(watched, "j2.tmp"), "b");
    await seedProposals([
      proposal({ id: "d1", kind: "delete-quarantine", src: join(watched, "j1.tmp"), dst: null, quarantineId: "q1" }),
      proposal({ id: "d2", kind: "delete-quarantine", src: join(watched, "j2.tmp"), dst: null, quarantineId: "q2" }),
      proposal({ id: "m1", kind: "move" }), // not a delete — untouched
    ]);
    const r = await state.confirmDeletes(deps());
    expect(r.ok).toBe(true);
    const file = await readProposals();
    const d1 = file.proposals.find((p: Proposal) => p.id === "d1");
    const d2 = file.proposals.find((p: Proposal) => p.id === "d2");
    expect(d1.status).toBe("applied");
    expect(d2.status).toBe("applied");
    expect(d1.batchId).toBe(d2.batchId);
    expect(file.proposals.find((p: Proposal) => p.id === "m1").status).toBe("pending");
  });
});

describe("rejectSegment", () => {
  test("rejects every pending proposal of a kind", async () => {
    await seedConfig();
    await seedProposals([
      proposal({ id: "m1", kind: "move" }),
      proposal({ id: "m2", kind: "move" }),
      proposal({ id: "d1", kind: "delete-quarantine", dst: null }),
    ]);
    const r = await state.rejectSegment(deps(), "moves");
    expect(r.message).toBe("Rejected 2");
    const file = await readProposals();
    expect(file.proposals.filter((p: Proposal) => p.status === "rejected")).toHaveLength(2);
    expect(file.proposals.find((p: Proposal) => p.id === "d1").status).toBe("pending");
  });
});

describe("quarantine restore / undo / purge", () => {
  async function seedQuarantine(batchId: string | null = null) {
    const trashDir = join(dataDir, ".trash", "q1");
    await mkdir(trashDir, { recursive: true });
    await writeFile(join(trashDir, "a.txt"), "restored");
    await writeFile(
      join(dataDir, ".trash", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ id: "q1", originalPath: join(watched, "a.txt"), trashPath: join(trashDir, "a.txt"), proposalId: "p1", reason: "junk", deletedAt: new Date(0).toISOString(), batchId, size: 8, expiresAtMs: Date.now() + 1e9 }],
      }),
    );
  }

  test("restore one by id puts the file back", async () => {
    await seedConfig();
    await seedQuarantine();
    const r = await state.restore(deps(), { quarantineId: "q1" });
    expect(r.ok).toBe(true);
    expect(await Bun.file(join(watched, "a.txt")).exists()).toBe(true);
    expect((await readManifest()).entries).toHaveLength(0);
  });

  test("undoBatch restores every entry in a batch", async () => {
    await seedConfig();
    await seedQuarantine("batch-7");
    const r = await state.undoBatch(deps(), "batch-7");
    expect(r.message).toBe("Restored 1");
    expect(await Bun.file(join(watched, "a.txt")).exists()).toBe(true);
  });

  test("undoBatch with unknown batch is a no-op", async () => {
    await seedConfig();
    await seedQuarantine("batch-7");
    const r = await state.undoBatch(deps(), "other");
    expect(r.changed).toBe(false);
  });

  test("purge hard-deletes one entry", async () => {
    await seedConfig();
    await seedQuarantine();
    const r = await state.purge(deps(), "q1");
    expect(r.ok).toBe(true);
    expect(await Bun.file(join(dataDir, ".trash", "q1", "a.txt")).exists()).toBe(false);
    expect((await readManifest()).entries).toHaveLength(0);
  });

  test("emptyQuarantine clears all", async () => {
    await seedConfig();
    await seedQuarantine();
    const r = await state.emptyQuarantine(deps());
    expect(r.ok).toBe(true);
    expect((await readManifest()).entries).toHaveLength(0);
  });

  test("purgeExpired removes expired entries only", async () => {
    await seedConfig();
    const trashDir = join(dataDir, ".trash", "q1");
    await mkdir(trashDir, { recursive: true });
    await writeFile(join(trashDir, "a"), "x");
    await writeFile(
      join(dataDir, ".trash", "manifest.json"),
      JSON.stringify({ schemaVersion: 1, entries: [{ id: "q1", originalPath: join(watched, "a"), trashPath: join(trashDir, "a"), proposalId: null, reason: "r", deletedAt: new Date(0).toISOString(), batchId: null, size: 1, expiresAtMs: 1 }] }),
    );
    const r = await state.purgeExpired(deps());
    expect(r.message).toBe("Purged 1");
  });
});

describe("config mutations", () => {
  test("addWatchedFolder validates + writes", async () => {
    await seedConfig();
    const newFolder = join(root, "Downloads");
    await mkdir(newFolder);
    const r = await state.addWatchedFolder(deps(), { path: newFolder, backlogPolicy: "new-only" });
    expect(r.ok).toBe(true);
    expect((await readConfig()).folders.map((f: { path: string }) => f.path)).toContain(newFolder);
  });

  test("addWatchedFolder refuses .ezcorp/data", async () => {
    await seedConfig();
    const r = await state.addWatchedFolder(deps(), { path: join(root, ".ezcorp", "data") });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(".ezcorp/data");
  });

  test("addWatchedFolder refuses an unreachable (unmounted) path", async () => {
    await seedConfig();
    // A path that doesn't exist on disk ⇒ not visible to the container.
    const r = await state.addWatchedFolder(deps(), { path: join(root, "definitely-not-mounted") });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("isn't visible to the EZCorp container");
  });

  test("setMode / togglePreset / addIgnore / removeFolder", async () => {
    await seedConfig();
    await state.setMode(deps(), "f1", "fully-auto");
    expect((await readConfig()).folders[0].mode).toBe("fully-auto");
    await state.togglePreset(deps(), "f1", "junk-sweep");
    expect((await readConfig()).folders[0].presets).toContain("junk-sweep");
    await state.addIgnore(deps(), "f1", "secret");
    expect((await readConfig()).folders[0].ignore).toContain("secret");
    await state.removeWatchedFolder(deps(), "f1");
    expect((await readConfig()).folders).toHaveLength(0);
  });

  test("addRule parses the mini-DSL (valid + invalid)", async () => {
    await seedConfig();
    const ok = await state.addRule(deps(), "f1", "*.tmp older 7d -> quarantine");
    expect(ok.ok).toBe(true);
    expect((await readConfig()).folders[0].customRules).toHaveLength(1);
    const bad = await state.addRule(deps(), "f1", "garbage no arrow");
    expect(bad.ok).toBe(false);
  });
});

describe("dismissStale", () => {
  test("dismisses a stale-source proposal", async () => {
    await seedConfig();
    await seedProposals([proposal({ status: "stale-source" })]);
    const r = await state.dismissStale(deps(), "p1");
    expect(r.ok).toBe(true);
    expect((await readProposals()).proposals[0].status).toBe("rejected");
  });
  test("no-op on a non-stale proposal", async () => {
    await seedConfig();
    await seedProposals([proposal()]);
    const r = await state.dismissStale(deps(), "p1");
    expect(r.changed).toBe(false);
  });
});

describe("internals", () => {
  test("rootForRestore finds the owning folder, else the parent", () => {
    const cfg = { folders: [{ id: "f", path: "/w", mode: undefined, presets: [], customRules: [], ignore: [], backlogPolicy: "new-only" as const }], globalIgnore: [], schemaVersion: 1 };
    expect(state._stateInternals.rootForRestore(cfg, "/w/sub/a.txt")).toBe("/w");
    expect(state._stateInternals.rootForRestore(cfg, "/other/a.txt")).toBe("/other");
  });
  test("segmentKind maps segment → proposal kind", () => {
    expect(state._stateInternals.segmentKind("moves")).toBe("move");
    expect(state._stateInternals.segmentKind("deletes")).toBe("delete-quarantine");
    expect(state._stateInternals.segmentKind("all")).toBeNull();
  });
});
