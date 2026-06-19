/**
 * Picker-output → folder-validation INTEGRATION test.
 *
 * The file-organizer Hub "Add watched folder" prompt renders the shared
 * `SharedFilePicker` (`format: "file-path"`). The picker's emitted value is
 * fed STRAIGHT into the file-organizer's `normalizeFolderPath` /
 * `addFolder` / `checkReachability`, and host-side into `addWatchedFolder`.
 *
 * The original bug: the picker defaulted to a `~`-relative root, so browse +
 * select (or a bare typed name) yielded a NON-absolute value (`~/Downloads`,
 * `Downloads`) which `normalizeFolderPath` rejects with
 * "Path must be an absolute, valid filesystem path." — the user saw that
 * error and the add silently failed.
 *
 * The fix is the picker's opt-in ABSOLUTE mode (root `/`). These tests run
 * the REAL picker path-join helpers (`joinSelectedPath` / `browseDir`)
 * against the REAL validation — no mocked routes, no hardcoded absolute
 * strings — so the integration that the e2e bypassed is actually exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  joinSelectedPath,
  browseDir,
} from "../../web/src/lib/components/ui/helpers";
import {
  addFolder,
  checkReachability,
  emptyConfig,
  normalizeFolderPath,
} from "../../docs/extensions/examples/file-organizer/lib/config";
import * as state from "../extensions/file-organizer-state";
import type { PermissionEngine } from "../extensions/permission-engine";

const ABSOLUTE = "/";
const ABS_ERROR = "Path must be an absolute, valid filesystem path.";

function addFolderWith(path: string) {
  return addFolder(emptyConfig(), { path, backlogPolicy: "new-only", now: 1, idGen: () => "f0" });
}

// ── The bug, reproduced end-to-end (picker → validation) ────────────

describe("picker absolute-mode output → folder validation (the bug the e2e missed)", () => {
  test("browse + select from empty yields an ABSOLUTE path that addFolder accepts", () => {
    // Browse with no value loads `/`; selecting "Downloads" (a dir) is the
    // realistic first interaction. Absolute mode (root="/") is what the Hub
    // prompt passes.
    expect(browseDir("", ABSOLUTE)).toBe("/");
    const picked = joinSelectedPath("", { name: "Downloads", isDir: true }, ABSOLUTE);
    // Picker keeps a trailing slash while browsing into a dir; the field
    // value at submit time is whatever the user left it on.
    expect(picked).toBe("/Downloads/");

    expect(normalizeFolderPath(picked)).toBe("/Downloads");
    const r = addFolderWith(picked);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.folders[0]!.path).toBe("/Downloads");
  });

  test("nested browse (select into /watched then Downloads) stays absolute", () => {
    const lvl1 = joinSelectedPath("", { name: "watched", isDir: true }, ABSOLUTE); // "/watched/"
    const lvl2 = joinSelectedPath(lvl1, { name: "Downloads", isDir: true }, ABSOLUTE);
    expect(lvl2).toBe("/watched/Downloads/");
    expect(normalizeFolderPath(lvl2)).toBe("/watched/Downloads");
    expect(checkReachability(lvl2, () => true).ok).toBe(true);
  });

  test("typed absolute path passes through UNMODIFIED", () => {
    const typed = "/watched/Downloads";
    expect(normalizeFolderPath(typed)).toBe(typed);
    expect(addFolderWith(typed).ok).toBe(true);
  });

  // ── Regression guard: the DEFAULT (~) mode value is exactly what the
  //    bug produced — prove it is still rejected with the exact message.
  test("DEFAULT (~) picker output is the failing value — rejected with the absolute-path error", () => {
    const buggy = joinSelectedPath("", { name: "Downloads", isDir: true }); // "~/Downloads/"
    expect(buggy).toBe("~/Downloads/");
    expect(normalizeFolderPath(buggy)).toBeNull();

    const r = addFolderWith(buggy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ABS_ERROR);

    const reach = checkReachability(buggy, () => true);
    expect(reach.ok).toBe(false);
    if (!reach.ok) expect(reach.error).toBe(ABS_ERROR);
  });

  test("a bare typed name (no slash) is also non-absolute → rejected", () => {
    const r = addFolderWith("Downloads");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ABS_ERROR);
  });
});

// ── Host-side addWatchedFolder accepts the absolute picker output ────

function fakeEngine(): PermissionEngine {
  return { authorize: async () => ({ decision: "allow", auditId: "a1" }) } as unknown as PermissionEngine;
}

describe("addWatchedFolder (host) with the picker's absolute output", () => {
  let root: string;
  let dataDir: string;
  let watched: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fo-picker-"));
    dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
    watched = join(root, "watched", "Downloads");
    await mkdir(join(dataDir, ".trash"), { recursive: true });
    await mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(): state.StateDeps {
    return {
      dataDir,
      engine: fakeEngine(),
      extensionId: "ext-fo",
      userId: "user-1",
      settings: { quarantineTtlDays: 30, quarantineCapGb: 5 },
    };
  }

  test("absolute picker value (existing dir) is added + persisted", async () => {
    // Mirror the picker producing this absolute path by selecting through
    // the real dirs: parent `/.../watched`, then `Downloads`.
    const parent = browseDir(watched + "/x", ABSOLUTE); // strips the partial → the real parent
    expect(parent).toBe(watched);
    const picked = joinSelectedPath(parent + "/", { name: "Downloads", isDir: false }, ABSOLUTE);
    expect(picked).toBe(watched + "/Downloads");

    // The real watched dir is `.../watched/Downloads`; select its name from
    // the grandparent for a clean absolute value pointing at it.
    const realPick = joinSelectedPath(join(root, "watched") + "/", { name: "Downloads", isDir: false }, ABSOLUTE);
    expect(realPick).toBe(watched);

    const r = await state.addWatchedFolder(deps(), { path: realPick });
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(cfg.folders.map((f: { path: string }) => f.path)).toContain(watched);
  });

  test("the buggy ~-relative value is refused host-side with the absolute-path error", async () => {
    const buggy = joinSelectedPath("", { name: "Downloads", isDir: true }); // default ~ mode
    const r = await state.addWatchedFolder(deps(), { path: buggy });
    expect(r.ok).toBe(false);
    expect(r.message).toBe(ABS_ERROR);
    // Nothing was written.
    expect(await Bun.file(join(dataDir, "config.json")).exists()).toBe(false);
  });
});
