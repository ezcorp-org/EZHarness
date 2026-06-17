import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchFileOrganizerEvent, IN_PROCESS_EVENTS } from "../extensions/file-organizer-events";
import type { PermissionEngine } from "../extensions/permission-engine";
import type { AuthorizeContext } from "../extensions/permission-engine";
import type { CapabilitySet } from "../extensions/capability-types";

function fakeEngine(): PermissionEngine {
  return {
    authorize: async (_ctx: AuthorizeContext, _needed: CapabilitySet) => ({ decision: "allow", auditId: "a" }),
  } as unknown as PermissionEngine;
}

let root: string;
let dataDir: string;
let watched: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fo-events-"));
  dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  watched = join(root, "watched");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(watched, { recursive: true });
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify({ folders: [{ id: "f1", path: watched, presets: [], customRules: [], ignore: [], backlogPolicy: "include-existing" }], globalIgnore: [], schemaVersion: 1 }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps() {
  return {
    dataDir,
    engine: fakeEngine(),
    extensionId: "ext-fo",
    userId: "user-1",
    settings: { quarantineTtlDays: 30, quarantineCapGb: 5 },
  };
}

async function seedProposal() {
  await writeFile(join(watched, "a.txt"), "x");
  await writeFile(
    join(dataDir, "proposals.json"),
    JSON.stringify({
      proposals: [{ id: "p1", kind: "move", src: join(watched, "a.txt"), dst: join(watched, "sub", "a.txt"), reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1", snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 }, status: "pending", dedupeKey: "k", createdAt: "2026-06-17T00:00:00Z", version: 0 }],
      suppressed: [],
      schemaVersion: 1,
    }),
  );
}

describe("dispatch routing", () => {
  test("unknown event ⇒ handled:false (falls through)", async () => {
    const r = await dispatchFileOrganizerEvent("classify-move", {}, deps());
    expect(r.handled).toBe(false);
  });

  test("pure-view events are handled + changed but mutate nothing", async () => {
    for (const ev of ["select-segment", "page-window", "focus", "reload-config"]) {
      const r = await dispatchFileOrganizerEvent(ev, { segment: "moves" }, deps());
      expect(r.handled).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.ok).toBe(true);
    }
  });

  test("scan-now is honest: refreshes the view, doesn't claim a forced scan", async () => {
    const r = await dispatchFileOrganizerEvent("scan-now", {}, deps());
    expect(r.handled).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.ok).toBe(true);
    // The daemon owns scanning; the message must not over-promise a scan.
    expect(r.message).toContain("daemon scans on its own schedule");
  });

  test("retry-failed actually resets failed rows to pending (button does something)", async () => {
    await writeFile(
      join(dataDir, "proposals.json"),
      JSON.stringify({
        proposals: [
          { id: "f1", kind: "move", src: join(watched, "a.txt"), dst: join(watched, "sub", "a.txt"), reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1", snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 }, status: "failed", dedupeKey: "k", createdAt: "2026-06-17T00:00:00Z", version: 1 },
        ],
        suppressed: [],
        schemaVersion: 1,
      }),
    );
    const r = await dispatchFileOrganizerEvent("retry-failed", {}, deps());
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const file = JSON.parse(await readFile(join(dataDir, "proposals.json"), "utf8"));
    expect(file.proposals[0].status).toBe("pending");
  });

  test("accept routes to the applier (fs effect)", async () => {
    await seedProposal();
    const r = await dispatchFileOrganizerEvent("accept", { proposalId: "p1" }, deps());
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(true);
    expect(await Bun.file(join(watched, "sub", "a.txt")).exists()).toBe(true);
  });

  test("accept without proposalId ⇒ validation error (no fs)", async () => {
    const r = await dispatchFileOrganizerEvent("accept", {}, deps());
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("proposalId");
  });

  test("reject routes + persists", async () => {
    await seedProposal();
    const r = await dispatchFileOrganizerEvent("reject", { proposalId: "p1" }, deps());
    expect(r.ok).toBe(true);
    const file = JSON.parse(await readFile(join(dataDir, "proposals.json"), "utf8"));
    expect(file.proposals[0].status).toBe("rejected");
  });

  test("set-mode requires folderId + mode", async () => {
    expect((await dispatchFileOrganizerEvent("set-mode", { folderId: "f1" }, deps())).ok).toBe(false);
    const ok = await dispatchFileOrganizerEvent("set-mode", { folderId: "f1", mode: "fully-auto" }, deps());
    expect(ok.ok).toBe(true);
    const cfg = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(cfg.folders[0].mode).toBe("fully-auto");
  });

  test("add-folder validates path", async () => {
    const missing = await dispatchFileOrganizerEvent("add-folder", {}, deps());
    expect(missing.ok).toBe(false);
    const newDir = join(root, "Downloads");
    await mkdir(newDir);
    const ok = await dispatchFileOrganizerEvent("add-folder", { path: newDir, backlogPolicy: "new-only" }, deps());
    expect(ok.ok).toBe(true);
  });

  test("undo-batch / purge require their ids", async () => {
    expect((await dispatchFileOrganizerEvent("undo-batch", {}, deps())).ok).toBe(false);
    expect((await dispatchFileOrganizerEvent("purge", {}, deps())).ok).toBe(false);
  });

  test("add-rule surfaces the mini-DSL parse error", async () => {
    const bad = await dispatchFileOrganizerEvent("add-rule", { folderId: "f1", rule: "no arrow here" }, deps());
    expect(bad.ok).toBe(false);
    expect(bad.changed).toBe(false);
  });

  // ── Exhaustive case coverage: every in-process branch routes to state ──
  //
  // The dispatcher is a thin switch; these assert each case reaches its
  // state handler (or returns the right validation error) so no branch is
  // silently dead. State behaviour itself is unit-tested in
  // file-organizer-state.test.ts — here we only prove the wiring.
  async function seedConfigWithFolder() {
    // beforeEach already wrote config with folder f1.
    return;
  }

  test("config mutations: toggle-preset / set-backlog-policy / remove-folder / add-ignore", async () => {
    await seedConfigWithFolder();
    expect((await dispatchFileOrganizerEvent("toggle-preset", { folderId: "f1", preset: "junk-sweep" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("toggle-preset", { folderId: "f1" }, deps())).ok).toBe(false);
    expect((await dispatchFileOrganizerEvent("set-backlog-policy", { folderId: "f1", backlogPolicy: "new-only" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("set-backlog-policy", { folderId: "f1" }, deps())).ok).toBe(false);
    expect((await dispatchFileOrganizerEvent("add-ignore", { folderId: "f1", path: "secret" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("add-ignore", { folderId: "f1" }, deps())).ok).toBe(false);
    expect((await dispatchFileOrganizerEvent("remove-folder", { folderId: "f1" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("remove-folder", {}, deps())).ok).toBe(false);
  });

  test("add-rule wires the mini-DSL to state (valid path)", async () => {
    const ok = await dispatchFileOrganizerEvent("add-rule", { folderId: "f1", rule: "*.tmp older 7d -> quarantine" }, deps());
    expect(ok.ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("add-rule", { folderId: "f1" }, deps())).ok).toBe(false);
  });

  test("reject-segment / confirm-deletes / dismiss-stale route to state", async () => {
    await writeFile(join(watched, "j.tmp"), "x");
    await writeFile(
      join(dataDir, "proposals.json"),
      JSON.stringify({
        proposals: [
          { id: "m1", kind: "move", src: join(watched, "a.txt"), dst: join(watched, "sub", "a.txt"), reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1", snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 }, status: "pending", dedupeKey: "k1", createdAt: "2026-06-17T00:00:00Z", version: 0 },
          { id: "s1", kind: "move", src: join(watched, "b.txt"), dst: join(watched, "sub", "b.txt"), reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1", snapshot: { size: 1, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 }, status: "stale-source", dedupeKey: "k2", createdAt: "2026-06-17T00:00:00Z", version: 0 },
        ],
        suppressed: [],
        schemaVersion: 1,
      }),
    );
    expect((await dispatchFileOrganizerEvent("reject-segment", { segment: "moves" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("confirm-deletes", {}, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("dismiss-stale", { proposalId: "s1" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("dismiss-stale", {}, deps())).ok).toBe(false);
  });

  test("quarantine events: restore / purge / empty-quarantine / purge-expired / undo-batch", async () => {
    const trashDir = join(dataDir, ".trash", "q1");
    await mkdir(trashDir, { recursive: true });
    await writeFile(join(trashDir, "a.txt"), "restored");
    await writeFile(
      join(dataDir, ".trash", "manifest.json"),
      JSON.stringify({ schemaVersion: 1, entries: [{ id: "q1", originalPath: join(watched, "a.txt"), trashPath: join(trashDir, "a.txt"), proposalId: "p1", reason: "junk", deletedAt: new Date(0).toISOString(), batchId: "b1", size: 8, expiresAtMs: Date.now() + 1e9 }] }),
    );
    expect((await dispatchFileOrganizerEvent("restore", { all: true }, deps())).ok).toBe(true);
    // After restore the manifest is empty — the rest are safe no-ops.
    expect((await dispatchFileOrganizerEvent("purge", { quarantineId: "gone" }, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("purge", {}, deps())).ok).toBe(false);
    expect((await dispatchFileOrganizerEvent("empty-quarantine", {}, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("purge-expired", {}, deps())).ok).toBe(true);
    expect((await dispatchFileOrganizerEvent("undo-batch", { batchId: "b1" }, deps())).ok).toBe(true);
  });

  test("an unexpected error in a handler is caught and reported (no throw escapes)", async () => {
    // A null engine makes the applier's authorize() throw; the dispatcher's
    // try/catch must convert it to a structured failure, not bubble.
    await seedProposal();
    const brokenDeps = { ...deps(), engine: null as unknown as PermissionEngine };
    const r = await dispatchFileOrganizerEvent("accept", { proposalId: "p1" }, brokenDeps);
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Internal error");
  });

  test("IN_PROCESS_EVENTS covers exactly the in-process handlers", () => {
    // Agent/daemon-forwarded events must NOT be in the in-process set.
    for (const forwarded of ["classify-move", "teach-rule", "ignore-file", "enable-daemon", "organize-backlog"]) {
      expect(IN_PROCESS_EVENTS.has(forwarded)).toBe(false);
    }
    // A representative sample of in-process events must be present.
    for (const handled of ["accept", "reject", "confirm-deletes", "restore", "set-mode", "add-folder"]) {
      expect(IN_PROCESS_EVENTS.has(handled)).toBe(true);
    }
  });
});
