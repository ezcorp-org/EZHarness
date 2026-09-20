import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();

const { projects, projectWorkspaceBindings } = await import("../db/schema");
const {
  configureSandboxWorkspaceDispatcher,
  projectRequiresSandbox,
  resolveWorkspaceTarget,
} = await import("../runtime/workspace/target");
const { resolveProjectBuiltinTools } = await import("../runtime/stream-chat/setup-tools");

const toolArguments: Record<string, Record<string, unknown>> = {
  readFile: { path: "marker.txt" },
  listFiles: { path: "." },
  readDirectory: { path: "." },
  editFile: { path: "marker.txt", new_string: "changed" },
  shell: { command: "pwd" },
  grep: { pattern: "marker" },
  glob: { pattern: "**/*" },
};

let root = "";

async function insertProject(id: string): Promise<void> {
  await getTestDb().insert(projects).values({ id, name: id, path: root });
}

async function bindSandbox(projectId: string, state: "active" | "unknown" = "active", revision = 1): Promise<void> {
  await getTestDb().insert(projectWorkspaceBindings).values({
    projectId,
    kind: "sandbox",
    bindingId: "fixture-binding",
    state,
    revision,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pluggable-workspace-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "marker.txt"), "LOCAL_MARKER");
  await setupTestDb();
});

afterEach(async () => {
  configureSandboxWorkspaceDispatcher(null);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

describe("persisted workspace routing", () => {
  test("the production setup seam sends all seven sandbox tools to the injected dispatcher", async () => {
    await insertProject("sandbox-project");
    await bindSandbox("sandbox-project");
    const calls: string[] = [];
    configureSandboxWorkspaceDispatcher(async (target, operation) => {
      calls.push(`${target.projectId}:${target.bindingId}:${operation}`);
      return { content: [{ type: "text", text: `GUEST_MARKER:${operation}` }], details: {} };
    });

    const tools = await resolveProjectBuiltinTools("sandbox-project");
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(toolArguments));
    for (const tool of tools) {
      const result = await tool.execute("call", toolArguments[tool.name]);
      expect(result.content[0]?.text).toBe(`GUEST_MARKER:${tool.name}`);
    }
    expect(calls).toEqual(Object.keys(toolArguments).map((operation) => `sandbox-project:fixture-binding:${operation}`));
  });

  test("an unavailable sandbox dispatcher denies all seven tools without reading the local checkout", async () => {
    await insertProject("unavailable-project");
    await bindSandbox("unavailable-project");
    // Passing a real local root here models a dispatched worktree. Sandbox
    // policy must ignore it rather than treating it as a fallback.
    const tools = await resolveProjectBuiltinTools("unavailable-project", root);
    for (const tool of tools) {
      const result = await tool.execute("call", toolArguments[tool.name]);
      expect(result.details).toMatchObject({ isError: true });
      expect(result.content[0]?.text).toContain("Sandbox workspace is unavailable");
    }
    expect(await Bun.file(join(root, "marker.txt")).text()).toBe("LOCAL_MARKER");
  });

  test("projects without a binding retain local tools", async () => {
    await insertProject("local-project");
    expect(await projectRequiresSandbox("local-project")).toBeFalse();
    const tools = await resolveProjectBuiltinTools("local-project");
    const result = await tools.find((tool) => tool.name === "readFile")!.execute("call", { path: "marker.txt" });
    expect(result.content[0]?.text).toBe("LOCAL_MARKER");
  });

  test("a host-validated local worktree remains the local tool root", async () => {
    await insertProject("pinned-local-project");
    const worktree = await mkdtemp(join(tmpdir(), "pluggable-worktree-"));
    try {
      await writeFile(join(worktree, "marker.txt"), "PINNED_MARKER");
      const tools = await resolveProjectBuiltinTools("pinned-local-project", worktree);
      const result = await tools.find((tool) => tool.name === "readFile")!.execute("call", { path: "marker.txt" });
      expect(result.content[0]?.text).toBe("PINNED_MARKER");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("unknown and stale sandbox bindings deny target resolution", async () => {
    await insertProject("unknown-project");
    await bindSandbox("unknown-project", "unknown");
    expect(await projectRequiresSandbox("unknown-project")).toBeTrue();
    await expect(resolveWorkspaceTarget("unknown-project")).rejects.toThrow("Sandbox workspace is unavailable");
    await getTestDb().update(projectWorkspaceBindings).set({ state: "active", revision: 2 }).where(eq(projectWorkspaceBindings.projectId, "unknown-project"));
    await expect(resolveWorkspaceTarget("unknown-project", 1)).rejects.toThrow("Sandbox workspace is unavailable");
  });
});
