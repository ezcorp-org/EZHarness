/**
 * Covers the `pipeline:list` CLI dispatch (the `case "pipeline:list"` block
 * in cli()) with mocked DB/loader surfaces — the empty case and the listing
 * case, including the YAML + DB merge.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let yamlPipelines: Array<{ name: string; description?: string; steps: unknown[] }> = [];
let dbPipelines: Array<{ name: string; description?: string; steps: unknown[] }> = [];

// Mock BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../runtime/pipeline-loader", () => ({
  loadYamlPipelines: async () => yamlPipelines,
}));
mock.module("../db/queries/pipelines", () => ({
  loadDbPipelines: async () => dbPipelines,
}));

const { cli } = await import("../cli");

let logs: string[] = [];
const origLog = console.log;
beforeEach(() => {
  logs = [];
  yamlPipelines = [];
  dbPipelines = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
});
afterEach(() => {
  console.log = origLog;
});
afterAll(() => restoreModuleMocks());

describe("cli pipeline:list dispatch", () => {
  test("prints the empty message when no pipelines exist", async () => {
    await cli(["pipeline", "list"]);
    expect(logs.join("\n")).toContain("No pipelines found.");
  });

  test("lists YAML and DB pipelines together", async () => {
    yamlPipelines = [{ name: "yaml-pipe", description: "from yaml", steps: [1] }];
    dbPipelines = [{ name: "db-pipe", description: "from db", steps: [1, 2] }];
    await cli(["pipeline", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("yaml-pipe");
    expect(out).toContain("db-pipe");
    expect(out).not.toContain("No pipelines found.");
  });
});
