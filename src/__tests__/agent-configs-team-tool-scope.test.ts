import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createAgentConfig,
  getAgentConfig,
  updateAgentConfig,
} from "../db/queries/agent-configs";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe("agent-configs — teamToolScope persistence", () => {
  test("createAgentConfig round-trips teamToolScope.allowedTools", async () => {
    const cfg = await createAgentConfig({
      name: "team-allow-only",
      description: "Team with allow list",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { allowedTools: ["read_file", "grep"] },
      },
    });
    expect(cfg.references?.teamToolScope?.allowedTools).toEqual(["read_file", "grep"]);
    expect(cfg.references?.teamToolScope?.deniedTools).toBeUndefined();

    // Re-read from DB to confirm it didn't just round-trip in memory.
    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.references?.teamToolScope?.allowedTools).toEqual(["read_file", "grep"]);
  });

  test("createAgentConfig round-trips teamToolScope.deniedTools", async () => {
    const cfg = await createAgentConfig({
      name: "team-deny-only",
      description: "Team with deny list",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { deniedTools: ["bash_execute"] },
      },
    });
    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);
  });

  test("createAgentConfig round-trips both allowedTools and deniedTools", async () => {
    const cfg = await createAgentConfig({
      name: "team-both",
      description: "Team with both lists",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { allowedTools: ["read_file"], deniedTools: ["bash_execute"] },
      },
    });
    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);
    expect(fetched?.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);
  });

  test("createAgentConfig without teamToolScope does not set the field", async () => {
    const cfg = await createAgentConfig({
      name: "team-no-scope",
      description: "Team without scope",
      prompt: "Coordinate",
      category: "team",
      references: { agents: [], extensions: [] },
    });
    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.references?.teamToolScope).toBeUndefined();
  });

  test("updateAgentConfig can add teamToolScope to an existing team", async () => {
    const cfg = await createAgentConfig({
      name: "team-add-scope",
      description: "Will get scope later",
      prompt: "Coordinate",
      category: "team",
      references: { agents: [], extensions: [] },
    });
    expect(cfg.references?.teamToolScope).toBeUndefined();

    const updated = await updateAgentConfig(cfg.id, {
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { allowedTools: ["read_file"], deniedTools: ["bash_execute"] },
      },
    });
    expect(updated?.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);
    expect(updated?.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);

    const refetched = await getAgentConfig(cfg.id);
    expect(refetched?.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);
    expect(refetched?.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);
  });

  test("updateAgentConfig can clear teamToolScope by omitting it", async () => {
    const cfg = await createAgentConfig({
      name: "team-clear-scope",
      description: "Will lose scope",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        teamToolScope: { allowedTools: ["read_file"] },
      },
    });
    expect(cfg.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);

    // Update references without teamToolScope → should clear it.
    const updated = await updateAgentConfig(cfg.id, {
      references: { agents: [], extensions: [] },
    });
    expect(updated?.references?.teamToolScope).toBeUndefined();
  });

  test("updateAgentConfig preserves other fields when updating teamToolScope", async () => {
    const cfg = await createAgentConfig({
      name: "team-preserve",
      description: "Should preserve members",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["a-1"],
        extensions: [],
        members: [{ agentConfigId: "a-1" }],
      },
    });

    const updated = await updateAgentConfig(cfg.id, {
      references: {
        agents: ["a-1"],
        extensions: [],
        members: [{ agentConfigId: "a-1" }],
        teamToolScope: { deniedTools: ["bash_execute"] },
      },
    });
    expect(updated?.references?.agents).toEqual(["a-1"]);
    expect(updated?.references?.members).toHaveLength(1);
    expect(updated?.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);
  });
});
