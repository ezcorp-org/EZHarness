/**
 * DB layer tests for `src/db/queries/features.ts`.
 *
 * Covers:
 *   - CRUD round-trip for features (create/list/get/update/delete)
 *   - `replaceAgentFiles` preserves `source='user'` rows (LOAD-BEARING
 *     hybrid-ownership invariant from the design doc)
 *   - Cascade delete: feature → feature_files (FK ON DELETE CASCADE)
 *   - Cascade delete: project → features → feature_files
 *   - Unique (project_id, name) constraint
 *   - listFeatures ordering + file count aggregation
 *   - addUserFile idempotency (onConflictDoNothing)
 *   - removeFile happy + missing
 *
 * Pattern mirrors `db-queries-projects.test.ts` and
 * `db-queries-user-commands.test.ts`: real PGlite via `setupTestDb`,
 * `mockDbConnection()` swaps the `db/connection` module before queries
 * are imported.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createFeature,
  getFeature,
  listFeatures,
  updateFeature,
  deleteFeature,
  replaceAgentFiles,
  addUserFile,
  removeFile,
} = await import("../db/queries/features");
const { createProject, deleteProject } = await import("../db/queries/projects");

describe("features queries", () => {
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    await setupTestDb();
    const p = await createProject({ name: "alpha", path: "/tmp/alpha" });
    projectId = p.id;
    const o = await createProject({ name: "beta", path: "/tmp/beta" });
    otherProjectId = o.id;
  });
  afterAll(async () => await closeTestDb());

  // ── createFeature ──────────────────────────────────────────────────
  describe("createFeature", () => {
    test("inserts row with defaults (source='user', empty description)", async () => {
      const f = await createFeature({ projectId, name: "auth" });
      expect(f.id).toBeDefined();
      expect(f.projectId).toBe(projectId);
      expect(f.name).toBe("auth");
      expect(f.description).toBe("");
      expect(f.source).toBe("user");
      expect(f.createdAt).toBeInstanceOf(Date);
      expect(f.updatedAt).toBeInstanceOf(Date);
    });

    test("accepts description and source='agent' for scan-discovered rows", async () => {
      const f = await createFeature({
        projectId,
        name: "scan-discovered",
        description: "Files under src/scan-discovered",
        source: "agent",
      });
      expect(f.description).toBe("Files under src/scan-discovered");
      expect(f.source).toBe("agent");
    });

    test("throws when projectId missing", async () => {
      await expect(
        createFeature({ projectId: "", name: "x" }),
      ).rejects.toThrow(/projectId is required/);
    });

    test("throws when name missing", async () => {
      await expect(
        createFeature({ projectId, name: "" }),
      ).rejects.toThrow(/name is required/);
    });

    test("rejects duplicate (project_id, name) — unique constraint", async () => {
      await createFeature({ projectId, name: "dupe" });
      await expect(
        createFeature({ projectId, name: "dupe" }),
      ).rejects.toThrow();
    });

    test("same name in different projects is allowed (uniqueness is per-project)", async () => {
      const a = await createFeature({ projectId, name: "shared" });
      const b = await createFeature({ projectId: otherProjectId, name: "shared" });
      expect(a.id).not.toBe(b.id);
      expect(a.name).toBe(b.name);
    });
  });

  // ── getFeature ─────────────────────────────────────────────────────
  describe("getFeature", () => {
    test("returns feature with files sorted by relpath", async () => {
      const f = await createFeature({ projectId, name: "g1" });
      await replaceAgentFiles(f.id, ["src/g1/c.ts", "src/g1/a.ts", "src/g1/b.ts"]);
      const got = await getFeature(projectId, "g1");
      expect(got).toBeDefined();
      expect(got!.id).toBe(f.id);
      expect(got!.files.map((x) => x.relpath)).toEqual([
        "src/g1/a.ts",
        "src/g1/b.ts",
        "src/g1/c.ts",
      ]);
    });

    test("returns undefined for unknown name", async () => {
      expect(await getFeature(projectId, "missing")).toBeUndefined();
    });

    test("returns undefined when feature exists in another project (cross-project isolation)", async () => {
      await createFeature({ projectId, name: "iso" });
      expect(await getFeature(otherProjectId, "iso")).toBeUndefined();
    });

    test("returns undefined for empty projectId or name", async () => {
      expect(await getFeature("", "x")).toBeUndefined();
      expect(await getFeature(projectId, "")).toBeUndefined();
    });

    test("returns feature with empty files array when none exist", async () => {
      await createFeature({ projectId, name: "empty" });
      const got = await getFeature(projectId, "empty");
      expect(got).toBeDefined();
      expect(got!.files).toEqual([]);
    });
  });

  // ── listFeatures ───────────────────────────────────────────────────
  describe("listFeatures", () => {
    test("returns features ordered by name with file counts", async () => {
      const a = await createFeature({ projectId, name: "z-feat" });
      const b = await createFeature({ projectId, name: "a-feat" });
      await replaceAgentFiles(a.id, ["src/z/1.ts", "src/z/2.ts"]);
      await replaceAgentFiles(b.id, ["src/a/1.ts"]);

      const list = await listFeatures(projectId);
      expect(list.map((f) => f.name)).toEqual(["a-feat", "z-feat"]);
      const byName = new Map(list.map((f) => [f.name, f.fileCount]));
      expect(byName.get("a-feat")).toBe(1);
      expect(byName.get("z-feat")).toBe(2);
    });

    test("fileCount is the UNION of source='scan' AND source='user' rows (no source bias)", async () => {
      // PM headline ask: count must reflect every featureFiles row regardless
      // of source. A bug here would surface as the UI under-reporting how
      // many files belong to a feature after the user pins manual files.
      const f = await createFeature({ projectId, name: "union", source: "user" });
      await replaceAgentFiles(f.id, ["src/scan-a.ts", "src/scan-b.ts"]);
      await addUserFile(f.id, "src/pinned.ts");

      const list = await listFeatures(projectId);
      const row = list.find((x) => x.name === "union");
      expect(row).toBeDefined();
      // 2 scan + 1 user = 3 total.
      expect(row!.fileCount).toBe(3);
    });

    test("zero-file features return fileCount=0 (not omitted)", async () => {
      await createFeature({ projectId, name: "lonely" });
      const list = await listFeatures(projectId);
      expect(list).toHaveLength(1);
      expect(list[0]!.fileCount).toBe(0);
    });

    test("returns empty array when project has no features", async () => {
      expect(await listFeatures(projectId)).toEqual([]);
    });

    test("returns empty array for empty projectId (guard)", async () => {
      expect(await listFeatures("")).toEqual([]);
    });

    test("scopes to project — does not leak across projects", async () => {
      await createFeature({ projectId, name: "mine" });
      await createFeature({ projectId: otherProjectId, name: "yours" });
      const list = await listFeatures(projectId);
      expect(list.map((f) => f.name)).toEqual(["mine"]);
    });
  });

  // ── updateFeature ──────────────────────────────────────────────────
  describe("updateFeature", () => {
    test("patches name, description, source and bumps updatedAt", async () => {
      const f = await createFeature({
        projectId,
        name: "u1",
        description: "old",
        source: "agent",
      });
      const originalTs = f.updatedAt.getTime();
      await new Promise((r) => setTimeout(r, 5));

      const updated = await updateFeature(f.id, {
        name: "u1-renamed",
        description: "new",
        source: "user",
      });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("u1-renamed");
      expect(updated!.description).toBe("new");
      expect(updated!.source).toBe("user");
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(originalTs);
    });

    test("does NOT auto-flip source — source stays 'agent' unless explicitly set", async () => {
      // The doc-comment in queries/features.ts: this module is mechanical
      // CRUD; the REST PATCH owns the agent→user flip policy. We verify
      // the mechanical contract here.
      const f = await createFeature({ projectId, name: "auto", source: "agent" });
      const updated = await updateFeature(f.id, { description: "edited" });
      expect(updated!.source).toBe("agent");
    });

    test("returns undefined for missing id", async () => {
      const result = await updateFeature(crypto.randomUUID(), { name: "x" });
      expect(result).toBeUndefined();
    });

    test("returns undefined for empty id", async () => {
      expect(await updateFeature("", { name: "x" })).toBeUndefined();
    });

    test("partial patch leaves untouched fields intact", async () => {
      const f = await createFeature({
        projectId,
        name: "partial",
        description: "keep me",
        source: "agent",
      });
      const updated = await updateFeature(f.id, { name: "renamed" });
      expect(updated!.description).toBe("keep me");
      expect(updated!.source).toBe("agent");
    });
  });

  // ── deleteFeature ──────────────────────────────────────────────────
  describe("deleteFeature", () => {
    test("removes the row and returns true; second call returns false", async () => {
      const f = await createFeature({ projectId, name: "del" });
      expect(await deleteFeature(f.id)).toBe(true);
      expect(await getFeature(projectId, "del")).toBeUndefined();
      expect(await deleteFeature(f.id)).toBe(false);
    });

    test("returns false for missing id", async () => {
      expect(await deleteFeature(crypto.randomUUID())).toBe(false);
    });

    test("returns false for empty id", async () => {
      expect(await deleteFeature("")).toBe(false);
    });

    test("cascades to feature_files (BOTH source='scan' AND source='user')", async () => {
      // The design doc is explicit: deleting a feature drops every
      // feature_file row regardless of source. The user has explicitly
      // opted to remove the bucket.
      const f = await createFeature({ projectId, name: "cascade" });
      await replaceAgentFiles(f.id, ["src/cascade/scanned.ts"]);
      await addUserFile(f.id, "src/cascade/pinned.ts");

      // Both rows present before delete
      const before = await getFeature(projectId, "cascade");
      expect(before!.files.map((x) => x.relpath).sort()).toEqual([
        "src/cascade/pinned.ts",
        "src/cascade/scanned.ts",
      ]);

      expect(await deleteFeature(f.id)).toBe(true);
      // Re-create another feature to query feature_files indirectly via
      // a known-good query path (no direct table access in this module).
      // Better: insert again with the same name and confirm files empty.
      const recreated = await createFeature({ projectId, name: "cascade" });
      const after = await getFeature(projectId, "cascade");
      expect(after!.id).toBe(recreated.id);
      expect(after!.files).toEqual([]);
    });
  });

  // ── replaceAgentFiles — the headline invariant ─────────────────────
  describe("replaceAgentFiles (source-column invariant)", () => {
    test("LOAD-BEARING: preserves source='user' rows across rescan", async () => {
      const f = await createFeature({ projectId, name: "hybrid" });
      // First scan: three scan files.
      await replaceAgentFiles(f.id, ["src/a.ts", "src/b.ts", "src/c.ts"]);
      // User pins an additional file.
      await addUserFile(f.id, "src/pinned.ts");
      // Rescan: only one file remains in the scan output.
      await replaceAgentFiles(f.id, ["src/a.ts"]);

      const got = await getFeature(projectId, "hybrid");
      const bySource = new Map<string, string>();
      for (const r of got!.files) bySource.set(r.relpath, r.source);

      // Scan rows: only 'src/a.ts' remains (b.ts + c.ts deleted).
      expect(bySource.get("src/a.ts")).toBe("scan");
      expect(bySource.has("src/b.ts")).toBe(false);
      expect(bySource.has("src/c.ts")).toBe(false);
      // User pin survives.
      expect(bySource.get("src/pinned.ts")).toBe("user");
    });

    test("scan input that collides with a user-pinned path keeps the user row (no PK collision)", async () => {
      // The composite PK is (feature_id, relpath). If the scan tried to
      // insert a row at the same relpath the user pinned, the insert
      // would fail. The query module dedupes the input against pinned
      // paths first.
      const f = await createFeature({ projectId, name: "collide" });
      await addUserFile(f.id, "src/shared.ts");
      // Should NOT throw — query module skips already-pinned paths.
      await replaceAgentFiles(f.id, ["src/shared.ts", "src/scanned-only.ts"]);

      const got = await getFeature(projectId, "collide");
      const bySource = new Map<string, string>();
      for (const r of got!.files) bySource.set(r.relpath, r.source);

      // The user's row wins (still 'user' source).
      expect(bySource.get("src/shared.ts")).toBe("user");
      expect(bySource.get("src/scanned-only.ts")).toBe("scan");
    });

    test("dedupes duplicate relpaths in the input array", async () => {
      const f = await createFeature({ projectId, name: "dedupe" });
      await replaceAgentFiles(f.id, ["src/x.ts", "src/x.ts", "src/y.ts"]);
      const got = await getFeature(projectId, "dedupe");
      expect(got!.files.map((x) => x.relpath)).toEqual(["src/x.ts", "src/y.ts"]);
    });

    test("empty relpaths input deletes existing scan rows but preserves user rows", async () => {
      const f = await createFeature({ projectId, name: "wipe" });
      await replaceAgentFiles(f.id, ["src/old1.ts", "src/old2.ts"]);
      await addUserFile(f.id, "src/keep.ts");

      await replaceAgentFiles(f.id, []);

      const got = await getFeature(projectId, "wipe");
      expect(got!.files.map((x) => x.relpath)).toEqual(["src/keep.ts"]);
      expect(got!.files[0]!.source).toBe("user");
    });

    test("idempotent — same input twice produces the same output", async () => {
      const f = await createFeature({ projectId, name: "idem" });
      await replaceAgentFiles(f.id, ["src/a.ts", "src/b.ts"]);
      const after1 = await getFeature(projectId, "idem");
      await replaceAgentFiles(f.id, ["src/a.ts", "src/b.ts"]);
      const after2 = await getFeature(projectId, "idem");
      expect(after2!.files.map((x) => x.relpath)).toEqual(
        after1!.files.map((x) => x.relpath),
      );
    });

    test("no-op for empty featureId", async () => {
      // No throw, no rows inserted.
      await replaceAgentFiles("", ["src/x.ts"]);
    });
  });

  // ── addUserFile ────────────────────────────────────────────────────
  describe("addUserFile", () => {
    test("inserts a user-sourced file row", async () => {
      const f = await createFeature({ projectId, name: "pin" });
      await addUserFile(f.id, "src/pinned.ts");
      const got = await getFeature(projectId, "pin");
      expect(got!.files).toEqual([
        expect.objectContaining({ relpath: "src/pinned.ts", source: "user" }),
      ]);
    });

    test("idempotent — re-pinning the same path is a no-op (onConflictDoNothing)", async () => {
      const f = await createFeature({ projectId, name: "idempin" });
      await addUserFile(f.id, "src/p.ts");
      await addUserFile(f.id, "src/p.ts");
      const got = await getFeature(projectId, "idempin");
      expect(got!.files).toHaveLength(1);
    });

    test("addUserFile on top of an existing scan row leaves the scan row intact", async () => {
      // The composite-PK collision is caught by onConflictDoNothing —
      // the existing 'scan' row is NOT promoted to 'user'. Promotion (if
      // ever needed) is a separate operation.
      const f = await createFeature({ projectId, name: "promote" });
      await replaceAgentFiles(f.id, ["src/p.ts"]);
      await addUserFile(f.id, "src/p.ts");
      const got = await getFeature(projectId, "promote");
      expect(got!.files).toHaveLength(1);
      expect(got!.files[0]!.source).toBe("scan");
    });

    test("guards against empty inputs", async () => {
      const f = await createFeature({ projectId, name: "guard" });
      await addUserFile("", "src/x.ts");
      await addUserFile(f.id, "");
      const got = await getFeature(projectId, "guard");
      expect(got!.files).toEqual([]);
    });
  });

  // ── removeFile ─────────────────────────────────────────────────────
  describe("removeFile", () => {
    test("removes user-pinned and scan rows alike, returns true", async () => {
      const f = await createFeature({ projectId, name: "rm" });
      await replaceAgentFiles(f.id, ["src/scanned.ts"]);
      await addUserFile(f.id, "src/pinned.ts");

      expect(await removeFile(f.id, "src/scanned.ts")).toBe(true);
      expect(await removeFile(f.id, "src/pinned.ts")).toBe(true);

      const got = await getFeature(projectId, "rm");
      expect(got!.files).toEqual([]);
    });

    test("returns false for unknown relpath", async () => {
      const f = await createFeature({ projectId, name: "rm-missing" });
      expect(await removeFile(f.id, "src/never.ts")).toBe(false);
    });

    test("guards against empty inputs", async () => {
      expect(await removeFile("", "src/x.ts")).toBe(false);
      expect(await removeFile("anything", "")).toBe(false);
    });
  });

  // ── Project FK cascade ─────────────────────────────────────────────
  describe("project deletion cascade", () => {
    test("deleting a project removes all its features AND their files", async () => {
      const f1 = await createFeature({ projectId, name: "casc1" });
      const f2 = await createFeature({ projectId, name: "casc2" });
      await replaceAgentFiles(f1.id, ["src/casc1/a.ts"]);
      await addUserFile(f2.id, "src/casc2/pinned.ts");
      // Sanity: features exist before project delete
      expect((await listFeatures(projectId)).length).toBe(2);

      expect(await deleteProject(projectId)).toBe(true);

      // Project gone → features gone (FK cascade)
      expect(await listFeatures(projectId)).toEqual([]);
      expect(await getFeature(projectId, "casc1")).toBeUndefined();
      expect(await getFeature(projectId, "casc2")).toBeUndefined();
      // Other project's features remain untouched.
      expect(await listFeatures(otherProjectId)).toEqual([]);
    });
  });
});
