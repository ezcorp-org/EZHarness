import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { createAgentConfig, getAgentConfig } from "../db/queries/agent-configs";
import { applyToolFilters } from "../runtime/tools/filter";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

// End-to-end in-process integration: save a team config with teamToolScope,
// read it back, feed it through the runtime filter. Guards the full pipeline:
// DB write/read round-trip + filter behavior. Does NOT go through the HTTP layer
// (that's covered by the zod schema tests and e2e tests).

function tool(name: string): AgentTool {
  return { name } as unknown as AgentTool;
}
function def(name: string, category: BuiltinToolDef["category"]): BuiltinToolDef {
  return { name, category } as unknown as BuiltinToolDef;
}

const sampleTools = (): AgentTool[] => [
  tool("read_file"),
  tool("grep"),
  tool("write_file"),
  tool("bash_execute"),
  tool("invoke_agent"),
];

const builtinDefs = new Map<string, BuiltinToolDef>([
  ["read_file", def("read_file", "read")],
  ["grep", def("grep", "read")],
  ["write_file", def("write_file", "write")],
  ["bash_execute", def("bash_execute", "execute")],
]);

const names = (ts: AgentTool[]) => ts.map((t) => t.name).sort();

describe("team tool scope — end-to-end (DB → filter)", () => {
  test("team saved with allowedTools yields filtered tool list", async () => {
    const cfg = await createAgentConfig({
      name: "e2e-allow-team",
      description: "",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { allowedTools: ["read_file"] },
      },
    });

    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);

    const filtered = applyToolFilters(sampleTools(), builtinDefs, {
      allowedTools: fetched!.references!.teamToolScope!.allowedTools,
    });
    // allow keeps read_file + always-preserved orchestration invoke_agent
    expect(names(filtered)).toEqual(["invoke_agent", "read_file"]);
  });

  test("team saved with deniedTools yields filtered tool list", async () => {
    const cfg = await createAgentConfig({
      name: "e2e-deny-team",
      description: "",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { deniedTools: ["bash_execute", "write_file"] },
      },
    });

    const fetched = await getAgentConfig(cfg.id);
    const filtered = applyToolFilters(sampleTools(), builtinDefs, {
      deniedTools: fetched!.references!.teamToolScope!.deniedTools,
    });
    expect(names(filtered)).toEqual(["grep", "invoke_agent", "read_file"]);
  });

  test("team saved with both lists: allow then deny", async () => {
    const cfg = await createAgentConfig({
      name: "e2e-both-team",
      description: "",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: {
          allowedTools: ["read_file", "grep", "write_file"],
          deniedTools: ["write_file"],
        },
      },
    });

    const fetched = await getAgentConfig(cfg.id);
    const filtered = applyToolFilters(sampleTools(), builtinDefs, {
      allowedTools: fetched!.references!.teamToolScope!.allowedTools,
      deniedTools: fetched!.references!.teamToolScope!.deniedTools,
    });
    // allow narrows to [read_file, grep, write_file] (+invoke_agent),
    // deny strips write_file → [read_file, grep, invoke_agent]
    expect(names(filtered)).toEqual(["grep", "invoke_agent", "read_file"]);
  });

  test("unscoped team leaves all tools intact", async () => {
    const cfg = await createAgentConfig({
      name: "e2e-no-scope-team",
      description: "",
      prompt: "Coordinate",
      category: "team",
      references: { agents: [], extensions: [] },
    });

    const fetched = await getAgentConfig(cfg.id);
    const scope = fetched?.references?.teamToolScope;
    const filtered = applyToolFilters(sampleTools(), builtinDefs, {
      allowedTools: scope?.allowedTools,
      deniedTools: scope?.deniedTools,
    });
    expect(names(filtered)).toEqual(names(sampleTools()));
  });
});
