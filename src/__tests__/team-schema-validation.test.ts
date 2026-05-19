import { test, expect, describe } from "bun:test";
import { createAgentConfigSchema } from "../../web/src/routes/api/agent-configs/schema";

const base = { name: "test", prompt: "test prompt" };

function member(id: string, opts?: { overrides?: Record<string, unknown>; subAgents?: unknown[] }) {
  return { agentConfigId: id, ...opts };
}

describe("createAgentConfigSchema", () => {
  test("valid team config with members passes validation", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [member("a1"), member("a2")],
      },
    });
    expect(result.success).toBe(true);
  });

  test("valid team config with nested subAgents (depth 2) passes", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [
          member("a1", { subAgents: [member("a2")] }),
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test("valid team config with nested subAgents (depth 3) passes", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [
          member("a1", {
            subAgents: [
              member("a2", {
                subAgents: [member("a3")],
              }),
            ],
          }),
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test("depth 4 nesting fails with 'nesting cannot exceed 3 levels' error", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [
          member("a1", {
            subAgents: [
              member("a2", {
                subAgents: [
                  member("a3", {
                    subAgents: [member("a4")],
                  }),
                ],
              }),
            ],
          }),
        ],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(", ");
      expect(msg).toContain("nesting cannot exceed 3 levels");
    }
  });

  test("member with all overrides passes validation", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [
          member("a1", {
            overrides: {
              permissionMode: "yolo",
              toolRestriction: "read-only",
              provider: "openai",
              model: "gpt-4",
              systemPromptAppend: "extra instructions",
            },
          }),
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test("invalid permissionMode value fails", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [
          member("a1", {
            overrides: { permissionMode: "invalid" },
          }),
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  test("invalid toolRestriction value fails", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [
          member("a1", {
            overrides: { toolRestriction: "invalid" },
          }),
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  test("empty members array passes", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: { members: [] },
    });
    expect(result.success).toBe(true);
  });

  test("member without overrides passes", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: {
        members: [{ agentConfigId: "a1" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("max 20 members limit rejects 21 members", () => {
    const members = Array.from({ length: 21 }, (_, i) => member(`a${i}`));
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: { members },
    });
    expect(result.success).toBe(false);
  });

  test("accepts references with autoSpinUp: true", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: { autoSpinUp: true },
    });
    expect(result.success).toBe(true);
  });

  test("rejects references with autoSpinUp: 'string'", () => {
    const result = createAgentConfigSchema.safeParse({
      ...base,
      references: { autoSpinUp: "yes" },
    });
    expect(result.success).toBe(false);
  });

  describe("teamToolScope", () => {
    test("accepts teamToolScope with allowed only", () => {
      const result = createAgentConfigSchema.safeParse({
        ...base,
        references: {
          members: [member("a1")],
          teamToolScope: { allowedTools: ["read_file", "grep"] },
        },
      });
      expect(result.success).toBe(true);
    });

    test("accepts teamToolScope with denied only", () => {
      const result = createAgentConfigSchema.safeParse({
        ...base,
        references: {
          members: [member("a1")],
          teamToolScope: { deniedTools: ["bash_execute"] },
        },
      });
      expect(result.success).toBe(true);
    });

    test("accepts teamToolScope with both allow and deny", () => {
      const result = createAgentConfigSchema.safeParse({
        ...base,
        references: {
          members: [member("a1")],
          teamToolScope: { allowedTools: ["read_file"], deniedTools: ["bash_execute"] },
        },
      });
      expect(result.success).toBe(true);
    });

    test("accepts empty teamToolScope object (unused)", () => {
      const result = createAgentConfigSchema.safeParse({
        ...base,
        references: { members: [member("a1")], teamToolScope: {} },
      });
      expect(result.success).toBe(true);
    });

    test("rejects teamToolScope.allowedTools with non-string entry", () => {
      const result = createAgentConfigSchema.safeParse({
        ...base,
        references: {
          members: [member("a1")],
          teamToolScope: { allowedTools: [42 as unknown as string] },
        },
      });
      expect(result.success).toBe(false);
    });

    test("accepts member override with deniedTools (symmetric with allowedTools)", () => {
      const result = createAgentConfigSchema.safeParse({
        ...base,
        references: {
          members: [member("a1", { overrides: { deniedTools: ["bash_execute"] } })],
        },
      });
      expect(result.success).toBe(true);
    });
  });
});
