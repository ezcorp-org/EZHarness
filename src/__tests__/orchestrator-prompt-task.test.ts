import { test, expect, describe } from "bun:test";
import {
  buildTaskTrackingInstructions,
  buildOrchestratorPrompt,
  buildTeamOrchestratorPrompt,
} from "../runtime/orchestrator-prompt";

// The 7 task tracking tools that must be mentioned in the instructions block.
const TASK_TOOL_NAMES = [
  "task_plan",
  "task_start",
  "task_complete",
  "task_fail",
  "task_list",
  "task_update",
  "task_subtask_toggle",
];

describe("buildTaskTrackingInstructions", () => {
  test("returns a non-empty string", () => {
    const out = buildTaskTrackingInstructions();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("contains '## Task Tracking' header", () => {
    const out = buildTaskTrackingInstructions();
    expect(out).toContain("## Task Tracking");
  });

  test("mentions all 7 task tool names", () => {
    const out = buildTaskTrackingInstructions();
    for (const name of TASK_TOOL_NAMES) {
      expect(out).toContain(name);
    }
  });

  test("contains execution flow steps 1-6", () => {
    const out = buildTaskTrackingInstructions();
    for (let i = 1; i <= 6; i++) {
      expect(out).toContain(`${i}.`);
    }
    // Sanity: the section is labelled "Execution flow"
    expect(out.toLowerCase()).toContain("execution flow");
  });

  test("mentions auto-advance behavior", () => {
    const out = buildTaskTrackingInstructions();
    expect(out.toLowerCase()).toContain("auto-advance");
  });

  test("explains when to plan vs when NOT to plan", () => {
    const out = buildTaskTrackingInstructions();
    // Defensive: the prompt must tell the agent both when to use it AND when to skip it
    expect(out).toContain("When to plan");
    expect(out).toContain("When NOT to plan");
  });
});

describe("buildOrchestratorPrompt includes task planning pattern", () => {
  const sampleAgents = [
    { id: "agent-1", name: "researcher", description: "Gathers information" },
    { id: "agent-2", name: "writer", description: "Drafts documents" },
  ];

  test("contains the '**Task planning**' pattern entry", () => {
    const out = buildOrchestratorPrompt(sampleAgents);
    expect(out).toContain("**Task planning**");
  });

  test("mentions task_plan, task_complete, and task_fail tools", () => {
    const out = buildOrchestratorPrompt(sampleAgents);
    expect(out).toContain("task_plan");
    expect(out).toContain("task_complete");
    expect(out).toContain("task_fail");
  });

  test("mentions agent attribution in the task panel", () => {
    // The orchestrator prompt should tell the LLM that when it delegates tasks
    // via invoke_agent, the panel shows which agent owns which task.
    const out = buildOrchestratorPrompt(sampleAgents);
    expect(out).toContain("task panel");
    // Should reference invoke_agent in the same breath as task delegation
    expect(out).toContain("invoke_agent");
  });

  test("still emits the Available Agents section (no regression)", () => {
    const out = buildOrchestratorPrompt(sampleAgents);
    expect(out).toContain("## Available Agents");
    for (const a of sampleAgents) {
      expect(out).toContain(a.name);
      expect(out).toContain(a.id);
      expect(out).toContain(a.description);
    }
  });
});

describe("buildTeamOrchestratorPrompt includes task planning pattern", () => {
  const teamName = "Build Team";
  const teamPrompt = "Coordinate members to ship a feature end-to-end.";
  const members = [
    { id: "m-1", name: "designer", description: "Designs UI" },
    { id: "m-2", name: "implementer", description: "Writes code" },
  ];

  test("contains the '**Task planning**' pattern entry", () => {
    const out = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(out).toContain("**Task planning**");
  });

  test("mentions task_plan and task_complete tools", () => {
    const out = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(out).toContain("task_plan");
    expect(out).toContain("task_complete");
  });

  test("includes the team name, prompt, and members (no regression)", () => {
    const out = buildTeamOrchestratorPrompt(teamName, teamPrompt, members);
    expect(out).toContain(teamName);
    expect(out).toContain(teamPrompt);
    for (const m of members) {
      expect(out).toContain(m.name);
      expect(out).toContain(m.id);
      expect(out).toContain(m.description);
    }
  });

  test("auto-spin-up results are included when provided and task pattern still present", () => {
    const spinResults = [
      { name: "designer", output: "Wireframes ready." },
      { name: "implementer", output: "Scaffolding complete." },
    ];
    const out = buildTeamOrchestratorPrompt(teamName, teamPrompt, members, spinResults);
    expect(out).toContain("Pre-computed Member Results");
    expect(out).toContain("Wireframes ready.");
    expect(out).toContain("Scaffolding complete.");
    // Task pattern must still be present — it's part of ORCHESTRATION_PATTERNS which is
    // appended after the spin-up block.
    expect(out).toContain("**Task planning**");
  });

  test("renders override tags (toolRestriction, model, permissionMode) when members have overrides", () => {
    // Exercises the tags branch in the member-rendering map callback.
    const membersWithOverrides = [
      {
        id: "m-ro",
        name: "read-only-researcher",
        description: "Researches",
        overrides: { toolRestriction: "read-only" as const },
      },
      {
        id: "m-full",
        name: "full-model-implementer",
        description: "Implements",
        overrides: {
          toolRestriction: "none" as const,
          model: "gpt-4o",
          permissionMode: "yolo" as const,
        },
      },
      {
        id: "m-all",
        name: "unrestricted",
        description: "No tags",
        overrides: { toolRestriction: "all" as const },
      },
    ];
    const out = buildTeamOrchestratorPrompt(teamName, teamPrompt, membersWithOverrides);
    // "read-only" tag rendered
    expect(out).toContain("read-only tools");
    // "none" tag rendered alongside model and permissionMode
    expect(out).toContain("none tools");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("yolo mode");
    // "all" toolRestriction is a no-op — no "all tools" tag
    expect(out).not.toContain("all tools");
    // Tags should appear as bracketed suffix on the member line
    expect(out).toMatch(/unrestricted.*\): No tags$/m);
  });
});
