import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// MUST be before any module imports that use DB
mockDbConnection();

import { flattenMemberIds, createAgentConfig, updateAgentConfig, getAgentConfig } from "../db/queries/agent-configs";

function member(id: string, subAgents?: Parameters<typeof flattenMemberIds>[0]): Parameters<typeof flattenMemberIds>[0][0] {
  return { agentConfigId: id, ...(subAgents ? { subAgents } : {}) };
}

describe("flattenMemberIds", () => {
  test("empty array returns empty", () => {
    expect(flattenMemberIds([])).toEqual([]);
  });

  test("single member returns its ID", () => {
    expect(flattenMemberIds([member("a1")])).toEqual(["a1"]);
  });

  test("multiple members returns all IDs", () => {
    expect(flattenMemberIds([member("a1"), member("a2"), member("a3")])).toEqual(["a1", "a2", "a3"]);
  });

  test("nested subAgents are included (2 levels)", () => {
    const members = [member("a1", [member("a2")])];
    expect(flattenMemberIds(members)).toEqual(["a1", "a2"]);
  });

  test("deep nesting (3 levels) collects all IDs", () => {
    const members = [
      member("a1", [
        member("a2", [
          member("a3"),
        ]),
      ]),
    ];
    expect(flattenMemberIds(members)).toEqual(["a1", "a2", "a3"]);
  });

  test("duplicate IDs are deduplicated", () => {
    const members = [
      member("a1", [member("a2")]),
      member("a2", [member("a1")]),
    ];
    const result = flattenMemberIds(members);
    expect(result).toEqual(["a1", "a2"]);
  });

  test("members with no subAgents work correctly", () => {
    const members = [member("a1"), member("a2")];
    expect(flattenMemberIds(members)).toEqual(["a1", "a2"]);
  });
});

describe("members persistence in DB", () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    restoreModuleMocks();
    await closeTestDb();
  });

  test("createAgentConfig persists references.members", async () => {
    const config = await createAgentConfig({
      name: "persist-test-team",
      description: "test",
      prompt: "test",
      category: "team",
      references: {
        agents: ["m1"],
        extensions: [],
        members: [{ agentConfigId: "m1", overrides: { permissionMode: "yolo" } }],
      },
    });
    const fetched = await getAgentConfig(config.id);
    expect(fetched?.references?.members).toBeDefined();
    expect(fetched?.references?.members?.length).toBe(1);
    expect(fetched?.references?.members?.[0]?.agentConfigId).toBe("m1");
    expect(fetched?.references?.members?.[0]?.overrides?.permissionMode).toBe("yolo");
  });

  test("updateAgentConfig persists references.members", async () => {
    const config = await createAgentConfig({
      name: "update-members-team",
      description: "test",
      prompt: "test",
      category: "team",
      references: {
        agents: ["m1"],
        extensions: [],
        members: [{ agentConfigId: "m1" }],
      },
    });

    await updateAgentConfig(config.id, {
      references: {
        agents: ["m1", "m2"],
        extensions: [],
        members: [
          { agentConfigId: "m1" },
          { agentConfigId: "m2", overrides: { toolRestriction: "read-only" }, subAgents: [{ agentConfigId: "m3" }] },
        ],
      },
    });
    const fetched = await getAgentConfig(config.id);
    expect(fetched?.references?.members?.length).toBe(2);
    expect(fetched?.references?.members?.[1]?.subAgents?.length).toBe(1);
  });

  test("createAgentConfig without members does not include members key", async () => {
    const config = await createAgentConfig({
      name: "no-members-team",
      description: "test",
      prompt: "test",
      category: "team",
      references: {
        agents: [],
        extensions: [],
      },
    });
    const fetched = await getAgentConfig(config.id);
    expect(fetched?.references?.members).toBeUndefined();
  });

  test("createAgentConfig persists autoSpinUp flag", async () => {
    const config = await createAgentConfig({
      name: "auto-spin-up-team",
      description: "test",
      prompt: "test",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        autoSpinUp: true,
      },
    });
    const fetched = await getAgentConfig(config.id);
    expect(fetched?.references?.autoSpinUp).toBe(true);
  });

  test("updateAgentConfig persists autoSpinUp flag", async () => {
    const config = await createAgentConfig({
      name: "update-auto-spin-team",
      description: "test",
      prompt: "test",
      category: "team",
      references: {
        agents: [],
        extensions: [],
      },
    });

    await updateAgentConfig(config.id, {
      references: {
        agents: [],
        extensions: [],
        autoSpinUp: true,
      },
    });
    const fetched = await getAgentConfig(config.id);
    expect(fetched?.references?.autoSpinUp).toBe(true);
  });
});
