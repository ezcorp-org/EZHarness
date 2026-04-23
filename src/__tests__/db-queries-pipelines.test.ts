import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createPipeline,
  getPipeline,
  getPipelineByName,
  listPipelines,
  updatePipeline,
  deletePipeline,
  loadDbPipelines,
} = await import("../db/queries/pipelines");

const sampleSteps = [
  { id: "s1", agent: "writer", inputs: {} as Record<string, unknown> },
];

describe("pipelines queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("createPipeline inserts and returns row with defaults", async () => {
    const p = await createPipeline({
      name: "demo",
      description: "demo pipeline",
      steps: sampleSteps as any,
    });

    expect(p.id).toBeDefined();
    expect(p.name).toBe("demo");
    expect(p.description).toBe("demo pipeline");
    expect(p.steps).toEqual(sampleSteps as any);
    expect(p.inputSchema).toBeNull();
    expect(p.createdAt).toBeInstanceOf(Date);
  });

  test("createPipeline accepts inputSchema and defaults description to empty", async () => {
    const p = await createPipeline({
      name: "schema-demo",
      steps: sampleSteps as any,
      inputSchema: { type: "object", properties: {} } as any,
    } as any);
    expect(p.description).toBe("");
    expect(p.inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("createPipeline rejects duplicate name (unique constraint)", async () => {
    await createPipeline({ name: "uniq", steps: sampleSteps as any } as any);
    expect(
      createPipeline({ name: "uniq", steps: sampleSteps as any } as any),
    ).rejects.toThrow();
  });

  test("getPipeline returns row by id", async () => {
    const p = await createPipeline({ name: "byid", steps: sampleSteps as any } as any);
    const fetched = await getPipeline(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("byid");
  });

  test("getPipeline returns undefined for missing id", async () => {
    const fetched = await getPipeline(crypto.randomUUID());
    expect(fetched).toBeUndefined();
  });

  test("getPipelineByName returns row, undefined when missing", async () => {
    await createPipeline({ name: "byname", steps: sampleSteps as any } as any);
    expect((await getPipelineByName("byname"))!.name).toBe("byname");
    expect(await getPipelineByName("ghost")).toBeUndefined();
  });

  test("listPipelines returns all pipelines", async () => {
    await createPipeline({ name: "a", steps: sampleSteps as any } as any);
    await createPipeline({ name: "b", steps: sampleSteps as any } as any);
    const all = await listPipelines();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  test("updatePipeline patches fields and bumps updatedAt", async () => {
    const p = await createPipeline({ name: "u1", steps: sampleSteps as any } as any);
    const originalUpdatedAt = p.updatedAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    const updated = await updatePipeline(p.id, {
      description: "new desc",
      steps: [{ id: "s2", agent: "reviewer", inputs: {} }] as any,
    } as any);

    expect(updated).toBeDefined();
    expect(updated!.description).toBe("new desc");
    expect((updated!.steps as any[]).length).toBe(1);
    expect((updated!.steps as any[])[0].id).toBe("s2");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  test("updatePipeline returns undefined for missing id", async () => {
    const result = await updatePipeline(crypto.randomUUID(), { description: "x" });
    expect(result).toBeUndefined();
  });

  test("deletePipeline removes the row, second call returns false", async () => {
    const p = await createPipeline({ name: "del", steps: sampleSteps as any } as any);
    expect(await deletePipeline(p.id)).toBe(true);
    expect(await getPipeline(p.id)).toBeUndefined();
    expect(await deletePipeline(p.id)).toBe(false);
  });

  test("loadDbPipelines returns PipelineDefinition shape", async () => {
    await createPipeline({
      name: "loaded",
      description: "loaded desc",
      steps: sampleSteps as any,
    } as any);
    const defs = await loadDbPipelines();
    expect(defs.length).toBe(1);
    expect(defs[0]!.name).toBe("loaded");
    expect(defs[0]!.description).toBe("loaded desc");
    expect(defs[0]!.steps).toEqual(sampleSteps as any);
  });
});
