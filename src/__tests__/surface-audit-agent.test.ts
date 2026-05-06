import { test, expect, describe } from "bun:test";
import surfaceAuditAgent from "../agents/surface-audit.agent";
import type { AgentContext } from "../types";

function makeCtx(input: Record<string, unknown>): AgentContext {
  return {
    input,
    llm: { async complete() { return { text: "{}" }; } },
    shell: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
    file: {
      async read() { return ""; },
      async write() {},
      async exists() { return false; },
    },
    log() {},
    signal: new AbortController().signal,
    async run() { return { success: true, output: null }; },
  };
}

describe("surface-audit agent definition", () => {
  test("name is surface-audit", () => {
    expect(surfaceAuditAgent.name).toBe("surface-audit");
  });

  test("description mentions all three surfaces", () => {
    expect(surfaceAuditAgent.description).toMatch(/SDK/);
    expect(surfaceAuditAgent.description).toMatch(/EzButton/);
    expect(surfaceAuditAgent.description).toMatch(/MCP/);
  });

  test("declares llm + file capabilities", () => {
    expect(surfaceAuditAgent.capabilities).toContain("llm");
    expect(surfaceAuditAgent.capabilities).toContain("file");
  });

  test("inputSchema requires projectId", () => {
    const schema = surfaceAuditAgent.inputSchema!;
    expect(schema.projectId).toBeDefined();
    expect(schema.projectId.required).toBe(true);
  });

  test("execute is a function", () => {
    expect(typeof surfaceAuditAgent.execute).toBe("function");
  });
});

describe("surface-audit execute — input validation", () => {
  test("returns error when projectId is missing", async () => {
    const ctx = makeCtx({});
    const result = await surfaceAuditAgent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(String(result.error)).toMatch(/projectId/);
  });
});
