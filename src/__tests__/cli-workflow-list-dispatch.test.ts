/**
 * Covers the `workflow:list` CLI dispatch (the `case "workflow:list"` block
 * in cli()) with mocked DB/loader surfaces — the empty case and the listing
 * case, including the YAML + DB merge — plus the hidden `pipeline` alias that
 * dispatches to the same `workflow:*` commands for one deprecation release.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let yamlWorkflows: Array<{ name: string; description?: string; steps: unknown[] }> = [];
let dbWorkflows: Array<{ name: string; description?: string; steps: unknown[] }> = [];

// Mock BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../runtime/workflow-loader", () => ({
  loadYamlWorkflows: async () => yamlWorkflows,
}));
mock.module("../db/queries/workflows", () => ({
  loadDbWorkflows: async () => dbWorkflows,
}));

const { cli } = await import("../cli");

let logs: string[] = [];
const origLog = console.log;
beforeEach(() => {
  logs = [];
  yamlWorkflows = [];
  dbWorkflows = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
});
afterEach(() => {
  console.log = origLog;
});
afterAll(() => restoreModuleMocks());

describe("cli workflow:list dispatch", () => {
  test("prints the empty message when no workflows exist", async () => {
    await cli(["workflow", "list"]);
    expect(logs.join("\n")).toContain("No workflows found.");
  });

  test("lists YAML and DB workflows together", async () => {
    yamlWorkflows = [{ name: "yaml-wf", description: "from yaml", steps: [1] }];
    dbWorkflows = [{ name: "db-wf", description: "from db", steps: [1, 2] }];
    await cli(["workflow", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("yaml-wf");
    expect(out).toContain("db-wf");
    expect(out).not.toContain("No workflows found.");
  });

  test("the hidden `pipeline` alias dispatches to the same `workflow:list`", async () => {
    dbWorkflows = [{ name: "aliased", description: "via alias", steps: [1] }];
    await cli(["pipeline", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("aliased");
  });
});
