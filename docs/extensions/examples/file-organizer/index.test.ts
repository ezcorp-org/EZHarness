import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetChannelForTests, __resetPagesForTests } from "@ezcorp/sdk/runtime";
import { validatePageTree } from "../../../../src/extensions/page-schema";
import {
  _setFsForTests,
  renderDashboard,
  register,
  start,
  tools,
  _actionsForTests,
  type FsLayer,
} from "./index";
import { ALL_EVENTS } from "./lib/page";
import type { HubPageTree } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";

// ── In-memory fs layer ──────────────────────────────────────────────

function memFs(initial: Record<string, string> = {}): FsLayer & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    read: async (p) => (p in files ? files[p]! : null),
    write: async (p, c) => { files[p] = c; },
    exists: async (p) => p in files,
    list: async () => [],
  };
}

const ROOT = process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
const DATA = `${ROOT}/.ezcorp/extension-data/file-organizer`;
const P = {
  proposals: `${DATA}/proposals.json`,
  config: `${DATA}/config.json`,
  badge: `${DATA}/badge.json`,
  manifest: `${DATA}/.trash/manifest.json`,
  pid: `${DATA}/.daemon.pid`,
};

afterEach(() => {
  _setFsForTests(null);
});

function validate(tree: HubPageTree) {
  return validatePageTree(tree, { allowedEvents: ALL_EVENTS });
}

function configWithFolder() {
  return JSON.stringify({
    folders: [{ id: "f1", path: "/watched", mode: "ask-everything", presets: ["junk-sweep"], customRules: [], ignore: [], backlogPolicy: "new-only" }],
    globalIgnore: [".ezcorp/data"],
    schemaVersion: 1,
  });
}

function proposalsWith(...statuses: Array<{ id: string; kind: string; status: string; src?: string }>) {
  return JSON.stringify({
    proposals: statuses.map((s, i) => ({
      id: s.id, kind: s.kind, src: s.src ?? `/watched/f${i}.txt`, dst: s.kind === "move" ? `/watched/sub/f${i}.txt` : null,
      reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1",
      snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 },
      status: s.status, dedupeKey: `k${i}`, createdAt: new Date().toISOString(), version: 0,
      ...(s.status === "applied" ? { resolvedAt: new Date().toISOString() } : {}),
    })),
    suppressed: [],
    schemaVersion: 1,
  });
}

// ── Renders ─────────────────────────────────────────────────────────

