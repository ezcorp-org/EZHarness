import { test, expect, describe } from "bun:test";
import { buildOrchestratorPrompt } from "../runtime/orchestrator-prompt";

describe("buildOrchestratorPrompt", () => {
  const singleAgent = [
    { name: "code-reviewer", id: "agent-1", description: "Reviews code for quality issues" },
  ];

  const multipleAgents = [
    { name: "code-reviewer", id: "agent-1", description: "Reviews code for quality issues" },
    { name: "planner", id: "agent-2", description: "Creates implementation plans" },
    { name: "researcher", id: "agent-3", description: "Researches technical topics" },
  ];

  test("returns string containing each agent's name and description", () => {
    const result = buildOrchestratorPrompt(multipleAgents);
    for (const agent of multipleAgents) {
      expect(result).toContain(agent.name);
      expect(result).toContain(agent.description);
    }
  });

  test("returns string containing each agent's id", () => {
    const result = buildOrchestratorPrompt(multipleAgents);
    for (const agent of multipleAgents) {
      expect(result).toContain(agent.id);
    }
  });

  test("includes instruction to use invoke_agent tool", () => {
    const result = buildOrchestratorPrompt(singleAgent);
    expect(result).toContain("invoke_agent");
  });

  test("includes instruction about parallel invocation", () => {
    const result = buildOrchestratorPrompt(singleAgent);
    expect(result.toLowerCase()).toContain("parallel");
  });

  test("includes instruction to synthesize results", () => {
    const result = buildOrchestratorPrompt(singleAgent);
    expect(result.toLowerCase()).toContain("synthesize");
  });

  test("handles single agent correctly", () => {
    const result = buildOrchestratorPrompt(singleAgent);
    expect(result).toContain("code-reviewer");
    expect(result).toContain("agent-1");
    expect(result).toContain("Reviews code for quality issues");
    // Should not contain entries for other agents
    expect(result).not.toContain("planner");
    expect(result).not.toContain("agent-2");
  });

  test("handles multiple agents with distinct entries", () => {
    const result = buildOrchestratorPrompt(multipleAgents);
    // Each agent should appear as a separate list entry
    const lines = result.split("\n");
    const agentLines = lines.filter((l) => l.startsWith("- **"));
    expect(agentLines.length).toBe(multipleAgents.length);
    // Verify each agent has its own entry with agentConfigId
    for (const agent of multipleAgents) {
      expect(result).toContain(`agentConfigId: "${agent.id}"`);
    }
  });
});

describe("buildTeamOrchestratorPrompt", () => {
  const { buildTeamOrchestratorPrompt } = require("../runtime/orchestrator-prompt");

  const teamName = "QA Squad";
  const teamPrompt = "Coordinate testing across all members. Run unit tests first, then integration.";
  const members = [
    { name: "unit-tester", id: "mem-1", description: "Runs unit tests" },
    { name: "integration-tester", id: "mem-2", description: "Runs integration tests" },
  ];

  test("output includes team name", () => {
    const result = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(result).toContain(teamName);
  });

  test("output includes the team prompt text (coordination instructions)", () => {
    const result = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(result).toContain(teamPrompt);
  });

  test("output lists member agents by name and ID", () => {
    const result = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    for (const member of members) {
      expect(result).toContain(member.name);
      expect(result).toContain(member.id);
    }
  });

  test("output includes Orchestration Patterns section", () => {
    const result = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(result).toContain("Orchestration Patterns");
  });

  test("output mentions scratchpad_write and ask_human", () => {
    const result = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(result).toContain("scratchpad_write");
    expect(result).toContain("ask_human");
  });

  test("includes override tags for members with toolRestriction", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", [
      { name: "Agent", id: "a1", description: "desc", overrides: { toolRestriction: "read-only" } },
    ]);
    expect(result).toContain("read-only");
  });

  test("includes model override tag", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", [
      { name: "Agent", id: "a1", description: "desc", overrides: { model: "gpt-4o" } },
    ]);
    expect(result).toContain("gpt-4o");
  });

  test("includes permission mode tag", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", [
      { name: "Agent", id: "a1", description: "desc", overrides: { permissionMode: "yolo" } },
    ]);
    expect(result).toContain("yolo");
  });

  test("no override tags when no overrides", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", [
      { name: "Agent", id: "a1", description: "desc" },
    ]);
    // The member line should not have bracket-enclosed tags
    const memberLine = result.split("\n").find((l: string) => l.includes("**Agent**"));
    expect(memberLine).toBeDefined();
    expect(memberLine).not.toContain("[");
    expect(memberLine).not.toContain("]");
  });

  test("includes auto-spin-up results section", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", members, [
      { name: "Agent A", output: "Result from A" },
      { name: "Agent B", output: "Result from B" },
    ]);
    expect(result).toContain("Pre-computed Member Results");
    expect(result).toContain("Agent A");
    expect(result).toContain("Result from A");
    expect(result).toContain("Agent B");
    expect(result).toContain("Result from B");
    expect(result).toContain("Do NOT call");
  });

  test("without auto-spin-up results omits section", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", members);
    expect(result).not.toContain("Pre-computed Member Results");
  });

  test("with empty auto-spin-up results omits section", () => {
    const result = buildTeamOrchestratorPrompt("Team", "Coordinate", members, []);
    expect(result).not.toContain("Pre-computed Member Results");
  });
});
