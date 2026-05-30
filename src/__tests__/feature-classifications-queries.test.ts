import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import {
  getClassification,
  upsertClassification,
  pruneStaleClassifications,
  listLatestClassifications,
} from "../db/queries/feature-classifications";
import { projects, features } from "../db/schema";
import type { SurfaceVerdicts } from "../db/schema";
import { sql } from "drizzle-orm";

const VERDICTS: SurfaceVerdicts = {
  sdk: { exposed: true, via: "precheck" },
  ezbutton: { exposed: false, via: "llm" },
  mcp: { exposed: false, via: "precheck" },
};

let projectId: string;
let featureA: string;
let featureB: string;

async function seedFeature(pid: string, name: string): Promise<string> {
  const db = getTestDb();
  const rows = await db
    .insert(features)
    .values({ projectId: pid, name })
    .returning({ id: features.id });
  return rows[0]!.id;
}

beforeEach(async () => {
  await setupTestDb();
  const db = getTestDb();
  const proj = await db
    .insert(projects)
    .values({ name: "proj", path: "/tmp/proj" })
    .returning({ id: projects.id });
  projectId = proj[0]!.id;
  featureA = await seedFeature(projectId, "feature-a");
  featureB = await seedFeature(projectId, "feature-b");
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("getClassification", () => {
  test("returns undefined on empty featureId / contentHash (guard)", async () => {
    expect(await getClassification("", "h")).toBeUndefined();
    expect(await getClassification(featureA, "")).toBeUndefined();
  });

  test("returns undefined when no row matches", async () => {
    expect(await getClassification(featureA, "nohash")).toBeUndefined();
  });

  test("returns the stored row after an upsert", async () => {
    await upsertClassification({ featureId: featureA, contentHash: "h1", surfaces: VERDICTS });
    const got = await getClassification(featureA, "h1");
    expect(got?.featureId).toBe(featureA);
    expect(got?.contentHash).toBe("h1");
    expect(got?.surfaces).toEqual(VERDICTS);
    expect(got?.rationale).toBe(""); // default when omitted
  });
});

describe("upsertClassification", () => {
  test("throws when featureId is missing", async () => {
    await expect(
      upsertClassification({ featureId: "", contentHash: "h", surfaces: VERDICTS }),
    ).rejects.toThrow("featureId is required");
  });

  test("throws when contentHash is missing", async () => {
    await expect(
      upsertClassification({ featureId: featureA, contentHash: "", surfaces: VERDICTS }),
    ).rejects.toThrow("contentHash is required");
  });

  test("inserts a new row, persisting rationale", async () => {
    const row = await upsertClassification({
      featureId: featureA,
      contentHash: "h1",
      surfaces: VERDICTS,
      rationale: "because",
    });
    expect(row.rationale).toBe("because");
    expect(row.featureId).toBe(featureA);
  });

  test("updates the existing row on (featureId, contentHash) conflict", async () => {
    await upsertClassification({
      featureId: featureA,
      contentHash: "h1",
      surfaces: VERDICTS,
      rationale: "first",
    });
    const updated = await upsertClassification({
      featureId: featureA,
      contentHash: "h1",
      surfaces: { ...VERDICTS, mcp: { exposed: true, via: "llm" } },
      rationale: "second",
    });
    expect(updated.rationale).toBe("second");
    expect(updated.surfaces.mcp).toEqual({ exposed: true, via: "llm" });

    // Still exactly one row for that (feature, hash).
    const got = await getClassification(featureA, "h1");
    expect(got?.rationale).toBe("second");
  });
});

describe("pruneStaleClassifications", () => {
  test("returns 0 on empty featureId / keepHash (guard)", async () => {
    expect(await pruneStaleClassifications("", "h")).toBe(0);
    expect(await pruneStaleClassifications(featureA, "")).toBe(0);
  });

  test("drops every row for the feature except the kept hash", async () => {
    await upsertClassification({ featureId: featureA, contentHash: "old1", surfaces: VERDICTS });
    await upsertClassification({ featureId: featureA, contentHash: "old2", surfaces: VERDICTS });
    await upsertClassification({ featureId: featureA, contentHash: "keep", surfaces: VERDICTS });

    const deleted = await pruneStaleClassifications(featureA, "keep");
    expect(deleted).toBe(2);
    expect(await getClassification(featureA, "keep")).toBeDefined();
    expect(await getClassification(featureA, "old1")).toBeUndefined();
  });

  test("returns 0 when nothing is stale", async () => {
    await upsertClassification({ featureId: featureA, contentHash: "keep", surfaces: VERDICTS });
    expect(await pruneStaleClassifications(featureA, "keep")).toBe(0);
  });
});

describe("listLatestClassifications", () => {
  test("returns [] on empty projectId (guard)", async () => {
    expect(await listLatestClassifications("")).toEqual([]);
  });

  test("returns [] when the project has no features", async () => {
    const db = getTestDb();
    const empty = await db
      .insert(projects)
      .values({ name: "empty", path: "/tmp/empty" })
      .returning({ id: projects.id });
    expect(await listLatestClassifications(empty[0]!.id)).toEqual([]);
  });

  test("returns at most one (latest) row per feature in the project", async () => {
    // Two hashes for featureA — the later classifiedAt should win — plus one
    // for featureB. Insert featureA's "old" first, then "new".
    await upsertClassification({ featureId: featureA, contentHash: "a-old", surfaces: VERDICTS });
    await upsertClassification({ featureId: featureA, contentHash: "a-new", surfaces: VERDICTS });
    // classifiedAt defaults to now(); both inserts can collide within a ms, so
    // bump a-new explicitly to make it unambiguously the latest for featureA.
    const db = getTestDb();
    await db.execute(
      sql`UPDATE feature_classifications SET classified_at = now() + interval '1 second' WHERE feature_id = ${featureA} AND content_hash = 'a-new'`,
    );
    await upsertClassification({ featureId: featureB, contentHash: "b-1", surfaces: VERDICTS });

    const latest = await listLatestClassifications(projectId);
    expect(latest.length).toBe(2); // one per feature
    const byFeature = Object.fromEntries(latest.map((r) => [r.featureId, r.contentHash]));
    expect(byFeature[featureA]).toBe("a-new");
    expect(byFeature[featureB]).toBe("b-1");
  });
});