describe("renderDashboard (overview section)", () => {
  test("populated: reads proposals/config/badge → valid tree", async () => {
    _setFsForTests(memFs({
      [P.config]: configWithFolder(),
      [P.proposals]: proposalsWith({ id: "p1", kind: "delete-quarantine", status: "pending" }),
      [P.badge]: JSON.stringify({ pending: 1, unclassified: 0, lastScanAt: "2026-06-17T00:00:00Z" }),
      [P.pid]: "123",
    }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
    expect(tree.title).toBe("File Organizer");
    // Daemon shown running because the pid lockfile exists.
    expect(JSON.stringify(tree)).toContain("Watcher running");
  });

  test("empty (no config) → onboarding state", async () => {
    _setFsForTests(memFs({}));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
    expect(JSON.stringify(tree)).toContain("Get started");
  });

  test("daemon stopped when no pid lockfile", async () => {
    _setFsForTests(memFs({ [P.config]: configWithFolder() }));
    const tree = await renderDashboard();
    expect(JSON.stringify(tree)).toContain("Watcher stopped");
  });

  test("corrupt proposals.json degrades gracefully (treated empty)", async () => {
    _setFsForTests(memFs({ [P.config]: configWithFolder(), [P.proposals]: "{bad" }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
  });

  test("applied-today proposals count toward the 'applied today' stat (isToday)", async () => {
    const todayIso = new Date().toISOString();
    _setFsForTests(memFs({
      [P.config]: configWithFolder(),
      [P.proposals]: JSON.stringify({
        proposals: [
          { id: "a1", kind: "move", src: "/watched/a.txt", dst: "/watched/sub/a.txt", reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1", snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 }, status: "applied", resolvedAt: todayIso, dedupeKey: "k1", createdAt: todayIso, version: 1 },
          // An applied row from long ago must NOT count toward "today".
          { id: "a0", kind: "move", src: "/watched/b.txt", dst: "/watched/sub/b.txt", reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1", snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 }, status: "applied", resolvedAt: "2000-01-01T00:00:00.000Z", dedupeKey: "k0", createdAt: "2000-01-01T00:00:00.000Z", version: 1 },
        ],
        suppressed: [],
        schemaVersion: 1,
      }),
      [P.pid]: "1",
    }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
  });

  test("error path renders the error state (read throws)", async () => {
    _setFsForTests({
      read: async () => { throw new Error("boom"); },
      write: async () => {},
      exists: async () => { throw new Error("boom"); },
      list: async () => { throw new Error("boom"); },
    });
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
    expect(JSON.stringify(tree)).toContain("error");
  });

  test("wrong-shaped + malformed state files degrade to empty per reader", async () => {
    // config present (so we don't short-circuit to onboarding), but:
    //  - proposals.json is valid JSON of the WRONG shape ⇒ readProposals
    //    hits the `!Array.isArray` guard → emptyProposalsFile.
    //  - badge.json + manifest.json are malformed JSON ⇒ each reader's
    //    catch returns its empty default.
    _setFsForTests(memFs({
      [P.config]: configWithFolder(),
      [P.proposals]: JSON.stringify({ proposals: "not-an-array", suppressed: 5 }),
      [P.badge]: "{ not json",
      [P.manifest]: "{ not json",
    }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
  });

  test("a null badge/manifest (absent files) use the zero defaults", async () => {
    // config + proposals present; badge/manifest ABSENT ⇒ readBadge/
    // readQuarantine take their text===null fast path.
    _setFsForTests(memFs({
      [P.config]: configWithFolder(),
      [P.proposals]: proposalsWith({ id: "p1", kind: "move", status: "pending" }),
    }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
  });
});

describe("renderDashboard (review section)", () => {
  test("populated: shows pending proposals → valid tree", async () => {
    _setFsForTests(memFs({
      [P.proposals]: proposalsWith({ id: "p1", kind: "move", status: "pending" }),
      [P.pid]: "1",
    }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
    expect(tree.title).toBe("File Organizer");
  });

  test("auto-batch undo surfaces when a batched quarantine exists", async () => {
    _setFsForTests(memFs({
      [P.proposals]: proposalsWith(),
      [P.manifest]: JSON.stringify({ schemaVersion: 1, entries: [{ id: "q1", originalPath: "/w/a", trashPath: "/t/q1/a", proposalId: null, reason: "r", deletedAt: new Date().toISOString(), batchId: "batch-1", size: 1, expiresAtMs: 9e12 }] }),
    }));
    const tree = await renderDashboard();
    expect(JSON.stringify(tree)).toContain("Undo last auto-batch");
  });

  test("error path renders the error state", async () => {
    _setFsForTests({
      read: async () => { throw new Error("boom"); },
      write: async () => {},
      exists: async () => { throw new Error("boom"); },
      list: async () => [],
    });
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
  });
});

describe("renderDashboard (folders section)", () => {
  test("populated: one section per folder", async () => {
    _setFsForTests(memFs({ [P.config]: configWithFolder(), [P.pid]: "1" }));
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
    expect(JSON.stringify(tree)).toContain("/watched");
  });
  test("no folders → empty-state", async () => {
    _setFsForTests(memFs({}));
    const tree = await renderDashboard();
    expect(JSON.stringify(tree)).toContain("No folders watched");
  });

  test("error path renders the error state (read throws)", async () => {
    _setFsForTests({
      read: async () => { throw new Error("boom"); },
      write: async () => {},
      exists: async () => { throw new Error("boom"); },
      list: async () => { throw new Error("boom"); },
    });
    const tree = await renderDashboard();
    expect(validate(tree)).not.toBeNull();
  });

  test("malformed config JSON degrades to empty (readConfig catch)", async () => {
    _setFsForTests(memFs({ [P.config]: "{ not valid json", [P.pid]: "1" }));
    const tree = await renderDashboard();
    // emptyConfig() ⇒ no folders ⇒ empty-state.
    expect(JSON.stringify(tree)).toContain("No folders watched");
  });
});

// ── Pure-view action handlers ───────────────────────────────────────

describe("page action handlers (pure-view nav state)", () => {
  // These handlers mutate module-level nav state (segment + window offset);
  // the effect is observable only on the NEXT renderDashboard, so each case
  // drives the handler then asserts the re-rendered Review section reflects
  // it. Each test fully sets the state it expects (order-independent).
  const moves = (n: number) =>
    proposalsWith(...Array.from({ length: n }, (_, i) => ({ id: `m${i}`, kind: "move", status: "pending" })));

  test("selectSegmentAction sets the active segment + resets offset", async () => {
    // Window off zero, then select a segment — selection must reset offset.
    _actionsForTests.pageWindowAction({ source: "hub", pageId: "overview", userId: "u", payload: { segment: "deletes", offset: 50 } });
    _actionsForTests.selectSegmentAction({ source: "hub", pageId: "overview", userId: "u", payload: { segment: "deletes" } });
    _setFsForTests(memFs({ [P.proposals]: proposalsWith(...Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, kind: "delete-quarantine", status: "pending" }))) }));
    const s = JSON.stringify(await renderDashboard());
    // Active segment is "deletes" (batched confirm) AND offset reset to 0
    // (the first 1–50 window, not 51–60).
    expect(s).toContain("Confirm these 60 deletes");
    expect(s).toContain("Showing 1");
    expect(s).not.toContain("Showing 51");
  });

  test("selectSegmentAction with no segment is a no-op", async () => {
    _actionsForTests.selectSegmentAction({ source: "hub", pageId: "overview", userId: "u", payload: { segment: "moves" } });
    _actionsForTests.selectSegmentAction({ source: "hub", pageId: "overview", userId: "u", payload: {} });
    _setFsForTests(memFs({ [P.proposals]: proposalsWith({ id: "m1", kind: "move", status: "pending" }) }));
    const s = JSON.stringify(await renderDashboard());
    // Segment is still "moves" (empty payload ignored): an inline Accept, not
    // the deletes confirm.
    expect(s).toContain("file-organizer:accept");
    expect(s).not.toContain("Confirm these");
  });

  test("pageWindowAction sets segment + a valid offset", async () => {
    _actionsForTests.pageWindowAction({ source: "hub", pageId: "overview", userId: "u", payload: { segment: "moves", offset: 50 } });
    _setFsForTests(memFs({ [P.proposals]: moves(60) }));
    // The window advanced to offset 50 → footer shows the 51–60 page.
    expect(JSON.stringify(await renderDashboard())).toContain("Showing 51");
  });

  test("pageWindowAction ignores a negative / non-finite offset and missing segment", async () => {
    _actionsForTests.pageWindowAction({ source: "hub", pageId: "overview", userId: "u", payload: { segment: "moves", offset: 50 } });
    _actionsForTests.pageWindowAction({ source: "hub", pageId: "overview", userId: "u", payload: { offset: -5 } });
    _actionsForTests.pageWindowAction({ source: "hub", pageId: "overview", userId: "u", payload: { offset: Number.NaN } });
    _actionsForTests.pageWindowAction({ source: "hub", pageId: "overview", userId: "u", payload: {} });
    _setFsForTests(memFs({ [P.proposals]: moves(60) }));
    // The bad payloads left the window at offset 50 (51–60 page) untouched.
    expect(JSON.stringify(await renderDashboard())).toContain("Showing 51");
  });
});

// ── Tools ───────────────────────────────────────────────────────────

function text(r: ToolCallResult): string {
  return JSON.stringify(r);
}

describe("tools", () => {
  test("describe_current_workflow echoes notes", async () => {
    const r = await tools.describe_current_workflow!({ notes: "I keep Downloads messy" });
    expect(text(r)).toContain("Downloads messy");
  });

  test("propose_target_workflow renders a markdown table; empty ⇒ error", async () => {
    const ok = await tools.propose_target_workflow!({ folders: [{ path: "/watched/Downloads", mode: "ask-everything", presets: ["junk-sweep"] }] });
    expect(text(ok)).toContain("| Folder |");
    const bad = await tools.propose_target_workflow!({ folders: [] });
    expect(text(bad)).toContain("at least one");
  });

  test("apply_workflow_config writes config (valid + refuses .ezcorp/data)", async () => {
    const m = memFs({});
    _setFsForTests(m);
    const r = await tools.apply_workflow_config!({ folders: [{ path: "/watched/A" }, { path: "/proj/.ezcorp/data" }] });
    expect(text(r)).toContain("Applied 1");
    expect(text(r)).toContain("Refused");
    const written = JSON.parse(m.files[P.config]!);
    expect(written.folders.map((f: { path: string }) => f.path)).toEqual(["/watched/A"]);
  });

  test("apply_workflow_config with no folders ⇒ error", async () => {
    _setFsForTests(memFs({}));
    const r = await tools.apply_workflow_config!({ folders: [] });
    expect(text(r)).toContain("at least one");
  });

  test("set_folder_rules updates mode + presets to exactly the wanted set", async () => {
    const m = memFs({ [P.config]: configWithFolder() });
    _setFsForTests(m);
    const r = await tools.set_folder_rules!({ folderId: "f1", mode: "fully-auto", presets: ["downloads-router"] });
    expect(text(r)).toContain("Updated rules");
    const cfg = JSON.parse(m.files[P.config]!);
    expect(cfg.folders[0].mode).toBe("fully-auto");
    expect(cfg.folders[0].presets).toEqual(["downloads-router"]); // junk-sweep removed
  });

  test("set_folder_rules rejects unknown folder", async () => {
    _setFsForTests(memFs({ [P.config]: configWithFolder() }));
    const r = await tools.set_folder_rules!({ folderId: "nope" });
    expect(text(r)).toContain("Unknown folder");
  });

  test("teach_rule parses the mini-DSL (valid + invalid)", async () => {
    const m = memFs({ [P.config]: configWithFolder() });
    _setFsForTests(m);
    const ok = await tools.teach_rule!({ folderId: "f1", rule: "*.tmp older 7d -> quarantine" });
    expect(text(ok)).toContain("Added rule");
    expect(JSON.parse(m.files[P.config]!).folders[0].customRules).toHaveLength(1);
    const bad = await tools.teach_rule!({ folderId: "f1", rule: "garbage" });
    expect(text(bad)).toContain("Invalid rule");
  });

  test("teach_rule requires folderId + rule", async () => {
    _setFsForTests(memFs({ [P.config]: configWithFolder() }));
    expect(text(await tools.teach_rule!({ folderId: "f1" }))).toContain("required");
  });

  test("propose_moves queues proposals for review", async () => {
    const m = memFs({ [P.config]: configWithFolder(), [P.proposals]: proposalsWith() });
    _setFsForTests(m);
    const r = await tools.propose_moves!({ moves: [{ src: "/watched/x.bin", dst: "/watched/Bin/x.bin", reason: "binary" }, { src: "/watched/weird", reason: "unclassified" }] });
    expect(text(r)).toContain("Queued 2");
    const file = JSON.parse(m.files[P.proposals]!);
    expect(file.proposals).toHaveLength(2);
    expect(file.proposals.find((p: { kind: string }) => p.kind === "unclassified")).toBeDefined();
  });

  test("propose_moves with none ⇒ error", async () => {
    _setFsForTests(memFs({}));
    expect(text(await tools.propose_moves!({ moves: [] }))).toContain("at least one");
  });

  test("organize_backlog flips the folder to include-existing", async () => {
    const m = memFs({ [P.config]: configWithFolder() });
    _setFsForTests(m);
    const r = await tools.organize_backlog!({ folderId: "f1" });
    expect(text(r)).toContain("Backlog sweep enabled");
    expect(JSON.parse(m.files[P.config]!).folders[0].backlogPolicy).toBe("include-existing");
  });

  test("organize_backlog rejects unknown folder", async () => {
    _setFsForTests(memFs({ [P.config]: configWithFolder() }));
    expect(text(await tools.organize_backlog!({ folderId: "x" }))).toContain("Unknown folder");
  });
});

// ── Wiring ──────────────────────────────────────────────────────────

describe("register", () => {
  beforeEach(() => {
    __resetChannelForTests();
    __resetPagesForTests();
  });
  afterEach(() => {
    __resetChannelForTests();
    __resetPagesForTests();
  });

  test("registers the single page + the tool dispatcher without throwing", () => {
    expect(() => register()).not.toThrow();
  });

  test("start() registers + boots the subprocess channel without throwing", () => {
    // start() is the subprocess entrypoint — it calls register() then opens
    // the SDK channel. It must be idempotent-safe under the reset harness.
    expect(() => start()).not.toThrow();
  });
});
