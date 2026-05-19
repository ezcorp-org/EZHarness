import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { resolveMentionedAgents } from "../runtime/mention-wiring";
import { createAgentConfig } from "../db/queries/agent-configs";

let codeReviewId: string;
let plannerId: string;

beforeAll(async () => {
  await setupTestDb();

  // Seed agent configs
  const cr = await createAgentConfig({
    name: "code-reviewer",
    description: "Reviews code for quality",
    prompt: "You review code.",
  });
  codeReviewId = cr.id;

  const pl = await createAgentConfig({
    name: "planner",
    description: "Creates implementation plans",
    prompt: "You plan implementations.",
  });
  plannerId = pl.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("resolveMentionedAgents", () => {
  test("returns empty array when no mentions", async () => {
    const result = await resolveMentionedAgents("Hello, no mentions here");
    expect(result).toEqual([]);
  });

  test("returns empty array for plain text with bareword @ but no structured mention", async () => {
    const result = await resolveMentionedAgents("email me @foo bar");
    expect(result).toEqual([]);
  });

  test("resolves single ![agent:…] mention to config with id, name, description", async () => {
    const result = await resolveMentionedAgents(
      "Please ![agent:code-reviewer] check this",
    );
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe(codeReviewId);
    expect(result[0]!.name).toBe("code-reviewer");
    expect(result[0]!.description).toBe("Reviews code for quality");
  });

  test("resolves multiple ![agent:…] mentions", async () => {
    const result = await resolveMentionedAgents(
      "![agent:code-reviewer] and ![agent:planner] please help",
    );
    expect(result.length).toBe(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain(codeReviewId);
    expect(ids).toContain(plannerId);
  });

  test("ignores ![ext:…] mentions (only resolves agent kind)", async () => {
    const result = await resolveMentionedAgents(
      "![ext:some-extension] do stuff ![agent:planner] plan this",
    );
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("planner");
  });

  test("ignores @[file:…] mentions (only resolves agent kind)", async () => {
    const result = await resolveMentionedAgents(
      "check @[file:src/app.ts] and ![agent:code-reviewer] help",
    );
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("code-reviewer");
  });

  test("skips unknown agent names without throwing", async () => {
    const result = await resolveMentionedAgents(
      "![agent:nonexistent-agent] and ![agent:code-reviewer] help",
    );
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("code-reviewer");
  });

  test("deduplicates if same agent mentioned twice", async () => {
    const result = await resolveMentionedAgents(
      "![agent:code-reviewer] first ![agent:code-reviewer] second",
    );
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe(codeReviewId);
  });
});

describe("resolveMentionedAgents — bareword fallback is REMOVED", () => {
  // The old bareword `@Name` fallback was removed when `@` became the file sigil.
  // These tests lock in the removal: no plain-text reference resolves to an agent.

  test("plain @name does NOT resolve to an agent (fallback removed)", async () => {
    const result = await resolveMentionedAgents("@code-reviewer please review this");
    expect(result).toEqual([]);
  });

  test("plain !name (bareword, no brackets) does NOT resolve to an agent", async () => {
    const result = await resolveMentionedAgents("!code-reviewer please review");
    expect(result).toEqual([]);
  });

  test("legacy @[agent:…] tokens do NOT resolve (need ! sigil now)", async () => {
    const result = await resolveMentionedAgents("@[agent:code-reviewer] help");
    expect(result).toEqual([]);
  });

  test("multiple bareword @names resolve to nothing", async () => {
    const result = await resolveMentionedAgents("@code-reviewer and @planner help me");
    expect(result).toEqual([]);
  });
});

describe("resolveMentionedTeams", () => {
  const { resolveMentionedTeams } = require("../runtime/mention-wiring");

  let teamId: string;
  let memberId: string;

  beforeAll(async () => {
    // Create a member agent
    const member = await createAgentConfig({
      name: "team-member-agent",
      description: "A team member for testing",
      prompt: "You are a team member.",
    });
    memberId = member.id;

    // Create a team-type agent config with references
    const team = await createAgentConfig({
      name: "TestTeam",
      description: "A test team",
      prompt: "Coordinate the team.",
      category: "team",
      references: { agents: [memberId], extensions: [] },
    });
    teamId = team.id;
  });

  test("resolves ![team:TeamName] to team config + member agents", async () => {
    const result = await resolveMentionedTeams("Please ![team:TestTeam] handle this");
    expect(result.length).toBe(1);
    expect(result[0].team.id).toBe(teamId);
    expect(result[0].team.name).toBe("TestTeam");
    expect(result[0].members.length).toBe(1);
    expect(result[0].members[0].id).toBe(memberId);
    expect(result[0].members[0].name).toBe("team-member-agent");
  });

  test("returns empty array for ![agent:Name] (not team mention)", async () => {
    const result = await resolveMentionedTeams("![agent:code-reviewer] help");
    expect(result).toEqual([]);
  });

  test("returns empty array for unknown team name", async () => {
    const result = await resolveMentionedTeams("![team:NonexistentTeam] help");
    expect(result).toEqual([]);
  });

  test("skips agent configs that don't have category team", async () => {
    // code-reviewer exists but is not a team
    const result = await resolveMentionedTeams("![team:code-reviewer] help");
    expect(result).toEqual([]);
  });

  test("skips members with non-existent agentConfigId", async () => {
    const existingMember = await createAgentConfig({
      name: "existing-team-member",
      description: "An existing member",
      prompt: "You exist.",
    });

    // Create a team referencing one valid agent and one non-existent agent
    const team = await createAgentConfig({
      name: "PartialTeam",
      description: "A team with a missing member",
      prompt: "Coordinate.",
      category: "team",
      references: {
        agents: [existingMember.id, "nonexistent-agent-id-12345"],
        extensions: [],
      },
    });

    const result = await resolveMentionedTeams("![team:PartialTeam] help");
    expect(result.length).toBe(1);
    expect(result[0].team.id).toBe(team.id);
    expect(result[0].team.name).toBe("PartialTeam");
    expect(result[0].members.length).toBe(1);
    expect(result[0].members[0].id).toBe(existingMember.id);
    expect(result[0].members[0].name).toBe("existing-team-member");
  });

  test("resolves team members from references.members (not just references.agents)", async () => {
    const refMember = await createAgentConfig({
      name: "ref-member-agent",
      description: "A member defined via references.members",
      prompt: "You are a ref member.",
    });

    const refTeam = await createAgentConfig({
      name: "RefMemberTeam",
      description: "A team using references.members",
      prompt: "Coordinate via members.",
      category: "team",
      references: {
        agents: [],
        extensions: [],
        members: [{ agentConfigId: refMember.id }],
      },
    });

    const result = await resolveMentionedTeams("![team:RefMemberTeam] handle this");
    expect(result.length).toBe(1);
    expect(result[0].team.id).toBe(refTeam.id);
    expect(result[0].team.name).toBe("RefMemberTeam");
    expect(result[0].members.length).toBe(1);
    expect(result[0].members[0].id).toBe(refMember.id);
    expect(result[0].members[0].name).toBe("ref-member-agent");
  });

  test("returns autoSpinUp flag from team config", async () => {
    const spinMember = await createAgentConfig({
      name: "spin-member-agent",
      description: "A member for auto-spin-up testing",
      prompt: "You are a spin member.",
    });

    await createAgentConfig({
      name: "AutoSpinTeam",
      description: "A team with autoSpinUp",
      prompt: "Auto spin up.",
      category: "team",
      references: {
        agents: [spinMember.id],
        extensions: [],
        autoSpinUp: true,
      },
    });

    const result = await resolveMentionedTeams("![team:AutoSpinTeam] handle this");
    expect(result.length).toBe(1);
    expect(result[0].team.autoSpinUp).toBe(true);
  });
});
