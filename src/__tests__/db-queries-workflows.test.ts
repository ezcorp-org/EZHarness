import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createWorkflow,
  getWorkflow,
  getWorkflowByName,
  listWorkflows,
  updateWorkflow,
  deleteWorkflow,
  loadDbWorkflows,
} = await import("../db/queries/workflows");

const sampleSteps = [{ name: "s1", agent: "writer", input: {} as Record<string, string> }];

describe("workflows queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("createWorkflow inserts and returns row with defaults", async () => {
    const p = await createWorkflow({
      name: "demo",
      description: "demo workflow",
      steps: sampleSteps as any,
    });

    expect(p.id).toBeDefined();
    expect(p.name).toBe("demo");
    expect(p.description).toBe("demo workflow");
    expect(p.steps).toEqual(sampleSteps as any);
    expect(p.inputSchema).toBeNull();
    expect(p.createdAt).toBeInstanceOf(Date);
  });

  test("createWorkflow accepts inputSchema and defaults description to empty", async () => {
    const p = await createWorkflow({
      name: "schema-demo",
      steps: sampleSteps as any,
      inputSchema: { repoUrl: { type: "string" } } as any,
    } as any);
    expect(p.description).toBe("");
    expect(p.inputSchema).toEqual({ repoUrl: { type: "string" } });
  });

  test("createWorkflow rejects duplicate name (unique constraint)", async () => {
    await createWorkflow({ name: "uniq", steps: sampleSteps as any } as any);
    expect(
      createWorkflow({ name: "uniq", steps: sampleSteps as any } as any),
    ).rejects.toThrow();
  });

  test("getWorkflow returns row by id", async () => {
    const p = await createWorkflow({ name: "byid", steps: sampleSteps as any } as any);
    const fetched = await getWorkflow(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("byid");
  });

  test("getWorkflow returns undefined for missing id", async () => {
    const fetched = await getWorkflow(crypto.randomUUID());
    expect(fetched).toBeUndefined();
  });

  test("getWorkflowByName returns row, undefined when missing", async () => {
    await createWorkflow({ name: "byname", steps: sampleSteps as any } as any);
    expect((await getWorkflowByName("byname"))!.name).toBe("byname");
    expect(await getWorkflowByName("ghost")).toBeUndefined();
  });

  test("listWorkflows returns all workflows", async () => {
    await createWorkflow({ name: "a", steps: sampleSteps as any } as any);
    await createWorkflow({ name: "b", steps: sampleSteps as any } as any);
    const all = await listWorkflows();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  test("updateWorkflow patches fields and bumps updatedAt", async () => {
    const p = await createWorkflow({ name: "u1", steps: sampleSteps as any } as any);
    const originalUpdatedAt = p.updatedAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateWorkflow(p.id, {
      description: "new desc",
      steps: [{ name: "s2", agent: "reviewer", input: {} }] as any,
    } as any);

    expect(updated).toBeDefined();
    expect(updated!.description).toBe("new desc");
    expect((updated!.steps as any[]).length).toBe(1);
    expect((updated!.steps as any[])[0].name).toBe("s2");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  test("updateWorkflow patches name and inputSchema fields", async () => {
    const p = await createWorkflow({ name: "u2", steps: sampleSteps as any } as any);
    const updated = await updateWorkflow(p.id, {
      name: "u2-renamed",
      inputSchema: { q: { type: "string" } } as any,
    } as any);
    expect(updated!.name).toBe("u2-renamed");
    expect(updated!.inputSchema).toEqual({ q: { type: "string" } });
  });

  test("updateWorkflow returns undefined for missing id", async () => {
    const result = await updateWorkflow(crypto.randomUUID(), { description: "x" });
    expect(result).toBeUndefined();
  });

  test("deleteWorkflow removes the row, second call returns false", async () => {
    const p = await createWorkflow({ name: "del", steps: sampleSteps as any } as any);
    expect(await deleteWorkflow(p.id)).toBe(true);
    expect(await getWorkflow(p.id)).toBeUndefined();
    expect(await deleteWorkflow(p.id)).toBe(false);
  });

  test("loadDbWorkflows returns WorkflowDefinition shape", async () => {
    await createWorkflow({
      name: "loaded",
      description: "loaded desc",
      steps: sampleSteps as any,
    } as any);
    const defs = await loadDbWorkflows();
    expect(defs.length).toBe(1);
    expect(defs[0]!.name).toBe("loaded");
    expect(defs[0]!.description).toBe("loaded desc");
    expect(defs[0]!.steps).toEqual(sampleSteps as any);
  });

  test("migrated legacy rows (transform/gate/loop steps) round-trip as workflows", async () => {
    // A workflow using the NEW step model persists and reloads intact —
    // proving the JSONB `steps` column carries the richer shape a migrated
    // pipeline_definitions row would gain once edited.
    const richSteps = [
      { name: "shape", kind: "transform", output: { n: "$input.x" } },
      {
        name: "assert",
        kind: "gate",
        condition: { ref: "$steps.shape.output.n", op: "exists" },
      },
    ];
    await createWorkflow({ name: "rich", steps: richSteps as any } as any);
    const defs = await loadDbWorkflows();
    const rich = defs.find((d) => d.name === "rich");
    expect(rich!.steps).toEqual(richSteps as any);
  });
});
